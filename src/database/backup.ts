/**
 * Copies of the SQLite database. The files under data/ are the source of truth, but what the student decided
 * lives only in the database (edited notes, confirmed dates, card progress, grade scores), so it needs copies:
 * - 'manual': the button in Ajustes;
 * - 'auto': one a day while the server runs, so a bad day costs at most a day;
 * - 'pre-migration': right before a schema change, the one moment the file itself can be damaged by us.
 * They go to BACKUP_DIR (outside data/ by default), and each kind is pruned on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export type BackupKind = 'manual' | 'auto' | 'pre-migration';

export interface BackupInfo {
  file: string;
  kind: BackupKind;
  bytes: number;
  modified: Date;
}

/** How many copies of each kind are kept */
export const BACKUP_KEEP: Record<BackupKind, number> = { manual: 10, auto: 7, 'pre-migration': 3 };

const PREFIX: Record<BackupKind, string> = { manual: 'lecturevault-', auto: 'auto-', 'pre-migration': 'pre-migracion-' };

/** A new automatic copy is due when the last one is older than this */
export const AUTO_BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;

/** Remove a leftover without ever failing (Windows keeps a file locked while a copy is still closing). */
function discard(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* the next copy removes it */ }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

/** Name of a copy: `auto-20261104-091500.db`, `pre-migracion-v9-a-v10-20261104-091500.db` */
export function backupFileName(kind: BackupKind, now: Date, detail = ''): string {
  return `${PREFIX[kind]}${detail ? `${detail}-` : ''}${stamp(now)}.db`;
}

function kindOf(file: string): BackupKind | null {
  if (!file.endsWith('.db')) return null;
  return (Object.keys(PREFIX) as BackupKind[]).find((kind) => file.startsWith(PREFIX[kind])) ?? null;
}

/** Copies in the folder, newest first. */
export function listBackups(dir: string): BackupInfo[] {
  if (!fs.existsSync(dir)) return [];
  const found: BackupInfo[] = [];
  for (const file of fs.readdirSync(dir)) {
    const kind = kindOf(file);
    if (!kind) continue;
    const stat = fs.statSync(path.join(dir, file));
    found.push({ file, kind, bytes: stat.size, modified: stat.mtime });
  }
  return found.sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.file.localeCompare(a.file));
}

/** Delete the oldest copies of one kind beyond what is kept. Returns how many went. */
export function pruneBackups(dir: string, kind: BackupKind, keep = BACKUP_KEEP[kind]): number {
  const old = listBackups(dir).filter((b) => b.kind === kind).slice(keep);
  for (const b of old) discard(path.join(dir, b.file));
  return old.length;
}

/** Is an automatic copy due? (none yet, or the last one is older than a day) */
export function autoBackupDue(dir: string, now = new Date()): boolean {
  const last = listBackups(dir).find((b) => b.kind === 'auto');
  return !last || now.getTime() - last.modified.getTime() >= AUTO_BACKUP_EVERY_MS;
}

/**
 * Write the copy under a temporary name and rename it when complete, so a copy cut halfway
 * (disk full, power loss) never looks like a good one.
 */
async function writeCopy(dir: string, kind: BackupKind, now: Date, detail: string, write: (partial: string) => void | Promise<unknown>): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName(kind, now, detail));
  const partial = `${file}.partial`;
  discard(partial);
  try {
    await write(partial);
    fs.renameSync(partial, file);
  } catch (err) {
    discard(partial);
    throw err;
  }
  pruneBackups(dir, kind);
  return file;
}

/** Consistent copy of a live database (safe while the server writes). */
export function backupDatabase(db: Database.Database, dir: string, kind: BackupKind, now = new Date(), detail = ''): Promise<string> {
  return writeCopy(dir, kind, now, detail, (partial) => db.backup(partial));
}

/**
 * Same, synchronously (VACUUM INTO): what runs at startup, before the first migration, when nothing else
 * uses the database yet.
 */
export function backupDatabaseSync(db: Database.Database, dir: string, kind: BackupKind, now = new Date(), detail = ''): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName(kind, now, detail));
  const partial = `${file}.partial`;
  discard(partial);
  try {
    db.prepare('VACUUM INTO ?').run(partial);
    fs.renameSync(partial, file);
  } catch (err) {
    discard(partial);
    throw err;
  }
  pruneBackups(dir, kind);
  return file;
}
