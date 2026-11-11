import { describe, it, expect } from 'vitest';
import { contentDisposition, pdfFileName, shiftHeadings, stripLeadingTitle, theoryMarkdown } from '../../src/export/pdf-content.js';

describe('markdown for the PDF', () => {
  it('drops the document title and keeps the rest as it was', () => {
    expect(stripLeadingTitle('# Clase 1. Mecanismos\n\n## Resumen\n\nTexto.')).toBe('## Resumen\n\nTexto.');
    expect(stripLeadingTitle('\n\n# Título\nsin hueco\n')).toBe('sin hueco');
    expect(stripLeadingTitle('## Sin título de nivel 1\n\ntexto')).toBe('## Sin título de nivel 1\n\ntexto');
    expect(stripLeadingTitle('')).toBe('');
  });

  it('pushes titles down without passing level 6, and does not touch code', () => {
    expect(shiftHeadings('## A\n### B\n###### C\ntexto # no es título', 1)).toBe('### A\n#### B\n###### C\ntexto # no es título');
    expect(shiftHeadings('```\n# comentario\n```\n# Fuera', 2)).toBe('```\n# comentario\n```\n### Fuera');
  });

  it('takes the theory ranges of a class, or its whole notes when the ranges have no text', () => {
    const ranges = [
      { destination: 'course_info', markdown: '- presentación' },
      { destination: 'theory', markdown: '### Máquina [10:00]\n- Transmite energía.' },
      { destination: 'admin', markdown: '' },
      { destination: 'theory', markdown: '*(Sin voz en este tramo.)*' },
      { destination: 'theory', markdown: '### Mecanismo [20:00]\n- Une eslabones.' },
    ];
    expect(theoryMarkdown(ranges, '# todo')).toBe('### Máquina [10:00]\n- Transmite energía.\n\n### Mecanismo [20:00]\n- Une eslabones.');

    const empty = [{ destination: 'theory', markdown: '' }];
    expect(theoryMarkdown(empty, '# Clase\n\n## Resumen\nA mano.')).toBe('### Resumen\nA mano.');
    expect(theoryMarkdown([], null)).toBe('');
    expect(theoryMarkdown(empty, '   ')).toBe('');
  });

  it('names the file safely and keeps the real title for the download', () => {
    expect(pdfFileName('Clase 1. Evaluación y fundamentos de mecanismos')).toBe('Clase-1-evaluacion-y-fundamentos-de-mecanismos.pdf');
    expect(pdfFileName('???')).toBe('Apuntes.pdf');
    const header = contentDisposition('Clase 2: Análisis/dinámico');
    expect(header).toContain('filename="Clase-2-analisis-dinamico.pdf"');
    expect(header).toContain("filename*=UTF-8''Clase%202%20An%C3%A1lisis%20din%C3%A1mico.pdf");
  });
});
