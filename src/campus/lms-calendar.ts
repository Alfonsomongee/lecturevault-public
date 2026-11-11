/**
 * The university's own calendar (an .ics feed from the campus, e.g. oncampus.universidadviu.com/events/ics):
 * the official class timetable, deadlines and exam sittings. Parsing and classification are pure; the sync
 * itself lives in CampusRepository.syncLmsEvents.
 *
 * What a VIU feed looks like:
 * - one event per class from the timetable, titled with the module ("04MUIN_10_A_2026-27_Tecnología …") and
 *   "Instructor: …" in the description, sometimes repeated as "SESIÓN 04 MUIN" from Blackboard;
 * - deadlines from Blackboard at 23:59 ("Proyecto parte 1. …"), with the module in the description;
 * - exam sittings as all-day events at 00:00 ("Examen 1ª Convocatoria 03MUIN", "Franja 1: 12:00 …");
 * - institutional events ("VIU_Seminario Online: …") with no course: they are left out.
 */

import type { EventKind } from '../database/CampusRepository.js';

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  /** YYYY-MM-DD in local time */
  date: string;
  /** HH:MM, or null for an all-day event */
  time: string | null;
}

export interface LmsEvent {
  uid: string;
  /** Course code, e.g. "04MUIN" */
  code: string;
  /** Course name as the campus writes it, for courses not in the catalog yet */
  courseName: string;
  kind: EventKind;
  title: string;
  date: string;
  time: string | null;
}

/**
 * A feed that suddenly empties or loses most of what the university had published is far more likely to
 * be a broken response (wrong token, a half-served page) than a real change, so nothing is deleted then.
 * `owned` = events that came from the university before, `stale` = those the new feed no longer lists.
 */
export function suspiciousRemoval(feedSize: number, owned: number, stale: number): boolean {
  if (stale === 0) return false;
  return feedSize === 0 || stale * 2 > owned;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** DTSTART value → local date and time. UTC values (…Z) are shown in this machine's time zone. */
function parseStamp(value: string, isDate: boolean): { date: string; time: string | null } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (isDate || h === undefined) return { date: `${y}-${mo}-${d}`, time: null };
  if (z) {
    const dt = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!));
    return { date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`, time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}` };
  }
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

/** Every VEVENT with a start. Folded lines are joined and text is unescaped. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: IcsEvent[] = [];
  let current: Record<string, string> | null = null;
  let dateOnly = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; dateOnly = false; continue; }
    if (line === 'END:VEVENT') {
      const start = current?.['DTSTART'] ? parseStamp(current['DTSTART'], dateOnly) : null;
      if (current && start) {
        out.push({ uid: current['UID'] ?? '', summary: unescapeText(current['SUMMARY'] ?? '').trim(), description: unescapeText(current['DESCRIPTION'] ?? '').trim(), ...start });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    if (name === 'DTSTART' && params.some((p) => p.toUpperCase() === 'VALUE=DATE')) dateOnly = true;
    if (name && !(name in current)) current[name.toUpperCase()] = line.slice(colon + 1);
  }
  return out;
}

// Not \b: in "04MUIN_10_A" the code is followed by "_", a word character
const CODE = /(?<![\dA-Za-z])(\d{2})\s?MUIN(?![A-Za-z])/;
/** "04MUIN_10_A_2026-27_Tecnología electrónica e instrumentación" → the name after the fourth "_" */
const MODULE = /(\d{2}MUIN)_[^_\s]+_[^_\s]+_[^_\s]+_\s*([^\n]+)/;

/** Course code and name of an event; null for institutional events with no course. */
function courseOf(ev: IcsEvent): { code: string; name: string } | null {
  const text = `${ev.summary}\n${ev.description}`;
  const code = CODE.exec(text);
  if (!code) return null;
  const module = MODULE.exec(text);
  const name = module && module[1] === `${code[1]}MUIN` ? module[2]!.replace(/^CF\s*-\s*/i, '').trim() : '';
  return { code: `${code[1]}MUIN`, name };
}

/** "Instructor: Ana Pérez Lara" */
function instructorOf(description: string): string {
  return /Instructor:\s*([^\n]+)/.exec(description)?.[1]?.trim() ?? '';
}

/** Leading emoji and symbols ("✨ ¡Conócete…") */
const stripSymbols = (s: string) => s.replace(/^[^\p{L}\p{N}¡¿"«(]+/u, '').trim();

export function classifyLmsEvent(ev: IcsEvent): LmsEvent | null {
  const course = courseOf(ev);
  if (!course || !ev.uid) return null;
  const summary = ev.summary.replace(/\s+/g, ' ').trim();
  const base = { uid: ev.uid, code: course.code, courseName: course.name, date: ev.date };
  const isModuleTitle = MODULE.test(summary) || /^\d{4}_\d+_\w_\d+:/.test(summary);

  if (/\bexamen\b/i.test(summary)) {
    return { ...base, kind: 'exam', title: summary, time: ev.time === '00:00' ? null : ev.time };
  }
  if (/^pr[aá]ctica\b.*\bgrupo\b/i.test(summary)) return { ...base, kind: 'lab', title: summary, time: ev.time };
  // A class from the timetable: titled with the module, or "SESIÓN 04 MUIN", or a named session
  if (isModuleTitle || /^sesi[oó]n\b/i.test(summary) || /Instructor:/.test(ev.description)) {
    const named = !isModuleTitle && !/^sesi[oó]n\s+\d{2}\s?MUIN$/i.test(summary);
    const teacher = instructorOf(ev.description);
    return { ...base, kind: 'session', title: named ? summary : `Clase${teacher ? ` (${teacher})` : ''}`, time: ev.time };
  }
  const title = stripSymbols(summary) || summary;
  // Blackboard deadlines close at 23:59; a welcome forum with an emoji is not one
  if (ev.time !== null && ev.time >= '23:50' && title === summary) return { ...base, kind: 'deadline', title, time: ev.time };
  return { ...base, kind: 'other', title, time: ev.time === '00:00' ? null : ev.time };
}

/** A session's own title beats "Clase (teacher)", which beats a bare "Clase". */
const titleRank = (title: string) => (!title.startsWith('Clase') ? 2 : title.includes('(') ? 1 : 0);

/**
 * The events worth importing: classified, and one per class (the timetable and Blackboard often list the
 * same session twice). Of two at the same course, kind, day and hour, the more descriptive title wins.
 */
export function lmsEvents(text: string): { events: LmsEvent[]; skipped: number } {
  const all = parseIcs(text);
  const kept = new Map<string, LmsEvent>();
  let skipped = 0;
  for (const ev of all) {
    const e = classifyLmsEvent(ev);
    if (!e) { skipped++; continue; }
    // Only a class is listed twice; two deadlines closing at the same minute are two deadlines
    const key = `${e.code}|${e.kind}|${e.date}|${e.time ?? ''}${e.kind === 'session' ? '' : `|${e.title}`}`;
    const prev = kept.get(key);
    if (!prev) { kept.set(key, e); continue; }
    // The smaller uid of the pair, whatever the feed order, so the next sync recognises the event
    const uid = [prev.uid, e.uid].sort()[0]!;
    kept.set(key, { ...(titleRank(e.title) > titleRank(prev.title) ? e : prev), uid });
  }
  return { events: [...kept.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '')), skipped };
}

const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Teacher and weekly schedule of a course as the university publishes them. A teacher heard in class gets
 * misspelled ("Pérez Lara") and a spoken schedule comes out garbled; the timetable has neither problem.
 * `sessions` are the course's `session` events (title "Clase (Nombre)", or a named session).
 */
export function officialTimetable(sessions: Array<{ date: string; time: string | null; title: string }>): { teacher: string; schedule: string } {
  const teachers = new Map<string, number>();
  const days = new Set<number>();
  const times = new Set<string>();
  for (const s of sessions) {
    const name = /^Clase \((.+)\)$/.exec(s.title)?.[1]?.trim();
    if (name) teachers.set(name, (teachers.get(name) ?? 0) + 1);
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date);
    if (!d) continue;
    days.add(new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)).getUTCDay());
    if (s.time) times.add(s.time);
  }
  const teacher = [...teachers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.has(d)).map((d) => WEEKDAY_NAMES[d]!);
  const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items[0] ?? '');
  const when = list(order);
  const hours = list([...times].sort());
  const schedule = when ? `${when[0]!.toUpperCase()}${when.slice(1)}${hours ? `, ${hours}` : ''}` : '';
  return { teacher, schedule };
}
