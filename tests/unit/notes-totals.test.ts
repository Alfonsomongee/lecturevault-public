import { describe, it, expect } from 'vitest';
import { flagInconsistentTotals, validateSectionNotes, type NotesRange } from '../../src/study/notes-sections.js';

// The balance of class 4 of 01MUIN: Whisper heard "6.000" where the teacher meant a hundred thousand
const balance = [
  '*   **Ejemplo Ecosolar (2026):**',
  '    *   **Activos:**',
  '        *   Maquinaria y equipos: 150.000 euros',
  '        *   Vehículos: 50.000 euros',
  '        *   Clientes pendientes de cobro: 60.000 euros',
  '        *   Banca y caja: 40.000 euros',
  '        *   **Total Activos: 300.000 euros** [08:56]',
  '    *   **Pasivos:**',
  '        *   Préstamos bancarios: 6.000 euros',
  '        *   Proveedores: 50.000 euros [10:14]',
  '    *   **Patrimonio Neto:**',
  '        *   Capital social: 6.000 euros',
  '        *   Beneficios acumulados: 50.000 euros [10:14]',
  '    *   **Total Pasivo + Patrimonio Neto: 300.000 euros** [10:36]',
].join('\n');

describe('totals that do not add up', () => {
  it('flags the total that its items do not reach, and only that one', () => {
    const warnings: string[] = [];
    const out = flagInconsistentTotals(balance, warnings).split('\n');
    expect(out[13]).toContain('[10:36] ⚠️');
    expect(out[6]).not.toContain('⚠');
    expect(warnings).toEqual(['Cifras que no cuadran en «Total Pasivo + Patrimonio Neto»: los apartados suman 112.000 y se dice 300.000']);
  });

  it('leaves a list that adds up, an unverifiable one and any other text alone', () => {
    const good = balance.replace('Préstamos bancarios: 6.000', 'Préstamos bancarios: 100.000').replace('Capital social: 6.000', 'Capital social: 100.000');
    const warnings: string[] = [];
    expect(flagInconsistentTotals(good, warnings)).toBe(good);
    const unknown = '- Ventas: 500.000 euros\n- Gastos: varios\n- **Total: 400.000 euros**';
    expect(flagInconsistentTotals(unknown, warnings)).toBe(unknown);
    const prose = 'El total de activos asciende a 300.000 euros y la suma de pasivos es 200.000.';
    expect(flagInconsistentTotals(prose, warnings)).toBe(prose);
    expect(warnings).toEqual([]);
  });

  it('reads notes saved with Windows line endings', () => {
    const warnings: string[] = [];
    expect(flagInconsistentTotals(balance.replace(/\n/g, '\r\n'), warnings)).toContain('[10:36] ⚠️');
    expect(warnings).toHaveLength(1);
  });

  it('understands negative figures and flags once', () => {
    const pl = '- Ventas: 500.000 euros\n- Costes: (100.000) euros\n- Salarios: (120.000) euros\n- **Total: 280.000 euros**';
    const warnings: string[] = [];
    expect(flagInconsistentTotals(pl, warnings)).toBe(pl);
    const once = flagInconsistentTotals(pl.replace('280.000', '380.000'), warnings);
    expect(once.split('\n')[3]).toMatch(/380\.000 euros\*\* ⚠️$/);
    expect(flagInconsistentTotals(once, warnings).match(/⚠️/g)).toHaveLength(1);
  });

  it('is part of validating the notes of a range', () => {
    const range: NotesRange = { ord: 1, start_ms: 0, end_ms: 600_000, destination: 'theory', heading: 'Balance', entity_title: null };
    const { markdown, warnings } = validateSectionNotes(balance, range, []);
    expect(markdown).toContain('⚠️');
    expect(warnings.some((w) => w.startsWith('Cifras que no cuadran'))).toBe(true);
  });
});
