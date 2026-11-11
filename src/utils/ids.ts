/**
 * Identifier helpers shared by capture, ingestion and the dashboard API.
 */

/**
 * Turns an arbitrary id/title into a safe single path segment
 * (no traversal, no separators). Used for audio/transcript file stems.
 */
export function sanitizeRecordingId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 80) || `recording-${Date.now()}`;
}

/** A transcript id coming from the network must match this to be used as a folder name. */
export function isSafeTranscriptId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

/**
 * A recording id that does not collide with a class already captured: the audio and the transcript are named
 * after it, so reusing one would overwrite them. "clase" → "clase", then "clase-2", "clase-3"...
 * `taken` says whether a candidate id is already in use.
 */
export function uniqueRecordingId(id: string, taken: (candidate: string) => boolean): string {
  const base = sanitizeRecordingId(id);
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 80 - String(n).length - 1)}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now()}`;
}
