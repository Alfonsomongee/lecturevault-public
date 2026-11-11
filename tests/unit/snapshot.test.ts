import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { restoreForCloud, restoreSharedSnapshot, snapshotPath, writeCloudSnapshot, writeSharedSnapshot } from '../../src/database/snapshot.js';

function makeDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE recordings (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, text TEXT, embedding BLOB, embedding_model TEXT);
    CREATE TABLE markers (id INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE grade_scores (course TEXT, item_key TEXT, score REAL);
    CREATE TABLE settings (key TEXT, value TEXT);
    INSERT INTO recordings VALUES (1, 'Clase 5');
    INSERT INTO chunks VALUES (1, 'apuntes', x'0102', 'm');
    INSERT INTO markers VALUES (1, 'mi marca');
    INSERT INTO grade_scores VALUES ('04MUIN', 'examen', 7.5);
    INSERT INTO settings VALUES ('pos:1', '12');
  `);
  return db;
}

describe('shared database snapshot', () => {
  it('keeps what the web shows and drops what is personal or rebuildable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-snap-'));
    try {
      const live = makeDb(path.join(dir, 'live.db'));
      const file = snapshotPath(dir);
      expect(writeSharedSnapshot(live, file)).toBeGreaterThan(0);
      live.close();

      const target = path.join(dir, 'restored.db');
      expect(restoreSharedSnapshot(file, target)).toBe(true);
      const copy = new Database(target, { readonly: true });
      expect(copy.prepare('SELECT title FROM recordings').all()).toEqual([{ title: 'Clase 5' }]);
      expect(copy.prepare('SELECT text, embedding FROM chunks').all()).toEqual([{ text: 'apuntes', embedding: null }]);
      for (const table of ['markers', 'grade_scores', 'settings']) {
        expect((copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
      copy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing database and does nothing without a snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-snap-'));
    try {
      const existing = path.join(dir, 'mine.db');
      fs.writeFileSync(existing, 'student data');
      const live = makeDb(path.join(dir, 'live.db'));
      writeSharedSnapshot(live, snapshotPath(dir));
      live.close();
      expect(restoreSharedSnapshot(snapshotPath(dir), existing)).toBe(false);
      expect(fs.readFileSync(existing, 'utf8')).toBe('student data');
      expect(restoreSharedSnapshot(path.join(dir, 'missing.gz'), path.join(dir, 'new.db'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the cloud's own copy of the database", () => {
  const titles = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return (db.prepare('SELECT title FROM recordings ORDER BY id').all() as { title: string }[]).map((r) => r.title);
    } finally {
      db.close();
    }
  };

  it('is used while the student snapshot it was built on is unchanged, and dropped when a new one is published', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-cloud-'));
    try {
      const local = makeDb(path.join(dir, 'local.db'));
      writeSharedSnapshot(local, snapshotPath(dir));

      // the cloud adds a class and keeps its copy
      const cloud = makeDb(path.join(dir, 'cloud.db'));
      cloud.exec("INSERT INTO recordings VALUES (2, 'Clase 6 (nube)')");
      const written = writeCloudSnapshot(cloud, dir);
      expect(written).toHaveLength(2);
      cloud.close();

      // next night: same student snapshot → the cloud copy
      const next = path.join(dir, 'night1.db');
      expect(restoreForCloud(dir, next)).toBe('cloud');
      expect(titles(next)).toEqual(['Clase 5', 'Clase 6 (nube)']);

      // the student publishes a newer snapshot → start from theirs
      local.exec("UPDATE recordings SET title = 'Clase 5 corregida'");
      writeSharedSnapshot(local, snapshotPath(dir));
      local.close();
      const later = path.join(dir, 'night2.db');
      expect(restoreForCloud(dir, later)).toBe('local');
      expect(titles(later)).toEqual(['Clase 5 corregida']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing database and restores nothing when there is no snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-cloud-'));
    try {
      expect(restoreForCloud(dir, path.join(dir, 'x.db'))).toBeNull();
      fs.writeFileSync(path.join(dir, 'there.db'), 'x');
      expect(restoreForCloud(dir, path.join(dir, 'there.db'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
