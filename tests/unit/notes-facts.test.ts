import { describe, it, expect } from 'vitest';
import { appendMissingFacts, factIsCovered, factsBlock, missingFacts, parseFacts, verifyFacts, type Fact } from '../../src/study/notes-facts.js';
import type { NotesRange } from '../../src/study/notes-sections.js';
import type { TranscriptSegment } from '../../src/library/transcript-files.js';

const range: NotesRange = { ord: 1, start_ms: 600_000, end_ms: 1_200_000, destination: 'theory', heading: 'Filtros' };
const segs: TranscriptSegment[] = [
  { start: 650, end: 660, text: 'La frecuencia de corte es de 1,5 kHz para este filtro paso bajo.' },
  { start: 700, end: 710, text: 'La práctica pesa un 30 % de la nota final.' },
  { start: 1100, end: 1110, text: 'Esto es importante, entra en el examen.' },
];
const fact = (t: number, kind: Fact['kind'], text: string): Fact => ({ t_ms: t * 1000, kind, text });

describe('parseFacts', () => {
  it('reads blocks of "[mm:ss] TIPO | texto" and skips lines it cannot read', () => {
    const out = parseFacts([
      'Aquí tienes la lista:',
      '<<<TRAMO 1>>>',
      '[10:50] DEF | Un filtro deja pasar ciertas frecuencias.',
      '- [11:40] formula | $f_c = \\frac{1}{2\\pi R C}$',
      '[1:05:00] ENFASIS - Esto entra en el examen',
      'una línea suelta',
      '[12:00] INVENTADO | tipo que no existe',
      '<<<FIN>>>',
      '[13:00] DEF | fuera de bloque',
    ].join('\n'));
    expect([...out.keys()]).toEqual([1]);
    expect(out.get(1)!.map((f) => [f.t_ms / 1000, f.kind])).toEqual([[650, 'DEF'], [700, 'FORMULA'], [3900, 'ENFASIS']]);
    expect(out.get(1)![1]!.text).toBe('$f_c = \\frac{1}{2\\pi R C}$');
  });

  it('returns nothing for an answer without blocks', () => {
    expect(parseFacts('no hay nada útil').size).toBe(0);
  });
});

describe('verifyFacts', () => {
  it('keeps the grounded facts in order and drops out-of-range, repeated and unsaid-figure ones', () => {
    const { kept, dropped } = verifyFacts([
      fact(1100, 'ENFASIS', 'Entra en el examen'),
      fact(655, 'DATO', 'La frecuencia de corte es de 1,5 kHz'),
      fact(655, 'DATO', 'La frecuencia de corte es de 1,5 kHz'),
      fact(3000, 'DEF', 'Algo de otra parte de la clase'),
      fact(705, 'DATO', 'La práctica pesa un 45 % de la nota'),
    ], range, segs);
    expect(kept.map((f) => f.t_ms / 1000)).toEqual([655, 1100]);
    expect(dropped).toHaveLength(2);
    expect(dropped.join(' ')).toMatch(/fuera del tramo/);
    expect(dropped.join(' ')).toMatch(/45/);
  });

  it('does not count the numbers inside a formula as figures to ground', () => {
    const { kept } = verifyFacts([fact(655, 'FORMULA', 'Frecuencia de corte $f_c = \\frac{1}{2\\pi R C}$ con 2 polos')], range, segs);
    expect(kept).toHaveLength(1);
  });
});

describe('completeness of the notes', () => {
  const notes = '### Filtros [10:50]\n- La frecuencia de corte es de 1,5 kHz [10:55].\n- $f_c = \\frac{1}{2\\pi R C}$';

  it('recognises a fact by its figures, its formula or most of its words', () => {
    expect(factIsCovered(fact(655, 'DATO', 'La frecuencia de corte es de 1,5 kHz'), notes)).toBe(true);
    expect(factIsCovered(fact(660, 'FORMULA', 'Frecuencia de corte: $f_c=\\frac{1}{2\\pi R C}$'), notes)).toBe(true);
    expect(factIsCovered(fact(660, 'DEF', 'La frecuencia de corte determina el filtro'), notes)).toBe(true);
    expect(factIsCovered(fact(660, 'DEF', 'La frecuencia de corte separa lo que pasa de lo que se atenúa'), notes)).toBe(false);
  });

  it('notices a missing figure even when the words are there, and a missing formula', () => {
    expect(factIsCovered(fact(655, 'DATO', 'La frecuencia de corte es de 2,2 kHz'), notes)).toBe(false);
    expect(factIsCovered(fact(660, 'FORMULA', 'Ganancia $G = 1 + \\frac{R_2}{R_1}$'), notes)).toBe(false);
    expect(factIsCovered(fact(1100, 'ENFASIS', 'Entra en el examen el diagrama de Bode'), notes)).toBe(false);
  });

  it('only demands the kinds that always matter', () => {
    const facts = [fact(1100, 'ENFASIS', 'Entra en el examen el diagrama de Bode'), fact(900, 'EJEMPLO', 'Ejemplo con un amplificador operacional')];
    expect(missingFacts(facts, notes).map((f) => f.kind)).toEqual(['ENFASIS']);
  });

  it('appends the missing facts under their own heading with the minute, once', () => {
    const out = appendMissingFacts(notes, [fact(1100, 'ENFASIS', 'Entra en el examen el diagrama de Bode [18:20]')]);
    expect(out).toContain('#### Otros puntos del tramo\n- Entra en el examen el diagrama de Bode [18:20]');
    expect(appendMissingFacts(notes, [])).toBe(notes);
  });

  it('shows the facts block with kind and minute', () => {
    expect(factsBlock([fact(655, 'DATO', 'Corte 1,5 kHz')])).toBe('HECHOS A RECOGER (comprobados contra la transcripción):\n- [10:55] DATO | Corte 1,5 kHz');
    expect(factsBlock([])).toBe('');
  });
});
