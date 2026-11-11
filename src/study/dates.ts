/**
 * Deterministic Spanish date handling for deadline alerts.
 *
 * Teachers say "hasta el día 20", "el 3 de abril", "el lunes", "mañana". The LLM proposes an
 * ISO date, but we never trust it blindly: it must be a real calendar date close to the class
 * date, and when the model gives only the phrase we resolve it here against the class date.
 * All math is on calendar dates (UTC midnight) so time zones and DST can't shift a day.
 */

import { fold } from '../utils/text.js';

export const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const DAY_MS = 86_400_000;

export interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number;
}

export function toIso(date: CalendarDate): string {
  return `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

function toUtc(date: CalendarDate): number {
  return Date.UTC(date.y, date.m - 1, date.d);
}

function fromUtc(ms: number): CalendarDate {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function isValidDate({ y, m, d }: CalendarDate): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseIso(iso: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const date = { y: +match[1]!, m: +match[2]!, d: +match[3]! };
  return isValidDate(date) ? date : null;
}

/** Calendar date of an instant in the machine's local time zone (the student's). */
export function localCalendarDate(value: string | Date): CalendarDate {
  const dt = value instanceof Date ? value : new Date(value);
  const safe = Number.isNaN(dt.getTime()) ? new Date() : dt;
  return { y: safe.getFullYear(), m: safe.getMonth() + 1, d: safe.getDate() };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

export function weekdayName(date: CalendarDate): string {
  const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return names[new Date(toUtc(date)).getUTCDay()]!;
}

export interface ResolvedDate {
  date: string;
  confidence: 'high' | 'medium';
}

export interface ResolveOptions {
  /**
   * False when the class date is only an approximation (an imported transcript dated by the day it
   * was transcribed). Dates further back are then accepted and nothing is resolved with "high".
   */
  classDateConfirmed?: boolean;
}

/** Words that may follow "el 20 de …" without being a month ("el 20 de este mes"). */
const NOT_A_MONTH = new Set(['este', 'esta', 'ese', 'esa', 'aquel', 'cada', 'dicho', 'mes']);

/**
 * Resolve a spoken date phrase against the class date. Returns null when the phrase is
 * ambiguous ("la semana que viene", "pronto") so a human decides instead of guessing.
 */
export function resolveDateText(text: string, classDate: CalendarDate, options: ResolveOptions = {}): ResolvedDate | null {
  const t = fold(text);
  const classMs = toUtc(classDate);
  const confirmed = options.classDateConfirmed ?? true;
  const pastDays = confirmed ? 7 : 60;
  const sure = (date: string): ResolvedDate => ({ date, confidence: confirmed ? 'high' : 'medium' });

  // "20 de marzo", "20 de marzo de 2027"
  const named = /\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?/.exec(t);
  if (named && MONTHS[named[2]!]) {
    const d = +named[1]!;
    const m = MONTHS[named[2]!]!;
    if (named[3]) {
      const date = { y: +named[3], m, d };
      if (!isValidDate(date)) return null;
      // A year already gone ("26 de febrero de 2017" said in 2026) is a slip of the tongue: the next such day is used, unsure
      const delta = (toUtc(date) - classMs) / DAY_MS;
      if (delta >= -pastDays) return { date: toIso(date), confidence: 'high' };
      let next = { y: classDate.y, m, d };
      if (toUtc(next) < classMs - pastDays * DAY_MS) next = { y: classDate.y + 1, m, d };
      return isValidDate(next) ? { date: toIso(next), confidence: 'medium' } : null;
    }
    let date = { y: classDate.y, m, d };
    if (!isValidDate(date)) return null;
    // no year spoken: a date clearly in the past means next year
    if (toUtc(date) < classMs - pastDays * DAY_MS) date = { y: classDate.y + 1, m, d };
    return isValidDate(date) ? sure(toIso(date)) : null;
  }
  // "el 9 de encierne": a month was said but misheard; guessing one from the day alone is worse
  if (named && named[2]!.length >= 4 && !NOT_A_MONTH.has(named[2]!)) return null;

  if (/\bpasado manana\b/.test(t)) return sure(toIso(addDays(classDate, 2)));
  if (/\bmanana\b/.test(t)) return sure(toIso(addDays(classDate, 1)));

  // "el lunes", "para el viernes" → next such weekday after the class
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const classDow = new Date(classMs).getUTCDay();
      const delta = ((i - classDow + 7) % 7) || 7;
      return { date: toIso(addDays(classDate, delta)), confidence: 'medium' };
    }
  }

  // "el día 20", "día 5", "hasta el 20": day of month only
  const dayOnly = /\b(?:dia|el)\s+(\d{1,2})\b/.exec(t);
  if (dayOnly) {
    const d = +dayOnly[1]!;
    for (let offset = 0; offset < 14; offset++) {
      const month0 = classDate.m - 1 + offset;
      const candidate = { y: classDate.y + Math.floor(month0 / 12), m: (month0 % 12) + 1, d };
      if (isValidDate(candidate) && toUtc(candidate) >= classMs) {
        return { date: toIso(candidate), confidence: 'medium' };
      }
    }
  }

  return null;
}

/** Accept a model-provided ISO date only if it is a real date near the class date. */
export function sanitizeDueDate(
  iso: string | null | undefined,
  classDate: CalendarDate,
  options: ResolveOptions = {}
): string | null {
  if (!iso) return null;
  const parsed = parseIso(iso);
  if (!parsed) return null;
  const delta = (toUtc(parsed) - toUtc(classDate)) / DAY_MS;
  const pastDays = (options.classDateConfirmed ?? true) ? 2 : 60;
  return delta >= -pastDays && delta <= 550 ? toIso(parsed) : null;
}

/**
 * True when `text` really says the day of `iso`: its day number is spoken and any month named is
 * the right one. Relative phrases ("mañana", "el lunes") count, since they are resolved from the
 * class date rather than copied. Stops the model from filling in a day nobody said.
 */
export function isDateBacked(iso: string, text: string): boolean {
  const date = parseIso(iso);
  if (!date) return false;
  const t = fold(text);
  if (/\bmanana\b/.test(t) || WEEKDAYS.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return true;
  if (!new RegExp(`\\b0?${date.d}\\b`).test(t)) return false;
  const named = Object.entries(MONTHS).filter(([name]) => new RegExp(`\\b${name}\\b`).test(t));
  return named.length === 0 || named.some(([, m]) => m === date.m);
}
