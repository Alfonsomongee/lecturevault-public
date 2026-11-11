import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { LATEST_SCHEMA_VERSION } from '../../src/database/migrations.js';
import {
  AUTO_BACKUP_EVERY_MS, BACKUP_KEEP, autoBackupDue, backupDatabase, backupFileName, listBackups, pruneBackups,
} from '../../src/database/backup.js';

const logger = pino({ level: 'silent' });

describe('database backups', () => {
  let tmp: string;
  let dir: string;
  let db: DatabaseManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-backup-'));
    dir = path.join(tmp, 'copies');
    db = new DatabaseManager(path.join(tmp, 'live.db'), logger);
    db.createLocalRecording({ transcriptId: 'clase1', title: 'Clase 1', createdAt: '2026-10-01T10:00:00Z', durationSeconds: 60 });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies a live database consistently, with no half-written file left behind', async () => {
    const file = await backupDatabase(db.handle, dir, 'manual', new Date('2026-11-04T09:15:00Z'));
    expect(path.basename(file)).toBe('lecturevault-20261104-091500.db');
    expect(fs.readdirSync(dir)).toEqual(['lecturevault-20261104-091500.db']);

    const copy = new DatabaseManager(file, logger);
    expect(copy.getAllRecordings().map((r) => r.title)).toEqual(['Clase 1']);
    copy.close();
  });

  it('names each kind apart, so pruning one never touches another', async () => {
    expect(backupFileName('auto', new Date('2026-11-04T09:15:00Z'))).toBe('auto-20261104-091500.db');
    expect(backupFileName('pre-migration', new Date('2026-11-04T09:15:00Z'), 'v9-a-v10')).toBe('pre-migracion-v9-a-v10-20261104-091500.db');

    for (let i = 0; i < BACKUP_KEEP.auto + 3; i++) await backupDatabase(db.handle, dir, 'auto', new Date(Date.UTC(2026, 10, 1 + i)));
    await backupDatabase(db.handle, dir, 'manual', new Date('2026-11-04T09:15:00Z'));
    fs.writeFileSync(path.join(dir, 'notas-mias.txt'), 'x'); // not ours: never listed or deleted

    const files = listBackups(dir);
    expect(files.filter((b) => b.kind === 'auto')).toHaveLength(BACKUP_KEEP.auto);
    expect(files.filter((b) => b.kind === 'manual')).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'notas-mias.txt'))).toBe(true);
    expect(pruneBackups(dir, 'auto', 2)).toBe(BACKUP_KEEP.auto - 2);
  });

  it('says when the daily copy is due', async () => {
    expect(autoBackupDue(dir)).toBe(true); // no copy yet
    const file = await backupDatabase(db.handle, dir, 'auto');
    expect(autoBackupDue(dir)).toBe(false);
    expect(autoBackupDue(dir, new Date(Date.now() + AUTO_BACKUP_EVERY_MS + 60_000))).toBe(true);
    // a manual copy does not count as the daily one
    fs.rmSync(file);
    await backupDatabase(db.handle, dir, 'manual');
    expect(autoBackupDue(dir)).toBe(true);
  });

  it('cleans up and reports when the copy cannot be written', async () => {
    fs.writeFileSync(dir, 'esto es un archivo, no una carpeta');
    await expect(backupDatabase(db.handle, dir, 'manual')).rejects.toThrow();
    expect(fs.statSync(dir).isFile()).toBe(true);
  });
});

describe('the server and the daily copy', () => {
  let tmp: string;
  let db: DatabaseManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-daily-'));
    db = new DatabaseManager(path.join(tmp, 'live.db'), logger);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('takes one when it starts if none is due, and not twice in a day', async () => {
    const backupDir = path.join(tmp, 'safe');
    for (let run = 0; run < 2; run++) {
      const server = new DashboardServer(db, { port: 0, dataDir: tmp, backupDir, autoBackup: true }, logger);
      await server.start();
      await server.stop(); // waits for a copy in progress
    }
    expect(listBackups(backupDir).map((b) => b.kind)).toEqual(['auto']);
  });

  it('takes none unless asked to (tests and demos never write copies)', async () => {
    const backupDir = path.join(tmp, 'safe');
    const server = new DashboardServer(db, { port: 0, dataDir: tmp, backupDir }, logger);
    await server.start();
    await server.stop();
    expect(listBackups(backupDir)).toEqual([]);
  });
});

describe('copy before a migration', () => {
  let tmp: string;
  let dbPath: string;

  /** A database as an older version of the app left it: the latest schema, minus what versions 9 to 13 added */
  function oldDatabase(): void {
    new DatabaseManager(dbPath, logger).close();
    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE ai_jobs DROP COLUMN attempts; ALTER TABLE ai_jobs DROP COLUMN steps; ALTER TABLE note_sections DROP COLUMN gist; ALTER TABLE note_sections DROP COLUMN model;');
    raw.exec('DROP TABLE exam_attempts; DROP TABLE exam_questions;');
    for (const col of ['official_title', 'session_number', 'session_part', 'official_topic', 'class_date_source', 'exam_version']) {
      raw.exec(`ALTER TABLE recordings DROP COLUMN ${col};`);
    }
    raw.pragma('user_version = 8');
    raw.close();
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-premigrate-'));
    dbPath = path.join(tmp, 'live.db');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('copies an existing database before changing its schema, and the copy is the old one', () => {
    oldDatabase();
    const backupDir = path.join(tmp, 'safe');
    new DatabaseManager(dbPath, logger, { backupDir }).close();

    const [copy] = listBackups(backupDir);
    expect(copy!.kind).toBe('pre-migration');
    expect(copy!.file).toMatch(new RegExp(`^pre-migracion-v8-a-v${LATEST_SCHEMA_VERSION}-`));
    const old = new Database(path.join(backupDir, copy!.file), { readonly: true });
    expect(old.pragma('user_version', { simple: true })).toBe(8);
    old.close();

    const live = new Database(dbPath, { readonly: true });
    expect(live.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    live.close();
  });

  it('copies nothing for a new database, or one that is already up to date', () => {
    const backupDir = path.join(tmp, 'safe');
    new DatabaseManager(dbPath, logger, { backupDir }).close();
    new DatabaseManager(dbPath, logger, { backupDir }).close();
    expect(listBackups(backupDir)).toEqual([]);
  });

  it('does not migrate when the copy cannot be made, and says why', () => {
    oldDatabase();
    const notADir = path.join(tmp, 'file');
    fs.writeFileSync(notADir, 'x');
    expect(() => new DatabaseManager(dbPath, logger, { backupDir: notADir })).toThrow(/antes de actualizarla/);

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(8); // untouched
    raw.close();
  });
});
