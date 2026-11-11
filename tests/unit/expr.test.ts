import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser module, no types
import { compile, sample } from '../../public/app/expr.js';

const at = (src: string, x = 0) => (compile(src) as (x: number) => number)(x);

describe('compile (function plots)', () => {
  it('evaluates arithmetic with the usual precedence and right-associative powers', () => {
    expect(at('1 + 2 * 3')).toBe(7);
    expect(at('2^3^2')).toBe(512);
    expect(at('-x^2', 3)).toBe(-9);
    expect(at('x^-1', 4)).toBe(0.25);
    expect(at('(x + 1)(x - 1)', 3)).toBe(8);
  });

  it('accepts implicit multiplication, unicode signs and constants', () => {
    expect(at('2x', 5)).toBe(10);
    expect(at('3(x+1)', 1)).toBe(6);
    expect(at('x sin(x)', 0)).toBe(0);
    expect(at('x²', 3)).toBe(9);
    expect(at('2·π')).toBeCloseTo(2 * Math.PI);
    expect(at('4 − x', 1)).toBe(3);
    expect(at('SIN(PI/2)')).toBeCloseTo(1);
  });

  it('knows the basic functions', () => {
    expect(at('sqrt(x)', 16)).toBe(4);
    expect(at('ln(e)')).toBe(1);
    expect(at('log(1000)')).toBeCloseTo(3);
    expect(at('max(x, 2)', 5)).toBe(5);
    expect(at('abs(x)', -3)).toBe(3);
  });

  it('rejects anything that is not math, so nothing can run', () => {
    for (const bad of ['alert(1)', 'constructor', 'x.y', 'process', '__proto__', 'x; 1', '1 +', '(1', '1)', 'sin x', '', 'toString(x)', 'fetch("a")']) {
      expect(() => compile(bad), bad).toThrow();
    }
  });

  it('refuses over-long or over-nested input instead of overflowing the stack', () => {
    expect(() => compile('1+'.repeat(200) + '1')).toThrow(/larga/);
    expect(() => compile('('.repeat(60) + 'x' + ')'.repeat(60))).toThrow(/anidada/);
  });

  it('sample() breaks the curve where the function is undefined', () => {
    const pts = sample(compile('1/x'), -1, 1, 4) as ({ x: number; y: number } | null)[];
    expect(pts).toHaveLength(5);
    expect(pts[2]).toBeNull(); // x = 0 -> Infinity
    expect(pts[0]).toEqual({ x: -1, y: -1 });
  });
});
