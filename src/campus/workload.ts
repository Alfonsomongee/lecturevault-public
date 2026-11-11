/**
 * Weekly workload: how much is due each week (Monday to Sunday), so weeks where exams and deliverables
 * pile up stand out before they arrive. Pure, shared by the calendar strip, the month grid and Inicio.
 */

import { addDays, parseIso, toIso } from '../study/dates.js';

/** What an event weighs in its week: an exam takes more preparation than a deadline, a session none. */
export const LOAD_WEIGHT: Record<string, number> = { exam: 3, deadline: 2, lab: 1, other: 1, session: 0 };

export type LoadLevel = 'none' | 'light' | 'busy' | 'critical';

export interface LoadEvent {
  id: number;
  kind: string;
  title: string;
  course: string;
  date: string | null;
  dismissed?: number;
}

export interface WeekLoad {
  /** Monday, YYYY-MM-DD */
  start: string;
  /** Sunday, YYYY-MM-DD */
  end: string;
  score: number;
  level: LoadLevel;
  exams: number;
  deadlines: number;
  events: LoadEvent[];
}

export function loadLevel(score: number): LoadLevel {
  if (score >= 5) return 'critical'; // an exam and a deadline, or more
  if (score >= 3) return 'busy'; // an exam, or a deadline and something else
  return score > 0 ? 'light' : 'none';
}

/** Monday of the week of `iso`. */
export function weekStart(iso: string): string {
  const day = parseIso(iso);
  if (!day) throw new Error(`Fecha no válida: ${iso}`);
  const weekday = (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7; // Monday = 0
  return toIso(addDays(day, -weekday));
}

/** `weeks` consecutive weeks from the one holding `from`; dismissed and undated events do not count. */
export function weeklyLoad(events: LoadEvent[], from: string, weeks: number): WeekLoad[] {
  const first = parseIso(weekStart(from))!;
  const out: WeekLoad[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = toIso(addDays(first, i * 7));
    const end = toIso(addDays(first, i * 7 + 6));
    const mine = events.filter((e) => e.date && !e.dismissed && e.date >= start && e.date <= end && (LOAD_WEIGHT[e.kind] ?? 1) > 0);
    const score = mine.reduce((acc, e) => acc + (LOAD_WEIGHT[e.kind] ?? 1), 0);
    out.push({
      start,
      end,
      score,
      level: loadLevel(score),
      exams: mine.filter((e) => e.kind === 'exam').length,
      deadlines: mine.filter((e) => e.kind === 'deadline').length,
      events: mine.sort((a, b) => a.date!.localeCompare(b.date!)),
    });
  }
  return out;
}

/** "2 exámenes y 1 entrega", the way Inicio announces a critical week. */
export function describeWeek(week: Pick<WeekLoad, 'exams' | 'deadlines' | 'events'>): string {
  const parts: string[] = [];
  if (week.exams) parts.push(`${week.exams} ${week.exams === 1 ? 'examen' : 'exámenes'}`);
  if (week.deadlines) parts.push(`${week.deadlines} ${week.deadlines === 1 ? 'entrega' : 'entregas'}`);
  const other = week.events.length - week.exams - week.deadlines;
  if (other) parts.push(`${other} ${other === 1 ? 'evento más' : 'eventos más'}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0] ?? 'nada';
}
