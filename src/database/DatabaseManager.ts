import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { RecordingMetadata, RecordingRow, RecordingStatus } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations, LATEST_SCHEMA_VERSION } from './migrations.js';
import { backupDatabaseSync } from './backup.js';
import { localCalendarDate, toIso } from '../study/dates.js';
import { syncedFolderName } from './safety.js';

export interface DatabaseOptions {
  /** Where the copy taken before a schema change goes (BACKUP_DIR). Default: backups/ next to the database file. */
  backupDir?: string;
}

export class DatabaseManager {
  private db: Database.Database;
  private logger: Logger;

  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getAll: Database.Statement;
    getByStatus: Database.Statement;
    updateStatus: Database.Statement;
    countAll: Database.Statement;
    countByStatus: Database.Statement;
    getByRowId: Database.Statement;
    getByTranscriptId: Database.Statement;
    setCourse: Database.Statement;
    setTranscriptId: Database.Statement;
    insertLocal: Database.Statement;
  };

  /**
   * Initialize a new DatabaseManager
   * @param dbPath Path to the SQLite database file
   * @param logger Pino Logger instance
   * @param options Where the pre-migration copy goes
   */
  constructor(dbPath: string, logger: Logger, options: DatabaseOptions = {}) {
    this.logger = logger;
    
    // Create parent directories if they don't exist
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Sync tools rewrite files behind SQLite's back: on 2026-11-07 OneDrive brought back a copy from October
    const synced = syncedFolderName(path.resolve(dbPath));
    if (synced) {
      this.logger.warn(
        { dbPath, synced },
        `La base de datos está dentro de ${synced}: puede volver a una versión antigua sin avisar. ` +
          'Pon DATABASE_PATH fuera (por ejemplo en %LOCALAPPDATA%\\LectureVault\\lecturevault.db).'
      );
    }

    // Open/create the database
    this.db = new Database(dbPath);
    
    this.initialize(options.backupDir ?? path.join(dbDir, 'backups'));
    this.stmts = this.prepareStatements();
  }

  /**
   * Run migrations and set journal mode. An existing database that is about to change schema is copied
   * first; if the copy cannot be made the migration does not run (better stopped than unprotected).
   */
  private initialize(backupDir: string): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const before = this.db.pragma('user_version', { simple: true }) as number;
    if (before > 0 && before < LATEST_SCHEMA_VERSION) {
      try {
        const file = backupDatabaseSync(this.db, backupDir, 'pre-migration', new Date(), `v${before}-a-v${LATEST_SCHEMA_VERSION}`);
        this.logger.info({ file, from: before, to: LATEST_SCHEMA_VERSION }, 'Database copied before migrating');
      } catch (err) {
        this.db.close();
        throw new Error(`No se pudo copiar la base de datos antes de actualizarla (${(err as Error).message}). No se ha cambiado nada: libera espacio o revisa BACKUP_DIR e inténtalo de nuevo.`);
      }
    }

    const applied = runMigrations(this.db);
    this.logger.debug({ applied }, 'Database initialized with WAL mode and schema');
  }

  /** Raw better-sqlite3 handle, shared with the study repositories (same connection). */
  public get handle(): Database.Database {
    return this.db;
  }

  /**
   * Prepare statements for reuse
   */
  private prepareStatements() {
    return {
      // Sync owns only the Collab2 fields: display_title, class_number, etc. are campus/user state.
      // class_date is filled once from Collab2 and never replaced, so a user correction survives.
      upsert: this.db.prepare(`
        INSERT INTO recordings (collab_id, title, created_at, duration_seconds, playback_url, course, class_date, status, first_seen_at, last_seen_at)
        VALUES (@collab_id, @title, @created_at, @duration_seconds, @playback_url, @course, @class_date, 'new', datetime('now'), datetime('now'))
        ON CONFLICT(collab_id) DO UPDATE SET
          title = excluded.title,
          duration_seconds = excluded.duration_seconds,
          playback_url = excluded.playback_url,
          course = CASE WHEN excluded.course != '' THEN excluded.course ELSE recordings.course END,
          class_date = COALESCE(recordings.class_date, excluded.class_date),
          last_seen_at = datetime('now')
      `),
      getById: this.db.prepare('SELECT * FROM recordings WHERE collab_id = ?'),
      getAll: this.db.prepare('SELECT * FROM recordings ORDER BY COALESCE(class_date, substr(created_at, 1, 10)) DESC, COALESCE(session_number, 0) DESC, COALESCE(session_part, 0) DESC, created_at DESC, id DESC'),
      getByStatus: this.db.prepare('SELECT * FROM recordings WHERE status = ? ORDER BY COALESCE(class_date, substr(created_at, 1, 10)) DESC, COALESCE(session_number, 0) DESC, COALESCE(session_part, 0) DESC, created_at DESC, id DESC'),
      updateStatus: this.db.prepare('UPDATE recordings SET status = ? WHERE collab_id = ?'),
      countAll: this.db.prepare('SELECT count(*) as count FROM recordings'),
      countByStatus: this.db.prepare('SELECT count(*) as count FROM recordings WHERE status = ?'),
      getByRowId: this.db.prepare('SELECT * FROM recordings WHERE id = ?'),
      getByTranscriptId: this.db.prepare('SELECT * FROM recordings WHERE transcript_id = ?'),
      setCourse: this.db.prepare('UPDATE recordings SET course = ? WHERE id = ?'),
      setTranscriptId: this.db.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?'),
      insertLocal: this.db.prepare(`
        INSERT INTO recordings (collab_id, title, created_at, duration_seconds, playback_url, course, transcript_id, status)
        VALUES (@collab_id, @title, @created_at, @duration_seconds, '', @course, @transcript_id, 'processed')
      `),
    };
  }

  /**
   * Insert or update a recording
   * @param metadata The recording metadata to upsert
   * @returns Whether this was a new insertion
   */
  public upsertRecording(metadata: RecordingMetadata): { isNew: boolean } {
    const existing = this.getRecordingByCollabId(metadata.collabId);
    
    this.stmts.upsert.run({
      collab_id: metadata.collabId,
      title: metadata.title,
      created_at: metadata.createdAt,
      duration_seconds: metadata.durationSeconds,
      playback_url: metadata.playbackUrl,
      course: metadata.course ?? '',
      class_date: localDay(metadata.createdAt),
    });

    return { isNew: !existing };
  }

  /**
   * Batch upsert wrapped in a transaction
   * @param recordings Array of recording metadata to upsert
   * @returns Number of new and updated recordings
   */
  public upsertMany(recordings: RecordingMetadata[]): { newCount: number; updatedCount: number } {
    let newCount = 0;
    let updatedCount = 0;

    const transaction = this.db.transaction((recs: RecordingMetadata[]) => {
      for (const rec of recs) {
        const { isNew } = this.upsertRecording(rec);
        if (isNew) {
          newCount++;
        } else {
          updatedCount++;
        }
      }
    });

    transaction(recordings);

    return { newCount, updatedCount };
  }

  /**
   * Get all recordings ordered by created_at DESC
   */
  public getAllRecordings(): RecordingRow[] {
    return this.stmts.getAll.all() as RecordingRow[];
  }

  /**
   * Filter recordings by status
   */
  public getRecordingsByStatus(status: RecordingStatus): RecordingRow[] {
    return this.stmts.getByStatus.all(status) as RecordingRow[];
  }

  /**
   * Find single recording by collab_id
   */
  public getRecordingByCollabId(collabId: string): RecordingRow | undefined {
    return this.stmts.getById.get(collabId) as RecordingRow | undefined;
  }

  /**
   * Update recording status
   */
  public updateStatus(collabId: string, status: RecordingStatus): void {
    this.stmts.updateStatus.run(status, collabId);
  }

  /** Find a recording by its numeric primary key */
  public getRecordingById(id: number): RecordingRow | undefined {
    return this.stmts.getByRowId.get(id) as RecordingRow | undefined;
  }

  /** Find the recording linked to a transcript folder / audio stem */
  public getRecordingByTranscriptId(transcriptId: string): RecordingRow | undefined {
    return this.stmts.getByTranscriptId.get(transcriptId) as RecordingRow | undefined;
  }

  /** Assign a recording to a course / subject */
  public setCourse(id: number, course: string): void {
    this.stmts.setCourse.run(course.trim(), id);
  }

  /** Collab2 classes still to capture: no transcript yet, not local, not ignored by the student. */
  public getPendingCaptures(): RecordingRow[] {
    return this.getAllRecordings().filter((r) => !r.transcript_id && !r.collab_id.startsWith('local:') && !r.ignored_at);
  }

  /** Hide a Collab2 class from the pending list (and from batch capture), or bring it back. */
  public setIgnored(id: number, ignored: boolean): boolean {
    return this.db.prepare(`UPDATE recordings SET ignored_at = ${ignored ? "COALESCE(ignored_at, datetime('now'))" : 'NULL'} WHERE id = ?`).run(id).changes > 0;
  }

  /** Link a recording to its local transcript folder */
  public setTranscriptId(id: number, transcriptId: string): void {
    this.stmts.setTranscriptId.run(transcriptId, id);
  }

  public setTitle(id: number, title: string): void {
    this.db.prepare('UPDATE recordings SET title = ? WHERE id = ?').run(title, id);
  }

  /** Remove a recording and everything derived from it (cascade). */
  public deleteRecording(id: number): void {
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  }

  /**
   * Forget the local capture of a Collab2 recording but keep the row (so the next sync does not
   * re-add it as a stranger): derived data is deleted and the status returns to "new".
   */
  public resetLocalData(id: number): void {
    const run = this.db.transaction(() => {
      for (const table of ['segments', 'notes', 'notes_versions', 'alerts', 'flashcards', 'glossary', 'chunks', 'markers']) {
        this.db.prepare(`DELETE FROM ${table} WHERE recording_id = ?`).run(id);
      }
      this.db.prepare("UPDATE recordings SET transcript_id = NULL, segments_hash = NULL, status = 'new' WHERE id = ?").run(id);
    });
    run();
  }

  /** Correct the class date (local captures only know when they were transcribed); a corrected date is confirmed */
  public setCreatedAt(id: number, createdAt: string, source: 'user' | null = null): void {
    this.db
      .prepare('UPDATE recordings SET created_at = ?, class_date = ?, class_date_source = COALESCE(?, class_date_source) WHERE id = ?')
      .run(createdAt, localDay(createdAt), source, id);
  }

  public setSegmentsHash(id: number, hash: string): void {
    this.db.prepare('UPDATE recordings SET segments_hash = ? WHERE id = ?').run(hash, id);
  }

  /**
   * Link a recording to a transcript folder. If a placeholder "local:" recording already owns the
   * folder (e.g. the dashboard imported it first), it is folded into this one instead of colliding.
   */
  public linkTranscript(recordingId: number, transcriptId: string): void {
    const run = this.db.transaction(() => {
      const owner = this.getRecordingByTranscriptId(transcriptId);
      if (owner && owner.id !== recordingId) {
        if (!owner.collab_id.startsWith('local:')) {
          throw new Error(`La carpeta "${transcriptId}" ya pertenece a otra grabación de Collab2.`);
        }
        this.db.prepare('DELETE FROM recordings WHERE id = ?').run(owner.id); // cascades derived data
      }
      this.stmts.setTranscriptId.run(transcriptId, recordingId);
    });
    run();
  }

  /**
   * Create a recording that exists only locally (captured manually, not listed in Collab2).
   * Its collab_id is namespaced with "local:" so it can never collide with a Collab2 id.
   */
  public createLocalRecording(input: {
    transcriptId: string;
    title: string;
    createdAt: string;
    durationSeconds: number;
    course?: string;
  }): RecordingRow {
    const info = this.stmts.insertLocal.run({
      collab_id: `local:${input.transcriptId}`,
      title: input.title,
      created_at: input.createdAt,
      duration_seconds: Math.round(input.durationSeconds),
      course: input.course ?? '',
      transcript_id: input.transcriptId,
    });
    return this.getRecordingById(Number(info.lastInsertRowid))!;
  }

  /** Distinct courses with how many recordings each one has */
  public getCourses(): { course: string; count: number; totalSeconds: number }[] {
    return this.db
      .prepare(
        `SELECT course, count(*) AS count, COALESCE(sum(duration_seconds), 0) AS totalSeconds
         FROM recordings GROUP BY course ORDER BY course COLLATE NOCASE`
      )
      .all() as { course: string; count: number; totalSeconds: number }[];
  }

  /**
   * Return counts of recordings by status
   */
  public getStats(): { total: number; new: number; seen: number; processed: number } {
    const total = (this.stmts.countAll.get() as { count: number }).count;
    const newCount = (this.stmts.countByStatus.get('new') as { count: number }).count;
    const seenCount = (this.stmts.countByStatus.get('seen') as { count: number }).count;
    const processedCount = (this.stmts.countByStatus.get('processed') as { count: number }).count;

    return {
      total,
      new: newCount,
      seen: seenCount,
      processed: processedCount
    };
  }

  /**
   * Close the database connection
   */
  public close(): void {
    this.db.close();
  }
}

/** Local calendar day (YYYY-MM-DD) of an ISO instant, or null when it is not a valid date. */
function localDay(value: string): string | null {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : toIso(localCalendarDate(dt));
}
