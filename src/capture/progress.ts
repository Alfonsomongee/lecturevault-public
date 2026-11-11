/**
 * Progress lines that a capture process prints for the dashboard to read (not for people).
 *
 * The dashboard starts `batch-transcribe` as a child process and follows it through these lines, one JSON
 * object after a fixed prefix, so it never has to parse the human text. They are printed only when
 * LECTUREVAULT_PROGRESS=1, which the dashboard sets; run by hand, nothing changes.
 */

export const PROGRESS_PREFIX = '@@LV@@ ';

/**
 * Where one class is in the capture → transcription → study flow, in order.
 * 'waiting' only exists in a live capture (the "+" button): the campus is open and the student has to
 * get the class playing and say so.
 */
export const CAPTURE_STAGES = ['opening', 'waiting', 'recording', 'converting', 'transcribing', 'studying', 'done', 'failed'] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];

/** The id a live capture reports under: the class has no row in the database until it is transcribed. */
export const LIVE_CAPTURE_ID = 0;

export type ProgressEvent =
  | { type: 'stage'; id: number; stage: CaptureStage; error?: string }
  | { type: 'progress'; id: number; percent: number; position: number; duration: number };

export function progressLine(event: ProgressEvent): string {
  return `${PROGRESS_PREFIX}${JSON.stringify(event)}`;
}

/** Print an event, when the dashboard asked for them. The leading newline ends a half-drawn progress bar. */
export function emitProgress(event: ProgressEvent): void {
  if (process.env['LECTUREVAULT_PROGRESS'] !== '1') return;
  process.stdout.write(`\n${progressLine(event)}\n`);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The event in a line of output, or null when it is not one (or is malformed: output is not trusted). */
export function parseProgressLine(line: string): ProgressEvent | null {
  const at = line.indexOf(PROGRESS_PREFIX);
  if (at < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(at + PROGRESS_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!Number.isInteger(e['id'])) return null;
  const id = e['id'] as number;
  if (e['type'] === 'stage' && (CAPTURE_STAGES as readonly unknown[]).includes(e['stage'])) {
    return {
      type: 'stage', id, stage: e['stage'] as CaptureStage,
      ...(typeof e['error'] === 'string' ? { error: e['error'].slice(0, 500) } : {}),
    };
  }
  if (e['type'] === 'progress' && finite(e['percent']) && finite(e['position']) && finite(e['duration'])) {
    return { type: 'progress', id, percent: Math.min(100, Math.max(0, e['percent'])), position: Math.max(0, e['position']), duration: Math.max(0, e['duration']) };
  }
  return null;
}
