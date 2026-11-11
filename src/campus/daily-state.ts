/**
 * Git-tracked memory of which Collaborate recordings the daily agent has already handled.
 *
 * The SQLite database is not in git, so a GitHub Actions run starts without it and could not tell that
 * a class was already transcribed (and would record it again). This small JSON file travels with the
 * repository instead: the agent reads it next to the local database and appends to it after each class.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RecordingRow } from '../types.js';

export interface DailyStateEntry {
  collabId: string;
  /** Catalog label, e.g. "04MUIN Tecnología electrónica e instrumentación" */
  course: string;
  title: string;
  /** ISO date-time of the class as listed by Collaborate */
  createdAt: string;
  durationSeconds: number;
  /** Folder name under data/transcripts, when the class was transcribed */
  transcriptId: string | null;
  /** ISO time the agent handled it */
  handledAt: string;
  /** How the campus lists the class (title, date and length), when the agent saw it there */
  official?: OfficialListing;
}

export interface OfficialListing {
  title: string;
  createdAt: string;
  durationSeconds: number;
}

export interface DailyState {
  version: 1;
  entries: DailyStateEntry[];
}

export const DAILY_STATE_FILE = 'daily-state.json';

/**
 * When the class happened. Local captures carry the day they were transcribed as `created_at`, so the
 * confirmed class date wins when there is one.
 */
export function classMoment(row: Pick<RecordingRow, 'class_date' | 'created_at'>): string {
  return row.class_date ? `${row.class_date}T12:00:00.000Z` : row.created_at;
}

export function dailyStatePath(dataDir: string): string {
  return path.join(dataDir, DAILY_STATE_FILE);
}

export function emptyDailyState(): DailyState {
  return { version: 1, entries: [] };
}

/** Reads the file; a missing or damaged one is an empty state (the agent then relies on the database). */
export function loadDailyState(dataDir: string): DailyState {
  try {
    const raw = JSON.parse(fs.readFileSync(dailyStatePath(dataDir), 'utf8')) as Partial<DailyState>;
    if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
      return { version: 1, entries: raw.entries.filter(isEntry) };
    }
  } catch {
    /* fall through */
  }
  return emptyDailyState();
}

function isEntry(value: unknown): value is DailyStateEntry {
  const e = value as DailyStateEntry;
  return Boolean(e) && typeof e.collabId === 'string' && typeof e.course === 'string' && typeof e.title === 'string';
}

export function saveDailyState(dataDir: string, state: DailyState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const sorted = [...state.entries].sort(
    (a, b) => a.course.localeCompare(b.course) || a.createdAt.localeCompare(b.createdAt) || a.collabId.localeCompare(b.collabId)
  );
  const file = dailyStatePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Adds or replaces (by collabId) an entry. Pure: returns a new state. */
export function withEntry(state: DailyState, entry: DailyStateEntry): DailyState {
  return { version: 1, entries: [...state.entries.filter((e) => e.collabId !== entry.collabId), entry] };
}

/**
 * Remembers how the campus lists a class that was matched to `row` (a database row or a state row), so the
 * student's machine can take the official date, session and topic from it (see official-sessions.ts).
 * Pure: returns the new state and whether anything changed (an unchanged listing means no commit).
 */
export function withOfficial(
  state: DailyState,
  row: Pick<RecordingRow, 'collab_id' | 'transcript_id' | 'course' | 'title' | 'created_at' | 'duration_seconds'>,
  listing: { title: string; createdAt: string; durationSeconds: number },
  now = new Date().toISOString()
): { state: DailyState; changed: boolean } {
  if (!row.course || !row.transcript_id) return { state, changed: false };
  const official: OfficialListing = { title: listing.title, createdAt: listing.createdAt, durationSeconds: listing.durationSeconds };
  const index = state.entries.findIndex(
    (e) => e.collabId === row.collab_id || (Boolean(e.transcriptId) && e.transcriptId === row.transcript_id)
  );
  if (index >= 0) {
    const known = state.entries[index]!;
    const same =
      known.official?.title === official.title &&
      known.official?.createdAt === official.createdAt &&
      known.official?.durationSeconds === official.durationSeconds;
    if (same) return { state, changed: false };
    const entries = [...state.entries];
    entries[index] = { ...known, official };
    return { state: { version: 1, entries }, changed: true };
  }
  return {
    state: withEntry(state, {
      collabId: row.collab_id,
      course: row.course,
      title: row.title,
      createdAt: row.created_at,
      durationSeconds: row.duration_seconds,
      transcriptId: row.transcript_id,
      handledAt: now,
      official,
    }),
    changed: true,
  };
}

/**
 * Turns the entries into the row shape `findExistingTranscribedMatch` understands, so the same matching
 * rules (id, title, session number, day + duration) apply whether the memory is the database or this file.
 */
export function rowsFromState(state: DailyState): RecordingRow[] {
  return state.entries.map((e, i) => ({
    id: -(i + 1),
    collab_id: e.collabId,
    title: e.title,
    created_at: e.createdAt,
    duration_seconds: e.durationSeconds,
    playback_url: '',
    first_seen_at: e.handledAt,
    last_seen_at: e.handledAt,
    status: 'processed',
    course: e.course,
    transcript_id: e.transcriptId ?? e.collabId,
    segments_hash: '',
    display_title: null,
    title_source: 'ai',
    class_number: null,
    class_date: e.createdAt ? e.createdAt.slice(0, 10) : null,
    session_kind: null,
    topic: '',
    analysis_version: '',
    ignored_at: null,
  })) as RecordingRow[];
}

/**
 * Database rows plus state rows, without repeating the same class twice.
 * The database wins because it knows more (class number, display title).
 */
export function mergeKnownRows(dbRows: RecordingRow[], state: DailyState): RecordingRow[] {
  const seen = new Set(dbRows.map((r) => r.collab_id));
  return [...dbRows, ...rowsFromState(state).filter((r) => !seen.has(r.collab_id))];
}

/**
 * Seeds the state from rows the local database already considers done (transcribed or ignored), so the
 * first run in the cloud knows about every class recorded before the file existed.
 */
export function seedFromRows(state: DailyState, rows: RecordingRow[], now = new Date().toISOString()): DailyState {
  let next = state;
  for (const r of rows) {
    if (!r.course || !(r.transcript_id || r.ignored_at)) continue;
    if (next.entries.some((e) => e.collabId === r.collab_id)) continue;
    next = withEntry(next, {
      collabId: r.collab_id,
      course: r.course,
      title: r.title,
      createdAt: classMoment(r),
      durationSeconds: r.duration_seconds,
      transcriptId: r.transcript_id,
      handledAt: now,
    });
  }
  return next;
}

/**
 * Remembers a class the moment it is transcribed, whoever recorded it (the daily agent, the "+" button,
 * the panel or `batch:transcribe`). Without a subject nothing is stored: matching is per subject.
 * Returns true when the file changed.
 */
export function recordHandledRow(dataDir: string, row: RecordingRow, now = new Date().toISOString()): boolean {
  if (!row.course || !(row.transcript_id || row.ignored_at)) return false;
  const state = loadDailyState(dataDir);
  const known = state.entries.find((e) => e.collabId === row.collab_id);
  if (known && known.transcriptId === row.transcript_id && known.course === row.course) return false;
  saveDailyState(
    dataDir,
    withEntry(state, {
      collabId: row.collab_id,
      course: row.course,
      title: row.title,
      createdAt: classMoment(row),
      durationSeconds: row.duration_seconds,
      transcriptId: row.transcript_id,
      handledAt: now,
    })
  );
  return true;
}
