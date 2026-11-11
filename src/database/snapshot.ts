/**
 * A copy of the database that travels with the repository, so GitHub Actions can rebuild the shared web.
 *
 * The campus data (analysis, dates, tasks, course profiles) lives only in the student's SQLite file, and the
 * cloud starts with an empty one. If it exported docs/ from that, the published web would lose everything the
 * local machine knows. Instead the local machine publishes this snapshot together with docs/ and the cloud
 * restores it, adds the class it just recorded and exports again. The local database stays the master: the
 * cloud never uploads a snapshot.
 *
 * It leaves out what the web does not show or can be rebuilt: the student's marks, grade scores, settings,
 * note history, job queue and the embedding vectors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';

export const SNAPSHOT_RELATIVE = path.join('shared', 'snapshot.db.gz');

export function snapshotPath(dataDir: string): string {
  return path.join(dataDir, SNAPSHOT_RELATIVE);
}

/** Tables emptied in the copy: personal, private to the student, or rebuilt on demand. */
const EMPTIED_TABLES = ['grade_scores', 'markers', 'notes_versions', 'ai_jobs', 'settings', 'exam_attempts'];

function discard(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a leftover is removed by the next copy */
  }
}

/** Writes the snapshot of the open database. Returns its size in bytes. */
export function writeSharedSnapshot(live: Database.Database, file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpDb = `${file}.tmp.db`;
  discard(tmpDb);
  live.prepare('VACUUM INTO ?').run(tmpDb);

  const copy = new Database(tmpDb);
  try {
    for (const table of EMPTIED_TABLES) {
      try {
        copy.exec(`DELETE FROM ${table}`);
      } catch {
        /* the table may not exist in an older schema */
      }
    }
    try {
      copy.exec('UPDATE chunks SET embedding = NULL, embedding_model = NULL');
    } catch {
      /* no vectors to drop */
    }
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }

  const packed = gzipSync(fs.readFileSync(tmpDb), { level: 9 });
  const tmpGz = `${file}.tmp`;
  fs.writeFileSync(tmpGz, packed);
  fs.renameSync(tmpGz, file);
  discard(tmpDb);
  return packed.length;
}

/**
 * Restores the snapshot as the database when there is none yet (a fresh runner). Never overwrites an
 * existing database. Returns true when it restored one.
 */
export function restoreSharedSnapshot(file: string, databasePath: string): boolean {
  if (fs.existsSync(databasePath) || !fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.writeFileSync(databasePath, gunzipSync(fs.readFileSync(file)));
  return true;
}

// ── The cloud's own copy ────────────────────────────────────────────────────
// What the cloud generates (analysis, notes, cards of the classes it recorded) lives in a database that
// disappears with the runner. Without a copy, the next night's web would be rebuilt from the student's
// snapshot and lose those classes. The cloud keeps its own file, never the student's one: the master stays
// local. `cloud.base` holds the hash of the student's snapshot the copy was built on; if the student
// publishes a newer one, the cloud starts from that again and re-adds its classes from daily-state.json.

export const CLOUD_SNAPSHOT_RELATIVE = path.join('shared', 'cloud.db.gz');
export const CLOUD_BASE_RELATIVE = path.join('shared', 'cloud.base');

export function cloudSnapshotPath(dataDir: string): string {
  return path.join(dataDir, CLOUD_SNAPSHOT_RELATIVE);
}

export function cloudBasePath(dataDir: string): string {
  return path.join(dataDir, CLOUD_BASE_RELATIVE);
}

/** Hash of a file, or '' when it does not exist. */
export function fileHash(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Fresh runner: start from the cloud's own copy when it was built on the student's current snapshot,
 * otherwise from the student's snapshot. Returns which one was used (null: none, or a database exists).
 */
export function restoreForCloud(dataDir: string, databasePath: string): 'cloud' | 'local' | null {
  if (fs.existsSync(databasePath)) return null;
  const cloud = cloudSnapshotPath(dataDir);
  let base = '';
  try {
    base = fs.readFileSync(cloudBasePath(dataDir), 'utf8').trim();
  } catch {
    /* no base file: the copy cannot be trusted */
  }
  if (fs.existsSync(cloud) && base === fileHash(snapshotPath(dataDir))) {
    return restoreSharedSnapshot(cloud, databasePath) ? 'cloud' : null;
  }
  return restoreSharedSnapshot(snapshotPath(dataDir), databasePath) ? 'local' : null;
}

/** Writes the cloud's copy and the hash of the student's snapshot it stands on. Returns the files written. */
export function writeCloudSnapshot(live: Database.Database, dataDir: string): string[] {
  const file = cloudSnapshotPath(dataDir);
  writeSharedSnapshot(live, file);
  fs.writeFileSync(cloudBasePath(dataDir), fileHash(snapshotPath(dataDir)) + '\n');
  return [file, cloudBasePath(dataDir)];
}
