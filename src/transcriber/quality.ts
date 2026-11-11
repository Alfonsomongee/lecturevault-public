/**
 * Is a Whisper transcript usable? (pure, no I/O except `assertTranscriptUsable`)
 *
 * Whisper can fall into a loop: once it repeats a phrase it keeps repeating it for the rest of the
 * audio ("Derecho de los Trabajadores," 90 times) while the real speech is lost. The result looks like a
 * transcript, so notes built on it come out tiny and wrong. Healthy classes have < 2 % of their audio in
 * a loop and 650+ characters per minute; a broken one has most of it in a loop and well under 300.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface QualitySegment {
  start: number;
  end: number;
  text: string;
  /** Whisper's own confidence for the segment (log-probability) */
  avg_logprob?: number;
}

export interface TranscriptQuality {
  suspect: boolean;
  /** Share of the audio covered by looping segments, 0..1 */
  loopedShare: number;
  charsPerMinute: number;
  /** Second where the first loop starts (null when there is none) */
  firstLoopAt: number | null;
  /** Spanish sentences saying why it is suspect (empty when it is fine) */
  reasons: string[];
}

/** From this share of looping audio the transcript is not trusted */
export const MAX_LOOPED_SHARE = 0.2;
/** Below this many characters per minute a long recording has lost most of its speech */
export const MIN_CHARS_PER_MINUTE = 300;
/** Healthy classes average -0.16..-0.34; a garbled recording (4x capture) averages -1.45 */
export const MIN_AVG_LOGPROB = -0.8;
/** Shorter recordings are not judged: too little text to measure */
const MIN_JUDGED_SECONDS = 300;
/** A segment equal to one of the last N is a repetition */
const LOOKBACK = 6;

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function assessTranscript(segments: QualitySegment[], audioSeconds: number): TranscriptQuality {
  const total = audioSeconds > 0 ? audioSeconds : (segments[segments.length - 1]?.end ?? 0);
  const recent: string[] = [];
  let looped = 0;
  let firstLoopAt: number | null = null;
  let chars = 0;
  let logprobSum = 0;
  let logprobCount = 0;

  for (const seg of segments) {
    const norm = normalize(seg.text);
    const words = norm.split(' ').filter(Boolean);
    chars += seg.text.length;
    if (typeof seg.avg_logprob === 'number') { logprobSum += seg.avg_logprob; logprobCount++; }
    const repeated = norm !== '' && recent.includes(norm);
    // A single segment that says the same few words over and over
    const stuttering = words.length >= 12 && new Set(words).size / words.length < 0.35;
    if (repeated || stuttering) {
      looped += Math.max(0, seg.end - seg.start);
      if (firstLoopAt === null) firstLoopAt = seg.start;
    }
    recent.push(norm);
    if (recent.length > LOOKBACK) recent.shift();
  }

  const loopedShare = total > 0 ? Math.min(1, looped / total) : 0;
  const charsPerMinute = total > 0 ? chars / (total / 60) : 0;
  const avgLogprob = logprobCount > 0 ? logprobSum / logprobCount : null;
  const reasons: string[] = [];
  if (total >= MIN_JUDGED_SECONDS) {
    if (loopedShare >= MAX_LOOPED_SHARE) {
      reasons.push(
        `el ${Math.round(loopedShare * 100)} % del audio es una frase repetida en bucle` +
          (firstLoopAt !== null ? ` (desde el minuto ${Math.floor(firstLoopAt / 60)})` : '')
      );
    }
    if (charsPerMinute < MIN_CHARS_PER_MINUTE) {
      reasons.push(`solo hay ${Math.round(charsPerMinute)} caracteres por minuto de audio (lo normal son más de 600)`);
    }
  }
  if (total >= MIN_JUDGED_SECONDS && avgLogprob !== null && avgLogprob < MIN_AVG_LOGPROB) {
    reasons.push('Whisper entendió muy poco del audio (confianza media muy baja): si grabaste a más de 2×, el audio se estropea; graba a 1× o 2×');
  }
  return { suspect: reasons.length > 0, loopedShare, charsPerMinute, firstLoopAt, reasons };
}

/**
 * Read `<dataDir>/transcripts/<id>/<id>.json` and throw when it is not worth building notes on.
 * Nothing is deleted: the audio and the transcript stay where they are.
 */
export function assertTranscriptUsable(dataDir: string, transcriptId: string): TranscriptQuality {
  const file = path.join(dataDir, 'transcripts', transcriptId, `${transcriptId}.json`);
  let parsed: { segments?: QualitySegment[]; audioDurationSeconds?: number };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No readable JSON: not this check's business, the ingest reports it
    return { suspect: false, loopedShare: 0, charsPerMinute: 0, firstLoopAt: null, reasons: [] };
  }
  const quality = assessTranscript(parsed.segments ?? [], parsed.audioDurationSeconds ?? 0);
  if (quality.suspect) {
    throw new Error(
      `La transcripción de «${transcriptId}» parece defectuosa: ${quality.reasons.join('; ')}. ` +
        'No se han generado apuntes ni se ha subido nada; el audio se conserva en data/audio. ' +
        `Vuelve a transcribirla con «npm run transcribe:test -- --input data/audio/${transcriptId}.wav».`
    );
  }
  return quality;
}
