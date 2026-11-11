import { describe, it, expect } from 'vitest';
import { assessNotes, keyTermsOf } from '../../src/study/notes-quality.js';
import { evenRanges } from '../../src/cli/notes-eval.js';
import type { TranscriptSegment } from '../../src/library/transcript-files.js';

/** A 10-minute class about a low-pass filter, with the vocabulary repeated like a real class does */
const segs: TranscriptSegment[] = Array.from({ length: 60 }, (_, i) => ({
  start: i * 10,
  end: i * 10 + 10,
  text: [
    'El filtro paso bajo tiene una frecuencia de corte de 1,5 kHz y la resistencia vale 4,7 kilohmios.',
    'La capacidad del condensador determina la frecuencia de corte del filtro.',
    'El examen vale el 40 % de la nota y la entrega es de 18:00 a 20:00.',
  ][i % 3]!,
}));

const GOOD = `# Filtros

## Resumen
Se estudia el filtro paso bajo.

## Filtro [00:10]
### Frecuencia de corte [01:00]
- El filtro tiene una frecuencia de corte de 1,5 kHz [01:20] con una resistencia de 4,7 kilohmios.
- $f_c = \\frac{1}{2\\pi R C}$ define la frecuencia de corte del condensador; la capacidad determina el valor.
- La entrega es de 18:00 a 20:00 y el examen cuenta para la nota.

$$f_c = \\frac{1}{2\\pi R C}$$

> [!EXAM] Entra en el examen
> El examen vale el 40 % de la nota [05:00].
`;

describe('assessNotes', () => {
  it('scores well-formed notes that follow the class', () => {
    const q = assessNotes(GOOD, segs);
    expect(q.formulas).toEqual({ total: 2, broken: [] });
    expect(q.figures.unsupported).toEqual([]);
    expect(q.timeMarks.outOfClass).toBe(0);
    expect(q.coverage.ratio).toBeGreaterThanOrEqual(0.8);
    expect(q.filler.count).toBe(0);
    expect(q.structure.callouts).toBe(1);
    expect(q.score).toBeGreaterThan(80);
  });

  it('catches broken LaTeX, invented figures, marks past the end and leftover filler', () => {
    const bad = GOOD
      .replace('$f_c = \\frac{1}{2\\pi R C}$', '$f_c = \\frac{1}{2\\pi R C$')
      .replace('40 %', '75 %')
      .replace('[05:00]', '[95:00]')
      + '\nEh, o sea, el filtro es importante.\n';
    const q = assessNotes(bad, segs);
    expect(q.formulas.broken.length).toBeGreaterThan(0);
    expect(q.figures.unsupported).toContain('75%');
    expect(q.timeMarks.outOfClass).toBe(1);
    expect(q.filler.count).toBeGreaterThanOrEqual(2);
    expect(q.score).toBeLessThan(assessNotes(GOOD, segs).score - 10);
    expect(q.issues.join(' ')).toMatch(/fórmula/);
  });

  it('flags a block $$ that is never closed', () => {
    expect(assessNotes(`${GOOD}\n$$ x = 1\n`, segs).structure.unbalancedMath).toBe(true);
  });

  it('does not mistake demonstratives, clock times or course codes for problems', () => {
    const q = assessNotes('# Clase 02MUIN\n\nEste tramo repasa el filtro; con este valor de la resistencia, de 18:00 a 20:00 [01:00]. Sesión 2.\n', segs);
    expect(q.filler.count).toBe(0);
    expect(q.figures.unsupported).toEqual([]);
  });

  it('counts "este," and "bueno," used as a pause as filler', () => {
    expect(assessNotes('# T\n\nEste, el filtro. Bueno, la resistencia.\n', segs).filler.count).toBe(2);
  });

  it('accepts 80.000 when the class says "80 mil"', () => {
    const s: TranscriptSegment[] = [{ start: 0, end: 60, text: 'La inversión es de 80 mil euros.' }];
    expect(assessNotes('# T\n\nInversión de 80.000 euros [00:10].\n', s).figures.unsupported).toEqual([]);
  });

  it('reports a notes file with no time marks', () => {
    expect(assessNotes('# T\n\nSolo texto sobre el filtro.\n', segs).issues.join(' ')).toMatch(/Sin marcas de tiempo/);
  });
});

describe('keyTermsOf', () => {
  it('returns the repeated technical words and skips speech words', () => {
    const terms = keyTermsOf(segs);
    expect(terms).toEqual(expect.arrayContaining(['frecuencia', 'condensador', 'resistencia']));
    expect(terms).not.toContain('nuestro');
  });
});

describe('evenRanges', () => {
  it('covers the whole class with contiguous theory ranges of about 20 minutes', () => {
    const r = evenRanges(65 * 60_000);
    expect(r[0]!.start_ms).toBe(0);
    expect(r[r.length - 1]!.end_ms).toBe(65 * 60_000);
    r.slice(1).forEach((x, i) => expect(x.start_ms).toBe(r[i]!.end_ms));
    expect(r.length).toBe(3);
    expect(r.every((x) => x.destination === 'theory')).toBe(true);
    expect(evenRanges(60_000)).toHaveLength(1);
  });
});
