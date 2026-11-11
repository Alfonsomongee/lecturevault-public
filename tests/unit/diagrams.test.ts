import { describe, it, expect } from 'vitest';
import { expressionIsSafe, validateDiagrams } from '../../src/study/diagrams.js';
// @ts-expect-error plain browser module, no types
import { compile } from '../../public/app/expr.js';

const said = 'La señal tiene una amplitud de 3,5 voltios y una frecuencia de 50 Hz. Primero se mide la tensión, después se compara con el umbral de seguridad y, si la supera, se activa la alarma. Las ventas fueron 120 en 2023 y 150 en 2024.';
const fence = (kind: string, spec: unknown) => `Texto antes.\n\n\`\`\`${kind}\n${typeof spec === 'string' ? spec : JSON.stringify(spec)}\n\`\`\`\n\nTexto después.`;

describe('expressionIsSafe', () => {
  it('accepts plain math and the functions the browser knows', () => {
    for (const ok of ['sin(x)/x', '3.5*sin(2*pi*50*x)', 'x^2 - 4', 'exp(-x)*cos(x)', 'sqrt(abs(x))', '2x', 'x²']) expect(expressionIsSafe(ok), ok).toBe(true);
  });

  it('rejects names, calls and characters that are not math', () => {
    for (const bad of ['alert(1)', 'x.constructor', 'process.exit()', 'x; y', '__proto__', 'eval("1")', 'a+b', '(((x)', 'x)', '', 'x'.repeat(300), 'sin(x) // c']) expect(expressionIsSafe(bad), bad).toBe(false);
  });

  it('whatever it accepts the browser parser can compile', () => {
    for (const ok of ['sin(x)/x', '3.5*sin(2*pi*50*x)', 'x^2 - 4', 'exp(-x)*cos(x)', 'sqrt(abs(x))', '2x', 'x²', 'log10(x)+log2(x)', 'min(x,2)', 'pow(x,2)']) {
      expect(expressionIsSafe(ok), ok).toBe(true);
      expect(() => compile(ok), ok).not.toThrow();
    }
  });
});

describe('validateDiagrams', () => {
  it('keeps a plot whose numbers the class says and rewrites it as clean JSON', () => {
    const out = validateDiagrams(fence('plot', { xMin: 0, xMax: 0.1, curves: [{ expr: '3.5*sin(2*pi*50*x)', label: 'señal', extra: '<script>' }], onerror: 'x' }), said);
    expect(out.warnings).toEqual([]);
    const spec = JSON.parse(/```plot\n(.*)\n```/.exec(out.markdown)![1]!);
    expect(spec).toMatchObject({ xMin: 0, xMax: 0.1, curves: [{ expr: '3.5*sin(2*pi*50*x)', label: 'señal' }], points: [] });
    expect(spec).not.toHaveProperty('onerror');
    expect(out.markdown).toContain('Texto antes.');
    expect(out.markdown).toContain('Texto después.');
  });

  it('removes a plot with a constant the class never said, with a warning', () => {
    const out = validateDiagrams(fence('plot', { xMin: 0, xMax: 1, curves: [{ expr: '7.25*x' }] }), said);
    expect(out.markdown).not.toContain('```');
    expect(out.warnings[0]).toMatch(/plot.*7\.25/);
  });

  it('removes plots with unsafe expressions, bad intervals or broken JSON', () => {
    for (const spec of [
      { xMin: 0, xMax: 1, curves: [{ expr: 'alert(1)' }] },
      { xMin: 5, xMax: 1, curves: [{ expr: 'x' }] },
      { xMin: 0, xMax: 1, yMin: 3, curves: [{ expr: 'x' }] },
      { xMin: 0, xMax: 1, curves: [] },
      '{"xMin": 0, "curves": [',
      '[1,2,3]',
    ]) {
      const out = validateDiagrams(fence('plot', spec), said);
      expect(out.markdown, JSON.stringify(spec)).not.toContain('```');
      expect(out.warnings).toHaveLength(1);
    }
  });

  it('keeps a chart whose values are said and drops one with invented values or a wrong shape', () => {
    const good = { type: 'bar', labels: ['2023', '2024'], series: [{ name: 'Ventas', values: [120, 150] }], unit: 'u.' };
    expect(validateDiagrams(fence('chart', good), said).warnings).toEqual([]);
    expect(validateDiagrams(fence('chart', { ...good, series: [{ name: 'Ventas', values: [120, 175] }] }), said).warnings[0]).toMatch(/175/);
    expect(validateDiagrams(fence('chart', { ...good, series: [{ name: 'Ventas', values: [120] }] }), said).warnings[0]).toMatch(/cuadran/);
    expect(validateDiagrams(fence('chart', { ...good, labels: ['solo'] }), said).warnings[0]).toMatch(/categorías/);
    expect(validateDiagrams(fence('chart', { type: 'pie', labels: ['a', 'b'], series: [{ name: 'x', values: [120, -150] }] }), said).warnings[0]).toMatch(/negativo/);
  });

  it('keeps a flow made of the class\'s own words and drops one the class never described', () => {
    const flow = {
      direction: 'LR',
      nodes: [{ id: 'a', label: 'Medir la tensión', kind: 'start' }, { id: 'b', label: 'Comparar con el umbral', kind: 'decision' }, { id: 'c', label: 'Activar la alarma', kind: 'end' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'supera' }, { from: 'b', to: 'zz' }, { from: 'a', to: 'a' }],
    };
    const ok = validateDiagrams(fence('flow', flow), said);
    expect(ok.warnings).toEqual([]);
    expect(JSON.parse(/```flow\n(.*)\n```/.exec(ok.markdown)![1]!).edges).toHaveLength(2); // dangling and self edges are dropped

    const invented = { nodes: [{ id: 'a', label: 'Planificar sprint' }, { id: 'b', label: 'Desplegar contenedor' }], edges: [{ from: 'a', to: 'b' }] };
    expect(validateDiagrams(fence('flow', invented), said).warnings[0]).toMatch(/no salen de la clase/);
    expect(validateDiagrams(fence('flow', { nodes: [{ id: 'a', label: 'Medir' }, { id: 'a', label: 'Medir otra' }], edges: [] }), said).warnings[0]).toMatch(/id repetido/);
  });

  it('allows at most three blocks per range and leaves ordinary code blocks alone', () => {
    const one = '```plot\n{"xMin":0,"xMax":1,"curves":[{"expr":"x"}]}\n```';
    const md = `${one}\n\n${one}\n\n${one}\n\n${one}\n\n\`\`\`python\nprint(1)\n\`\`\``;
    const out = validateDiagrams(md, said);
    expect(out.markdown.match(/```plot/g)).toHaveLength(3);
    expect(out.markdown).toContain('```python\nprint(1)\n```');
    expect(out.warnings).toHaveLength(1);
  });

  it('strips markup from labels', () => {
    const out = validateDiagrams(fence('plot', { xMin: 0, xMax: 1, title: '<img src=x onerror=alert(1)>', curves: [{ expr: 'x' }] }), said);
    expect(out.markdown).not.toContain('<');
  });
});
