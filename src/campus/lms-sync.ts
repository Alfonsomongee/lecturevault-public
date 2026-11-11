/**
 * Fetch the university calendar (the .ics feed of the campus) and turn it into events for the database.
 * Shared by the dashboard (every 6 h while it runs) and the nightly cloud agent. The URL carries a personal
 * token: it is never logged, stored in a result or put in an error message.
 */

import { lmsEvents } from './lms-calendar.js';
import { CourseCatalog, courseLabel } from '../library/courses.js';
import type { LmsEventInput } from '../database/CampusRepository.js';

export interface LmsFeed {
  items: LmsEventInput[];
  total: number;
  skipped: number;
  /** Courses of the feed that are not in the catalog yet (code → name as the campus writes it) */
  unknown: Map<string, string>;
}

export async function fetchLmsFeed(url: string, dataDir: string): Promise<LmsFeed> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'text/calendar' } });
  if (!res.ok) throw new Error(`el campus respondió ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('la dirección no devuelve un calendario (¿token caducado?)');
  const { events, skipped } = lmsEvents(text);
  const catalog = new Map(CourseCatalog.load(dataDir).courses.map((c) => [c.code.toUpperCase(), courseLabel(c)]));
  const unknown = new Map<string, string>();
  const items = events.map((e) => {
    if (!catalog.has(e.code)) unknown.set(e.code, e.courseName);
    return { uid: e.uid, course: catalog.get(e.code) ?? `${e.code} ${e.courseName}`.trim(), kind: e.kind, title: e.title, date: e.date, time: e.time };
  });
  return { items, total: events.length, skipped, unknown };
}
