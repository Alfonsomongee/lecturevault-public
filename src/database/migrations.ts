/**
 * LectureVault — SQLite schema migrations
 *
 * Versioned with `PRAGMA user_version`. Each migration runs once, inside its
 * own transaction, in order. Never edit a released migration: append a new one.
 *
 * Design rule: files under data/ (audio, whisper JSON) are the source of truth;
 * everything created here is either a rebuildable index (segments, FTS, chunks)
 * or user state (alert confirmations, flashcard reviews) that only lives in SQLite.
 */

import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'recordings table (Milestone 1)',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collab_id TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          playback_url TEXT NOT NULL DEFAULT '',
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'seen', 'processed'))
        );
        CREATE INDEX IF NOT EXISTS idx_recordings_collab_id ON recordings(collab_id);
        CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
        CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);
      `);
    },
  },
  {
    version: 2,
    description: 'study copilot: courses, segments + FTS5, notes, alerts, flashcards, glossary, chunks',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN course TEXT NOT NULL DEFAULT '';
        -- Folder name under data/transcripts (and audio file stem) for this recording
        ALTER TABLE recordings ADD COLUMN transcript_id TEXT;
        -- Fingerprint of the stored segments, so re-transcriptions are detected even when counts match
        ALTER TABLE recordings ADD COLUMN segments_hash TEXT;
        CREATE INDEX IF NOT EXISTS idx_recordings_course ON recordings(course);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_transcript ON recordings(transcript_id)
          WHERE transcript_id IS NOT NULL;

        CREATE TABLE segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          text TEXT NOT NULL,
          avg_logprob REAL,
          no_speech_prob REAL,
          UNIQUE(recording_id, idx)
        );
        CREATE INDEX idx_segments_recording ON segments(recording_id, start_ms);

        CREATE VIRTUAL TABLE segments_fts USING fts5(
          text,
          content='segments',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;

        -- Vocabulary of indexed words, used for typo-tolerant search (Whisper mis-hears jargon)
        CREATE VIRTUAL TABLE segments_vocab USING fts5vocab(segments_fts, 'row');

        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'clean',
          markdown TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          prompt_version TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(recording_id, kind)
        );

        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('exam','deadline','warning','formula','grading')),
          text TEXT NOT NULL,
          quote TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          due_date TEXT,
          date_text TEXT NOT NULL DEFAULT '',
          confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
          confirmed INTEGER NOT NULL DEFAULT 0,
          dismissed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_alerts_recording ON alerts(recording_id);
        CREATE INDEX idx_alerts_due ON alerts(due_date);

        CREATE TABLE flashcards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL DEFAULT 'basic' CHECK(kind IN ('basic','cloze')),
          front TEXT NOT NULL,
          back TEXT NOT NULL DEFAULT '',
          tag TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          guid TEXT NOT NULL UNIQUE,
          box INTEGER NOT NULL DEFAULT 0,
          reps INTEGER NOT NULL DEFAULT 0,
          due_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_flashcards_recording ON flashcards(recording_id);
        CREATE INDEX idx_flashcards_due ON flashcards(due_at);

        CREATE TABLE glossary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          definition TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          UNIQUE(recording_id, term)
        );

        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          source TEXT NOT NULL DEFAULT 'transcript' CHECK(source IN ('transcript','notes')),
          start_ms INTEGER NOT NULL DEFAULT 0,
          end_ms INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          embedding BLOB,
          embedding_model TEXT
        );
        CREATE INDEX idx_chunks_recording ON chunks(recording_id);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text,
          content='chunks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
      `);
    },
  },
  {
    version: 3,
    description: 'user state in SQLite: settings, note versions, markers, manual alerts/cards, archived cards',
    up: (db) => {
      db.exec(`
        -- Preferences and playback positions live here, not in the browser, so they survive any browser change
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Previous versions of the notes (kept when the user edits or the AI regenerates them)
        CREATE TABLE notes_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          markdown TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_notes_versions_recording ON notes_versions(recording_id, id);

        -- The student's own bookmarks on the audio timeline
        CREATE TABLE markers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          t_ms INTEGER NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_markers_recording ON markers(recording_id, t_ms);

        ALTER TABLE alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'ai';
        ALTER TABLE flashcards ADD COLUMN source TEXT NOT NULL DEFAULT 'ai';
        -- Deleting an AI card archives it, so regenerating never brings it back
        ALTER TABLE flashcards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 4,
    description: 'campus: course profiles, grading, deliverables, exams, events, mentions, note sections, proposals',
    up: (db) => {
      db.exec(`
        -- Campus metadata of a recording. Sync only ever writes "title" (the Collab2 name).
        ALTER TABLE recordings ADD COLUMN display_title TEXT;
        ALTER TABLE recordings ADD COLUMN title_source TEXT NOT NULL DEFAULT 'sync';
        ALTER TABLE recordings ADD COLUMN class_number INTEGER;
        -- Real class day (YYYY-MM-DD). NULL means only created_at is known, which is unconfirmed.
        ALTER TABLE recordings ADD COLUMN class_date TEXT;
        ALTER TABLE recordings ADD COLUMN session_kind TEXT;
        ALTER TABLE recordings ADD COLUMN topic TEXT NOT NULL DEFAULT '';
        ALTER TABLE recordings ADD COLUMN analysis_version TEXT NOT NULL DEFAULT '';

        -- Fixed course sheet. Once locked, AI changes arrive as proposals instead of edits.
        CREATE TABLE course_profiles (
          course TEXT PRIMARY KEY,
          overview_md TEXT NOT NULL DEFAULT '',
          teacher TEXT NOT NULL DEFAULT '',
          schedule TEXT NOT NULL DEFAULT '',
          syllabus_json TEXT NOT NULL DEFAULT '[]',
          pass_rules TEXT NOT NULL DEFAULT '',
          resources_json TEXT NOT NULL DEFAULT '[]',
          source_recording_id INTEGER REFERENCES recordings(id) ON DELETE SET NULL,
          locked INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- One row per real deliverable / exam, not per mention
        CREATE TABLE deliverables (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          key TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          format TEXT NOT NULL DEFAULT '',
          group_size TEXT NOT NULL DEFAULT '',
          weight_pct REAL,
          status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
          source TEXT NOT NULL DEFAULT 'ai',
          UNIQUE(course, key)
        );
        CREATE TABLE exams (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          key TEXT NOT NULL,
          title TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT '',
          weight_pct REAL,
          source TEXT NOT NULL DEFAULT 'ai',
          UNIQUE(course, key)
        );

        CREATE TABLE grading_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          name TEXT NOT NULL,
          weight_pct REAL,
          parent_id INTEGER REFERENCES grading_items(id) ON DELETE CASCADE,
          min_grade REAL,
          deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
          exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
          quote TEXT NOT NULL DEFAULT '',
          recording_id INTEGER REFERENCES recordings(id) ON DELETE SET NULL,
          t_ms INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'ai'
        );
        CREATE INDEX idx_grading_course ON grading_items(course);

        -- Unified calendar: what Home and every course page draw
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('exam','deadline','session','lab','other')),
          title TEXT NOT NULL,
          date TEXT,
          time TEXT,
          deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE CASCADE,
          exam_id INTEGER REFERENCES exams(id) ON DELETE CASCADE,
          recording_id INTEGER REFERENCES recordings(id) ON DELETE SET NULL,
          t_ms INTEGER NOT NULL DEFAULT 0,
          quote TEXT NOT NULL DEFAULT '',
          date_text TEXT NOT NULL DEFAULT '',
          confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
          confirmed INTEGER NOT NULL DEFAULT 0,
          dismissed INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'ai',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_events_date ON events(date);
        CREATE INDEX idx_events_course ON events(course, date);
        CREATE INDEX idx_events_recording ON events(recording_id);

        -- What was said about each entity in any class
        CREATE TABLE mentions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('deliverable','exam','course')),
          entity_id INTEGER NOT NULL,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('requirement','syllabus','format','date','tip','grading')),
          text TEXT NOT NULL,
          quote TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          confidence TEXT NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
          dismissed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_mentions_entity ON mentions(entity_type, entity_id);
        CREATE INDEX idx_mentions_recording ON mentions(recording_id);

        -- Notes split by destination (the full notes table stays as the "all together" view)
        CREATE TABLE note_sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          ord INTEGER NOT NULL,
          destination TEXT NOT NULL CHECK(destination IN ('theory','deliverable','exam','course_info','admin')),
          entity_id INTEGER,
          heading TEXT NOT NULL,
          markdown TEXT NOT NULL,
          start_ms INTEGER NOT NULL DEFAULT 0,
          end_ms INTEGER NOT NULL DEFAULT 0,
          UNIQUE(recording_id, ord)
        );

        -- AI key moments live next to the student's own bookmarks
        ALTER TABLE markers ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE markers ADD COLUMN why TEXT NOT NULL DEFAULT '';

        -- Review inbox: changes the AI is not allowed to apply on its own
        CREATE TABLE proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          target TEXT NOT NULL,
          current_value TEXT,
          proposed_value TEXT NOT NULL,
          recording_id INTEGER REFERENCES recordings(id) ON DELETE CASCADE,
          t_ms INTEGER NOT NULL DEFAULT 0,
          quote TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_proposals_status ON proposals(status, course);

        -- Dated exam/deadline alerts become calendar events, keeping the user's decisions.
        -- The alerts themselves stay: the current views still read them.
        INSERT INTO events (course, kind, title, date, recording_id, t_ms, quote, date_text,
                            confidence, confirmed, dismissed, source, created_at)
        SELECT r.course, a.kind, a.text, a.due_date, a.recording_id, a.t_ms, a.quote, a.date_text,
               a.confidence, a.confirmed, a.dismissed, a.source, a.created_at
        FROM alerts a JOIN recordings r ON r.id = a.recording_id
        WHERE a.kind IN ('exam','deadline') AND a.due_date IS NOT NULL
        ORDER BY a.id;
      `);

      // Collab2 recordings know the real class day; local imports only know the transcription day
      const rows = db
        .prepare("SELECT id, created_at FROM recordings WHERE collab_id NOT LIKE 'local:%'")
        .all() as { id: number; created_at: string }[];
      const setDate = db.prepare('UPDATE recordings SET class_date = ? WHERE id = ?');
      for (const row of rows) {
        const day = localDay(row.created_at);
        if (day) setDate.run(day, row.id);
      }
    },
  },
  {
    version: 5,
    description: 'tasks: what a class asks the student to do before the next one',
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          quote TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          done INTEGER NOT NULL DEFAULT 0,
          dismissed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_tasks_open ON tasks(done, dismissed, course);
        CREATE INDEX idx_tasks_recording ON tasks(recording_id);
      `);
    },
  },
  {
    version: 6,
    description: 'grade_scores: the student\'s scores per grading item, keyed by name so they outlive regeneration',
    up: (db) => {
      db.exec(`
        CREATE TABLE grade_scores (
          course TEXT NOT NULL,
          item_key TEXT NOT NULL,
          score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (course, item_key)
        );
      `);
    },
  },
  {
    version: 7,
    description: 'events.external_uid: events imported from the university calendar, by their uid there',
    up: (db) => {
      db.exec(`
        ALTER TABLE events ADD COLUMN external_uid TEXT;
        CREATE UNIQUE INDEX idx_events_external ON events(external_uid) WHERE external_uid IS NOT NULL;
      `);
    },
  },
  {
    version: 8,
    description: 'ai_jobs: the background queue for "Generar con IA"; recordings.ignored_at hides Collab2 classes not worth capturing',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN ignored_at TEXT;
        CREATE TABLE ai_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          force INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','cancelled')),
          report_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          finished_at TEXT
        );
        CREATE UNIQUE INDEX idx_ai_jobs_active ON ai_jobs(recording_id) WHERE status IN ('queued','running');
        CREATE INDEX idx_ai_jobs_status ON ai_jobs(status, id);
      `);
    },
  },
  {
    version: 9,
    description: 'ai_jobs.steps: a job that runs only some pipeline steps (regenerate notes); note_sections.gist: one sentence per range',
    up: (db) => {
      db.exec(`
        ALTER TABLE ai_jobs ADD COLUMN steps TEXT;
        ALTER TABLE note_sections ADD COLUMN gist TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 10,
    description: 'ai_jobs.attempts: how many times a job was taken, so one that keeps killing the server is not retried forever',
    up: (db) => {
      db.exec('ALTER TABLE ai_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;');
    },
  },
  {
    version: 11,
    description: 'note_sections.model: which model wrote each range (the DeepSeek fallback is weaker, so the UI can offer a rewrite)',
    up: (db) => {
      db.exec("ALTER TABLE note_sections ADD COLUMN model TEXT NOT NULL DEFAULT '';");
    },
  },
  {
    version: 12,
    description:
      'recordings: what the campus calls each class (official_title, session_number, session_part, official_topic) and who set class_date',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN official_title TEXT;
        ALTER TABLE recordings ADD COLUMN session_number INTEGER;
        ALTER TABLE recordings ADD COLUMN session_part INTEGER;
        ALTER TABLE recordings ADD COLUMN official_topic TEXT;
        ALTER TABLE recordings ADD COLUMN class_date_source TEXT;
      `);
    },
  },
  {
    version: 13,
    description: 'exam_questions (practice bank built from the transcripts), exam_attempts and recordings.exam_version',
    up: (db) => {
      db.exec(`
        ALTER TABLE recordings ADD COLUMN exam_version TEXT NOT NULL DEFAULT '';
        CREATE TABLE exam_questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('tf','mcq','short','essay')),
          question TEXT NOT NULL,
          options TEXT NOT NULL DEFAULT '[]',
          answer TEXT NOT NULL DEFAULT '',
          explanation TEXT NOT NULL DEFAULT '',
          rubric TEXT NOT NULL DEFAULT '[]',
          topic TEXT NOT NULL DEFAULT '',
          origin TEXT NOT NULL DEFAULT 'inferred' CHECK (origin IN ('explicit','inferred')),
          emphasis INTEGER NOT NULL DEFAULT 0,
          quote TEXT NOT NULL DEFAULT '',
          t_ms INTEGER NOT NULL DEFAULT 0,
          guid TEXT NOT NULL UNIQUE,
          dismissed INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_exam_questions_recording ON exam_questions(recording_id);
        CREATE TABLE exam_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          course TEXT NOT NULL,
          total INTEGER NOT NULL,
          correct REAL NOT NULL,
          items TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_exam_attempts_course ON exam_attempts(course);
      `);
    },
  },
];

/** YYYY-MM-DD of an instant in local time, or null when it is not a date. Kept local so v4 never changes. */
function localDay(value: string): string | null {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Apply all pending migrations. Returns the versions that were applied. */
export function runMigrations(db: Database.Database): number[] {
  const current = db.pragma('user_version', { simple: true }) as number;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    applied.push(migration.version);
  }

  return applied;
}
