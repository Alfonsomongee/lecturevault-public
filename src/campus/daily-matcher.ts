/**
 * Pure matching logic to determine whether a recording listed in Blackboard Collaborate
 * has already been transcribed or ignored in the local SQLite database.
 *
 * Needed because classes captured manually or via the live "+" button carry `local:...` IDs
 * (e.g. `local:sesion03_01MUIN` or `local:Class_Collaborate_Sesi_n_4...`), whereas the
 * Collaborate table generates a hash `collabId`.
 */

import type { RecordingMetadata, RecordingRow } from '../types.js';
import { fold } from '../utils/text.js';
import { sanitizeRecordingId } from '../utils/ids.js';

/**
 * Extracts the session/class number from a Collaborate title or local transcript name.
 * Examples:
 * - "Sesión 4. Tema 2: Análisis..." -> 4
 * - "SESION 2: VC Tema 1..." -> 2
 * - "sesion03_01MUIN" -> 3
 * - "Class Collaborate Sesi n 01 Tutor a..." -> 1
 */
export function extractSessionNumber(text: string): number | null {
  if (!text) return null;
  const f = fold(text);
  const m = /(?:^|[^a-z])(?:sesion|sesi[\s_]+n|clase)[\s_.:#-]*0*(\d{1,2})(?:\b|_|[^0-9])/i.exec(f);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Extracts the recording part index when Collaborate appends `/recording_1`, `- recording_2`, etc.
 */
export function extractRecordingPart(text: string): number | null {
  if (!text) return null;
  const m = /recording[\s_-]*(\d+)/i.exec(text);
  if (!m || !m[1]) return null;
  return parseInt(m[1], 10);
}

/**
 * Normalizes a Collaborate title for fuzzy comparison by stripping boilerplate prefixes/suffixes.
 */
export function normalizeCollaborateTitle(text: string): string {
  const f = fold(text)
    .replace(/^class[\s_-]*collaborate[\s_:-]*/i, '')
    .replace(/[./\s_-]*recording[\s_-]*\d+\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return f;
}

/**
 * Finds an already-transcribed (or ignored) recording in `existingRecordings` that corresponds
 * to `candidate` within `course`.
 */
export function findExistingTranscribedMatch(
  candidate: RecordingMetadata,
  course: string,
  existingRecordings: RecordingRow[]
): RecordingRow | undefined {
  // 1. Direct collab_id match that is already processed, has a transcript, or was ignored
  const direct = existingRecordings.find(
    (r) =>
      r.collab_id === candidate.collabId &&
      (Boolean(r.transcript_id) || r.status === 'processed' || Boolean(r.ignored_at))
  );
  if (direct) return direct;

  // Scope remaining heuristics to processed/transcribed recordings of the same course
  const coursePool = existingRecordings.filter(
    (r) =>
      r.course === course &&
      (Boolean(r.transcript_id) || r.status === 'processed' || Boolean(r.ignored_at))
  );
  if (coursePool.length === 0) return undefined;

  const candNorm = normalizeCollaborateTitle(candidate.title);
  const candSanitized = sanitizeRecordingId(candNorm);
  const candPart = extractRecordingPart(candidate.title);
  const candSession = extractSessionNumber(candidate.title);
  const candDay = candidate.createdAt ? candidate.createdAt.slice(0, 10) : '';

  for (const row of coursePool) {
    const rowPart = extractRecordingPart(`${row.title} ${row.transcript_id ?? ''}`);
    // If both explicitly specify a recording part (e.g. recording_1 vs recording_2) and they differ, not a match
    if (candPart !== null && rowPart !== null && candPart !== rowPart) {
      continue;
    }

    // 2. Normalized title stem match (e.g. "Class Collaborate Sesi n 4 Tema 2..." vs "Sesión 4. Tema 2...")
    const rowNorm = normalizeCollaborateTitle(row.title);
    const rowSanitized = sanitizeRecordingId(rowNorm);
    if (candSanitized.length >= 16 && rowSanitized.length >= 16) {
      const prefixLen = Math.min(36, candSanitized.length, rowSanitized.length);
      if (candSanitized.slice(0, prefixLen) === rowSanitized.slice(0, prefixLen)) {
        return row;
      }
    }

    // 3. Same session number within the same course (and compatible duration if both known)
    // The session number comes from what the campus (or the student's file name) called the class. class_number
    // and the "Clase N." of display_title are chronological and shift whenever a class is added in between, so
    // they are only a last resort: using them first made an already transcribed class look new (and be recorded
    // again) the moment an earlier class appeared in the course.
    const rowSession =
      extractSessionNumber(row.title) ??
      extractSessionNumber(row.transcript_id ?? '') ??
      row.class_number ??
      extractSessionNumber(row.display_title ?? '');

    if (candSession !== null && rowSession !== null && candSession === rowSession) {
      const bothHaveDuration = candidate.durationSeconds > 60 && row.duration_seconds > 60;
      const durationDiff = Math.abs(candidate.durationSeconds - row.duration_seconds);
      if (!bothHaveDuration || durationDiff <= 1500) {
        return row;
      }
    }

    // 4. Same calendar day and very close duration (within 3 minutes)
    const rowDay = row.class_date || (row.created_at ? row.created_at.slice(0, 10) : '');
    if (
      candDay &&
      rowDay &&
      candDay === rowDay &&
      candidate.durationSeconds > 60 &&
      row.duration_seconds > 60 &&
      Math.abs(candidate.durationSeconds - row.duration_seconds) <= 180
    ) {
      return row;
    }
  }

  return undefined;
}
