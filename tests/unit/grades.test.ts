import { describe, it, expect } from 'vitest';
import { gradeProjection, type GradeItemInput } from '../../src/campus/grades.js';

let next = 1;
function item(name: string, weight: number | null, extra: Partial<GradeItemInput> = {}): GradeItemInput {
  return { id: next++, name, weight_pct: weight, parent_id: null, min_grade: null, score: null, ...extra };
}

describe('gradeProjection', () => {
  it('computes what is needed in the rest for a flat table', () => {
    const p = gradeProjection([item('Actividad', 50, { score: 4 }), item('Examen', 50)], 5);
    expect(p.weightsOk).toBe(true);
    expect(p.current).toBe(4);
    expect(p.needed).toBe(6);
    expect(p.floor).toBe(2);
    expect(p.ceiling).toBe(7);
    expect(p.status).toBe('reachable');
  });

  it('says when the target is already secured and when it cannot be reached', () => {
    expect(gradeProjection([item('A', 60, { score: 9 }), item('B', 40)], 5).status).toBe('secured');
    expect(gradeProjection([item('A', 80, { score: 2 }), item('B', 20)], 5).status).toBe('unreachable');
  });

  it('reads parts as shares of the course and adds the rest of the parent', () => {
    const project = item('Proyecto', 50);
    const p = gradeProjection([project, item('Foro 1', 3, { parent_id: project.id }), item('Informe', 5, { parent_id: project.id }), item('Examen', 50)]);
    expect(p.leaves.map((l) => [l.name, l.weight])).toEqual([
      ['Foro 1', 3], ['Informe', 5], ['Resto de Proyecto', 42], ['Examen', 50],
    ]);
    expect(p.weightsOk).toBe(true);
  });

  it('reads parts that add up to 100 as shares of their parent', () => {
    const project = item('Proyecto', 40);
    const p = gradeProjection([project, item('Parte 1', 25, { parent_id: project.id }), item('Parte 2', 75, { parent_id: project.id }), item('Examen', 60)]);
    expect(p.leaves.map((l) => l.weight)).toEqual([10, 30, 60]);
  });

  it('splits what the parent leaves among parts without weight', () => {
    const portfolio = item('Portafolio', 50);
    const p = gradeProjection([portfolio, item('Actividad 1', null, { parent_id: portfolio.id }), item('Actividad 2', null, { parent_id: portfolio.id }), item('Examen', 50)]);
    expect(p.leaves.map((l) => l.weight)).toEqual([25, 25, 50]);
  });

  it('uses a score entered on the parent instead of its parts', () => {
    const portfolio = item('Portafolio', 50, { score: 8 });
    const p = gradeProjection([portfolio, item('Actividad 1', 20, { parent_id: portfolio.id }), item('Examen', 50)]);
    expect(p.leaves.map((l) => l.name)).toEqual(['Portafolio', 'Examen']);
    expect(p.needed).toBe(2);
  });

  it('flags weights that do not add up to 100 and leaves unweighted items out', () => {
    const p = gradeProjection([item('A', 20), item('B', 30), item('Examen', 50), item('Portafolio', 50), item('Asistencia', null)]);
    expect(p.totalWeight).toBe(150);
    expect(p.weightsOk).toBe(false);
    expect(p.unweighted).toEqual(['Asistencia']);
  });

  it('raises the items with a minimum above the uniform score and lowers the rest', () => {
    // 5 in the exam is mandatory; with an 8 in the portfolio the exam alone would need a 2
    const p = gradeProjection([item('Portafolio', 50, { score: 8 }), item('Examen', 50, { min_grade: 5 })], 5);
    const exam = p.leaves.find((l) => l.name === 'Examen')!;
    expect(exam.required).toBe(5);
    expect(p.status).toBe('reachable');

    const q = gradeProjection([item('Portafolio', 50), item('Examen', 50, { min_grade: 5 }), item('Extra', 0)], 6);
    expect(q.leaves.find((l) => l.name === 'Examen')!.required).toBe(6);
  });

  it('applies a minimum on a parent to the average of its parts', () => {
    const portfolio = item('Portafolio', 50, { min_grade: 5 });
    const p = gradeProjection([
      portfolio,
      item('Actividad 1', 25, { parent_id: portfolio.id, score: 3 }),
      item('Actividad 2', 25, { parent_id: portfolio.id }),
      item('Examen', 50, { score: 10 }),
    ], 5);
    expect(p.leaves.find((l) => l.name === 'Actividad 2')!.required).toBe(7);
    expect(p.minimums[0]).toMatchObject({ name: 'Portafolio', current: 3, status: 'pending' });
  });

  it('fails a finished course on a missed minimum even with a passing average', () => {
    const p = gradeProjection([item('Portafolio', 50, { score: 10 }), item('Examen', 50, { min_grade: 5, score: 4 })], 5);
    expect(p.floor).toBe(7);
    expect(p.status).toBe('failed');
    expect(p.minimums[0]!.status).toBe('failed');
  });

  it('has nothing to say without weights', () => {
    expect(gradeProjection([item('Examen', null)]).status).toBe('no-data');
    expect(gradeProjection([]).status).toBe('no-data');
  });
});
