import { describe, it, expect } from 'vitest';
import { extractKeyPoints, extractSummary, summaryLine } from '../../src/study/notes-summary.js';

describe('summary of a class from its notes', () => {
  it('takes the summary section, without timestamps, emphasis or the next section', () => {
    const notes = [
      '# 02MUIN Ingeniería mecánica', '',
      '## 1. Resumen Ejecutivo de la Sesión [00:00]\r',
      'La sesión revisó **pares cinemáticos** [17:13] y la ley de Grashof [40:02].', '',
      '- También se presentó el proyecto.', '',
      '## 2. Contenido Técnico', 'Máquina frente a mecanismo.',
    ].join('\n');
    expect(extractSummary(notes)).toBe('La sesión revisó pares cinemáticos y la ley de Grashof. También se presentó el proyecto.');
  });

  it('without a summary section uses the first real paragraph, and nothing if there is none', () => {
    const long = 'Ensayo de tracción con probetas normalizadas y lectura de la curva de tensión y deformación.';
    expect(extractSummary(`# Mis apuntes\n\nCorto.\n\n${long}\n\n## Otra`)).toBe(long);
    expect(extractSummary('# Mis apuntes\n\nCorto [00:10]')).toBe('');
    expect(extractSummary('')).toBe('');
    expect(extractSummary(null)).toBe('');
  });

  it('an empty summary section falls back to the first paragraph', () => {
    const long = 'Un párrafo suficientemente largo como para resumir de qué trata esta clase de hoy en concreto.';
    expect(extractSummary(`## Resumen\n\n## Contenido\n\n${long}`)).toBe(long);
  });

  it('reads the key points with the minute of their last time mark', () => {
    const notes = [
      '# Clase', '', '## Resumen', '', 'Un párrafo.', '', '## Puntos clave', '',
      '- Una máquina transforma energía y un **mecanismo** guía el movimiento [12:10]',
      '- Grübler: $F = 3(n-1) - 2 j_1$ [1:02:05]',
      '- Un punto sin marca de tiempo',
      '  texto suelto que no es una viñeta', '',
      '## Sección [11:40]', '- Esta viñeta no es un punto clave [11:50]',
    ].join('\n');
    expect(extractKeyPoints(notes)).toEqual([
      { text: 'Una máquina transforma energía y un mecanismo guía el movimiento', t_ms: 730_000 },
      { text: 'Grübler: $F = 3(n-1) - 2 j_1$', t_ms: 3_725_000 },
      { text: 'Un punto sin marca de tiempo', t_ms: null },
    ]);
    expect(extractSummary(notes)).toBe('Un párrafo.');
    expect(extractKeyPoints('# Clase\n\n## Resumen\n\nSolo párrafo.')).toEqual([]);
    expect(extractKeyPoints(null)).toEqual([]);
  });

  it('a line for lists is the first sentence, cut at a word when too long', () => {
    expect(summaryLine('Primera frase. Segunda frase.')).toBe('Primera frase.');
    expect(summaryLine('')).toBe('');
    const cut = summaryLine(`${'palabra '.repeat(40)}final.`, 50);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut.endsWith('palabra…')).toBe(true);
  });
});
