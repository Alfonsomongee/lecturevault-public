import { describe, expect, it } from 'vitest';
import {
  NOTES_PART_CHARS, mergeSplitSections, rangeSegments, rangeTranscript, splitLongRanges, type NotesRange,
} from '../../src/study/notes-sections.js';
import { TranscriptRefiner } from '../../src/ai/TranscriptRefiner.js';
import type { TranscriptSegment } from '../../src/library/transcript-files.js';

/** A class of `minutes` minutes: a 90-character sentence every 7 s, with a 4 s pause every 15 segments */
function classSegments(minutes: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let t = 0;
  let i = 0;
  while (t < minutes * 60) {
    const gap = i % 15 === 14 ? 4 : 0.2;
    out.push({ start: t, end: t + 6.5, text: `Frase ${i}: ${'palabra '.repeat(10)}`.slice(0, 90) });
    t += 6.5 + gap;
    i++;
  }
  return out;
}

const theory = (end_min: number, start_min = 0, ord = 3): NotesRange => ({
  ord, start_ms: start_min * 60_000, end_ms: end_min * 60_000, destination: 'theory', heading: 'Contenido', entity_title: null,
});

describe('splitLongRanges', () => {
  it('leaves a range that fits as it is', () => {
    const segments = classSegments(20);
    const { units, parts } = splitLongRanges([theory(20)], segments);
    expect(units).toHaveLength(1);
    expect(units[0]!.ord).toBe(3);
    expect(parts.get(3)).toEqual([3]);
  });

  it('cuts a 97-minute range into parts that cover every segment exactly once', () => {
    const segments = classSegments(97);
    const range = theory(104, 7);
    const shifted = segments.map((s) => ({ ...s, start: s.start + 7 * 60, end: s.end + 7 * 60 }));
    const { units, parts } = splitLongRanges([range], shifted);
    expect(units.length).toBeGreaterThanOrEqual(3);
    expect(parts.get(3)).toEqual(units.map((u) => u.ord));
    // contiguous, same limits as the range
    expect(units[0]!.start_ms).toBe(range.start_ms);
    expect(units[units.length - 1]!.end_ms).toBe(range.end_ms);
    for (let i = 1; i < units.length; i++) expect(units[i]!.start_ms).toBe(units[i - 1]!.end_ms);
    // every segment of the range belongs to exactly one part
    const inRange = rangeSegments(shifted, range);
    const covered = units.reduce((n, u) => n + rangeSegments(shifted, u).length, 0);
    expect(covered).toBe(inRange.length);
    // and no part is much longer than the limit
    for (const u of units) expect(rangeTranscript(shifted, u).length).toBeLessThan(NOTES_PART_CHARS * 1.25);
    expect(units[1]!.heading).toMatch(/parte 2 de \d/);
  });

  it('cuts where there is a pause, not in the middle of a speech', () => {
    const segments = classSegments(97);
    const { units } = splitLongRanges([theory(97)], segments);
    for (const u of units.slice(1)) {
      const next = segments.find((s) => s.start * 1000 >= u.start_ms)!;
      const prev = [...segments].reverse().find((s) => s.start * 1000 < u.start_ms)!;
      expect(next.start - prev.end).toBeGreaterThanOrEqual(3.9);
    }
  });
});

describe('mergeSplitSections', () => {
  const parts = new Map([[3, [3001, 3002, 3003]], [5, [5]]]);

  it('joins the parts of a range in order and keeps one gist and the models', () => {
    const { sections, failed } = mergeSplitSections(
      [
        { ord: 3002, gist: 'Segunda.', markdown: 'B', model: 'deepseek' },
        { ord: 3001, gist: 'Primera', markdown: 'A', model: 'gemini' },
        { ord: 3003, gist: 'Tercera.', markdown: 'C', model: 'gemini' },
        { ord: 5, gist: 'Otra.', markdown: 'X' },
      ],
      parts
    );
    expect(failed).toEqual([]);
    expect(sections.map((s) => s.ord)).toEqual([3, 5]);
    expect(sections[0]!.markdown).toBe('A\n\nB\n\nC');
    expect(sections[0]!.gist).toBe('Primera. Segunda. Tercera.');
    expect(sections[0]!.model).toBe('gemini + deepseek');
  });

  it('does not publish a range with a missing part: it counts as failed', () => {
    const { sections, failed } = mergeSplitSections(
      [{ ord: 3001, gist: '', markdown: 'A' }, { ord: 3003, gist: '', markdown: 'C' }, { ord: 5, gist: '', markdown: 'X' }],
      parts
    );
    expect(failed).toEqual([3]);
    expect(sections.map((s) => s.ord)).toEqual([5]);
  });
});

describe('TranscriptRefiner.refineSections with a range longer than one answer', () => {
  it('writes it in parts and returns one section for the range', async () => {
    const segments = classSegments(97);
    const range = theory(97);
    const calls: number[] = [];
    // A model whose answer is capped: it refuses anything that asks for more than ~35k characters of transcript
    const client = {
      hasKey: true,
      lastModelUsed: 'fake-model',
      async generateText(prompt: string): Promise<string> {
        calls.push(prompt.length);
        const blocks = [...prompt.matchAll(/=== TRAMO (\d+) · ([\s\S]*?) ===\n([\s\S]*?)(?=\n\n=== TRAMO |$)/g)];
        const asked = blocks.reduce((n, b) => n + b[3]!.length, 0);
        if (asked > 35_000) throw new Error('respuesta cortada por límite de tokens (length)');
        return blocks
          .map((b) => {
            const first = /\[(\d{1,2}:\d{2})\]/.exec(b[3]!)?.[1] ?? '00:00';
            return `<<<TRAMO ${b[1]}>>>\nRESUMEN: parte ${b[1]}\n### Apuntes de ${b[1]} [${first}]\n- punto [${first}]\n<<<FIN>>>`;
          })
          .join('\n');
      },
    };
    const refiner = new TranscriptRefiner({ client: client as never });
    const result = await refiner.refineSections(segments, [range]);

    expect(result.errors).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.ord).toBe(3);
    // one block of notes per part, in time order
    const headings = result.sections[0]!.markdown.match(/### Apuntes de (\d+)/g) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...calls)).toBeLessThan(80_000);
  });
});
