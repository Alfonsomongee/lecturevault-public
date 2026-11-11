/**
 * Search index for the static (friends') web: the dashboard searches with SQLite FTS5, which a static host
 * does not have, so the browser searches this file instead (public/app/static-search.js).
 *
 * Compact on purpose. The old index repeated the title and course in each of ~26,000 transcript segments
 * (6.8 MB); here classes are listed once and consecutive segments are merged into windows of a few
 * sentences, which is also what a search result shows.
 */

import type Database from 'better-sqlite3';

export const SEARCH_INDEX_VERSION = 2;

/** [recording index, source (0 = notes, 1 = transcript), start ms, text] */
export type SearchDoc = [number, 0 | 1, number, string];

export interface StaticSearchIndex {
  v: number;
  /** [id, title, course] of each class */
  recs: [number, string, string][];
  docs: SearchDoc[];
  /** Most frequent transcript words, for "did you mean" when a word is not found */
  vocab: string[];
}

interface Segment {
  recording_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

/** Merges consecutive segments into windows of about `chars` characters (a new window after a long pause). */
export function mergeSegments(segments: Segment[], chars = 320, pauseMs = 20_000): { recording_id: number; start_ms: number; text: string }[] {
  const out: { recording_id: number; start_ms: number; text: string }[] = [];
  let cur: { recording_id: number; start_ms: number; text: string; end_ms: number } | null = null;
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const joinable = cur && cur.recording_id === s.recording_id && cur.text.length < chars && s.start_ms - cur.end_ms <= pauseMs;
    if (joinable) {
      cur!.text += ` ${text}`;
      cur!.end_ms = s.end_ms;
    } else {
      if (cur) out.push({ recording_id: cur.recording_id, start_ms: cur.start_ms, text: cur.text });
      cur = { recording_id: s.recording_id, start_ms: s.start_ms, end_ms: s.end_ms, text };
    }
  }
  if (cur) out.push({ recording_id: cur.recording_id, start_ms: cur.start_ms, text: cur.text });
  return out;
}

/** Builds the index of the given classes (only those: the web never lists a class it does not show). */
export function buildSearchIndex(db: Database.Database, recordingIds: number[]): StaticSearchIndex {
  const wanted = new Set(recordingIds);
  const rows = db
    .prepare('SELECT id, COALESCE(display_title, title) AS title, COALESCE(course, \'\') AS course FROM recordings ORDER BY id')
    .all() as { id: number; title: string; course: string }[];
  const recs: [number, string, string][] = rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, r.title, r.course]);
  const index = new Map(recs.map(([id], i) => [id, i]));

  const docs: SearchDoc[] = [];
  const notes = db
    .prepare("SELECT recording_id, start_ms, text FROM chunks WHERE source = 'notes' ORDER BY recording_id, start_ms, id")
    .all() as { recording_id: number; start_ms: number; text: string }[];
  for (const n of notes) {
    const i = index.get(n.recording_id);
    if (i !== undefined && n.text.trim()) docs.push([i, 0, n.start_ms, n.text.trim()]);
  }
  const segments = db
    .prepare('SELECT recording_id, start_ms, end_ms, text FROM segments ORDER BY recording_id, idx')
    .all() as Segment[];
  for (const w of mergeSegments(segments.filter((s) => wanted.has(s.recording_id)))) {
    docs.push([index.get(w.recording_id)!, 1, w.start_ms, w.text]);
  }

  let vocab: string[] = [];
  try {
    vocab = (
      db.prepare('SELECT term FROM segments_vocab WHERE length(term) >= 4 ORDER BY doc DESC LIMIT 4000').all() as { term: string }[]
    ).map((v) => v.term);
  } catch {
    /* no FTS vocabulary table: no suggestions */
  }
  return { v: SEARCH_INDEX_VERSION, recs, docs, vocab };
}
