import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessTranscript, assertTranscriptUsable, type QualitySegment } from '../../src/transcriber/quality.js';
import { notesReady } from '../../src/study/StudyPipeline.js';

/** A healthy class: a new sentence every 8 s, ~800 characters a minute. */
function healthy(minutes: number): QualitySegment[] {
  const segs: QualitySegment[] = [];
  for (let t = 0, i = 0; t < minutes * 60; t += 8, i++) {
    segs.push({ start: t, end: t + 8, text: `Sobre el punto ${i} del tema conviene recordar que el ratio de liquidez compara el activo corriente con el pasivo corriente.` });
  }
  return segs;
}

/** What Whisper did on class 4: 20 minutes of speech, then one phrase for the rest of the audio. */
function looping(totalMinutes: number, goodMinutes: number): QualitySegment[] {
  const good = healthy(goodMinutes);
  const segs = [...good];
  for (let t = goodMinutes * 60; t < totalMinutes * 60; t += 30) {
    segs.push({ start: t, end: t + 30, text: 'Derecho de los Trabajadores,' });
  }
  return segs;
}

describe('transcript quality', () => {
  it('accepts a normal class', () => {
    const q = assessTranscript(healthy(60), 3600);
    expect(q.suspect).toBe(false);
    expect(q.loopedShare).toBe(0);
    expect(q.firstLoopAt).toBeNull();
  });

  it('flags a transcript that falls into a loop, and says where', () => {
    const q = assessTranscript(looping(106, 20), 106 * 60);
    expect(q.suspect).toBe(true);
    expect(q.loopedShare).toBeGreaterThan(0.7);
    expect(q.firstLoopAt).toBe(20 * 60 + 30);
    expect(q.reasons.join(' ')).toMatch(/minuto 20/);
  });

  it('tolerates a few repeated fillers (real classes have up to ~1 %)', () => {
    const segs = healthy(60);
    for (let i = 10; i < 16; i++) segs[i] = { start: segs[i]!.start, end: segs[i]!.end, text: 'Sí.' };
    const q = assessTranscript(segs, 3600);
    expect(q.suspect).toBe(false);
    expect(q.loopedShare).toBeLessThan(0.05);
  });

  it('flags one segment that stutters the same words', () => {
    const stutter = Array.from({ length: 20 }, () => 'Estatuto de los Trabajadores,').join(' ');
    const segs = healthy(10).map((s, i) => (i % 2 ? { ...s, text: stutter } : s));
    expect(assessTranscript(segs, 600).suspect).toBe(true);
  });

  it('flags a long recording with almost no text, even without a loop', () => {
    const q = assessTranscript([{ start: 0, end: 5, text: 'Hola buenas.' }], 3600);
    expect(q.suspect).toBe(true);
    expect(q.reasons.join(' ')).toMatch(/caracteres por minuto/);
  });

  it('flags garbled audio by a low Whisper confidence, even with plenty of text', () => {
    const segs = healthy(60).map((x) => ({ ...x, avg_logprob: -1.45 }));
    const q = assessTranscript(segs, 3600);
    expect(q.suspect).toBe(true);
    expect(q.reasons.join(' ')).toMatch(/confianza/);
    expect(assessTranscript(healthy(60).map((x) => ({ ...x, avg_logprob: -0.25 })), 3600).suspect).toBe(false);
  });

  it('does not judge a very short recording', () => {
    expect(assessTranscript([{ start: 0, end: 2, text: 'Hola.' }], 60).suspect).toBe(false);
  });

  describe('assertTranscriptUsable', () => {
    function withTranscript(id: string, segments: QualitySegment[], seconds: number) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-quality-'));
      fs.mkdirSync(path.join(dir, 'transcripts', id), { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcripts', id, `${id}.json`), JSON.stringify({ audioDurationSeconds: seconds, segments }));
      return dir;
    }

    it('throws, in Spanish and with the way out, for a looping transcript', () => {
      const dir = withTranscript('clase4', looping(106, 20), 106 * 60);
      try {
        expect(() => assertTranscriptUsable(dir, 'clase4')).toThrow(/parece defectuosa.*bucle.*transcribe:test/s);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes a healthy transcript and ignores a missing file (the ingest reports that)', () => {
      const dir = withTranscript('ok', healthy(30), 1800);
      try {
        expect(assertTranscriptUsable(dir, 'ok').suspect).toBe(false);
        expect(assertTranscriptUsable(dir, 'no-existe').suspect).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('notesReady (when the upload may happen)', () => {
  it('publishes only when there are notes', () => {
    expect(notesReady({ notes: 'created' })).toBe(true);
    expect(notesReady({ notes: 'kept' })).toBe(true);
    expect(notesReady({ notes: 'partial' })).toBe(true);
    expect(notesReady({ notes: 'failed' })).toBe(false);
    expect(notesReady({ notes: 'skipped' })).toBe(false);
  });
});
