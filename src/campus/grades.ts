/**
 * Grade calculator: from the course's grading table and the scores the student entered, what the final
 * grade is so far and what is still needed to reach a target. Pure, so every rule is unit-tested.
 *
 * Grading tables come from the model and are often loose: weights that do not add up to 100, parts listed
 * at the top level, a part without weight. The rules below read them the way the teacher said them:
 * - A part's weight is a share of the course ("Foro 1, 3 %" of a 50 % project). Only when the parts add up
 *   to 100 and the parent weighs less are they read as shares of the parent ("40 % / 60 % of the project").
 * - What the parts leave of their parent is an implicit "Resto de …" item, so the project still weighs 50.
 * - Parts without weight split what their parent leaves equally.
 * - A score entered on a parent stands for the whole parent: its parts are ignored.
 * - A minimum on a parent ("al menos 5 en el portafolio") applies to the parent's average.
 * Scores are on a 0–10 scale.
 */

export interface GradeItemInput {
  id: number;
  name: string;
  weight_pct: number | null;
  parent_id: number | null;
  min_grade: number | null;
  score: number | null;
}

export interface GradeLeaf {
  /** null for the implicit "Resto de …" part of a parent. */
  id: number | null;
  name: string;
  /** Share of the course, in %. */
  weight: number;
  score: number | null;
  /** What this item needs (0–10) for the target and every minimum; null once it has a score. */
  required: number | null;
  /** Item whose `min_grade` this leaf counts towards (itself or an ancestor). */
  minOf: number[];
}

export interface GradeMinimum {
  id: number;
  name: string;
  min: number;
  /** Average so far over what is graded in this item, or null. */
  current: number | null;
  status: 'met' | 'failed' | 'pending' | 'impossible';
}

export type GradeStatus =
  | 'no-data' // no weighted item
  | 'passed' // everything graded, target and minimums met
  | 'failed' // everything graded, target or a minimum not met
  | 'secured' // the target is met even with a 0 in what is left (minimums aside)
  | 'reachable'
  | 'unreachable'; // a 10 in everything left is not enough

export interface GradeProjection {
  target: number;
  leaves: GradeLeaf[];
  minimums: GradeMinimum[];
  /** Sum of the leaf weights: the base the final grade is computed on. */
  totalWeight: number;
  /** False when the weights do not add up to 100 %: the grade is then relative to `totalWeight`. */
  weightsOk: boolean;
  /** Items left out because nothing tells their weight. */
  unweighted: string[];
  gradedWeight: number;
  /** Average over what is graded, or null. */
  current: number | null;
  /** Final grade if every remaining item got a 0 / a 10. */
  floor: number;
  ceiling: number;
  /** Uniform score needed on the remaining items without a minimum of their own; null when none is left. */
  needed: number | null;
  status: GradeStatus;
}

const EPS = 0.5; // weights are stated in whole or half percents

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Flatten the grading tree into weighted leaves. */
function leavesOf(items: GradeItemInput[]): { leaves: GradeLeaf[]; unweighted: string[]; groups: Map<number, GradeItemInput> } {
  const ids = new Set(items.map((i) => i.id));
  const childrenOf = (id: number) => items.filter((i) => i.parent_id === id);
  const leaves: GradeLeaf[] = [];
  const unweighted: string[] = [];
  const groups = new Map<number, GradeItemInput>();

  const visit = (item: GradeItemInput, weight: number | null, mins: number[]): void => {
    const minOf = item.min_grade !== null ? [...mins, item.id] : mins;
    if (item.min_grade !== null) groups.set(item.id, item);
    const children = childrenOf(item.id);
    if (item.score !== null || children.length === 0) {
      if (weight === null || weight <= 0) unweighted.push(item.name);
      else leaves.push({ id: item.id, name: item.name, weight, score: item.score, required: null, minOf });
      return;
    }
    const stated = children.filter((c) => c.weight_pct !== null);
    const statedSum = sum(stated.map((c) => c.weight_pct!));
    const relative = weight !== null && statedSum > weight + EPS && Math.abs(statedSum - 100) <= EPS;
    const share = (w: number) => (relative ? (w * weight!) / 100 : w);
    const used = sum(stated.map((c) => share(c.weight_pct!)));
    const unstated = children.filter((c) => c.weight_pct === null);
    const left = weight !== null ? weight - used : 0;
    for (const c of stated) visit(c, share(c.weight_pct!), minOf);
    for (const c of unstated) visit(c, left > EPS ? left / unstated.length : null, minOf);
    if (unstated.length === 0 && left > EPS) {
      leaves.push({ id: null, name: `Resto de ${item.name}`, weight: left, score: null, required: null, minOf });
    }
  };

  for (const root of items.filter((i) => i.parent_id === null || !ids.has(i.parent_id))) {
    const children = childrenOf(root.id);
    // A parent without weight weighs what its parts say
    const weight = root.weight_pct ?? (children.length && root.score === null ? sum(children.map((c) => c.weight_pct ?? 0)) || null : null);
    visit(root, weight, []);
  }
  return { leaves, unweighted, groups };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function gradeProjection(items: GradeItemInput[], target = 5): GradeProjection {
  const { leaves, unweighted, groups } = leavesOf(items);
  const totalWeight = sum(leaves.map((l) => l.weight));
  const graded = leaves.filter((l) => l.score !== null);
  const open = leaves.filter((l) => l.score === null);
  const gradedWeight = sum(graded.map((l) => l.weight));
  const earned = sum(graded.map((l) => l.weight * l.score!));
  const base = {
    target,
    leaves,
    totalWeight: round2(totalWeight),
    weightsOk: Math.abs(totalWeight - 100) <= EPS,
    unweighted,
    gradedWeight: round2(gradedWeight),
    current: gradedWeight > 0 ? round2(earned / gradedWeight) : null,
  };
  if (totalWeight <= 0) {
    return { ...base, minimums: [], floor: 0, ceiling: 0, needed: null, status: 'no-data' };
  }
  const openWeight = totalWeight - gradedWeight;
  const floor = round2(earned / totalWeight);
  const ceiling = round2((earned + openWeight * 10) / totalWeight);

  // Each minimum fixes a floor for its open leaves: the average they need for the item to reach it
  const floorOf = new Map<GradeLeaf, number>();
  const minimums: GradeMinimum[] = [...groups.values()].map((g) => {
    const mine = leaves.filter((l) => l.minOf.includes(g.id));
    const done = mine.filter((l) => l.score !== null);
    const doneW = sum(done.map((l) => l.weight));
    const doneEarned = sum(done.map((l) => l.weight * l.score!));
    const openW = sum(mine.filter((l) => l.score === null).map((l) => l.weight));
    const current = doneW > 0 ? round2(doneEarned / doneW) : null;
    const allW = doneW + openW;
    if (allW <= 0) return { id: g.id, name: g.name, min: g.min_grade!, current, status: 'pending' as const };
    if (openW <= 0) {
      return { id: g.id, name: g.name, min: g.min_grade!, current, status: doneEarned / doneW >= g.min_grade! - 1e-9 ? 'met' as const : 'failed' as const };
    }
    const need = (g.min_grade! * allW - doneEarned) / openW;
    for (const l of mine) if (l.score === null) floorOf.set(l, Math.max(floorOf.get(l) ?? 0, need));
    return { id: g.id, name: g.name, min: g.min_grade!, current, status: need > 10 + 1e-9 ? 'impossible' as const : 'pending' as const };
  });

  if (open.length === 0) {
    const ok = floor >= target - 1e-9 && minimums.every((m) => m.status === 'met');
    return { ...base, minimums, floor, ceiling, needed: null, status: ok ? 'passed' : 'failed' };
  }

  // Leaves whose minimum asks more than the uniform score keep that minimum; the rest share what is left
  const goal = target * totalWeight - earned;
  const fixed = new Set<GradeLeaf>();
  let needed = 0;
  for (;;) {
    const free = open.filter((l) => !fixed.has(l));
    const fixedPoints = sum([...fixed].map((l) => l.weight * floorOf.get(l)!));
    const freeWeight = sum(free.map((l) => l.weight));
    needed = freeWeight > 0 ? (goal - fixedPoints) / freeWeight : 0;
    const raise = free.filter((l) => (floorOf.get(l) ?? 0) > needed);
    if (raise.length === 0) break;
    for (const l of raise) fixed.add(l);
  }
  const free = open.filter((l) => !fixed.has(l));
  if (free.length === 0) {
    // Every open leaf is held by a minimum: if the minimums alone fall short, all of them go up evenly
    const fixedPoints = sum(open.map((l) => l.weight * floorOf.get(l)!));
    const extra = fixedPoints < goal ? (goal - fixedPoints) / openWeight : 0;
    for (const l of open) l.required = round2(Math.max(0, floorOf.get(l)! + extra));
  } else {
    for (const l of open) l.required = round2(Math.max(0, fixed.has(l) ? floorOf.get(l)! : needed));
  }

  const impossible = open.some((l) => l.required! > 10 + 1e-9) || minimums.some((m) => m.status === 'failed' || m.status === 'impossible');
  const status: GradeStatus = impossible ? 'unreachable' : goal <= 1e-9 && floorOf.size === 0 ? 'secured' : 'reachable';
  return { ...base, minimums, floor, ceiling, needed: free.length ? round2(Math.max(0, needed)) : null, status };
}
