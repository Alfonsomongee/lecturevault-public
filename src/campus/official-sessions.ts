/**
 * What the university calls each class (pure, testable).
 *
 * Every night the daily agent reads the Collaborate table of each subject: "Sesión 3. Tema 2: Contabilidad
 * Financiera…", listed on 2 November. That is the authority on when the class was, which session it was and
 * which topic it covered, and it beats anything inferred later (the day a local capture was transcribed, or a
 * topic the AI guessed). The agent keeps that listing in daily-state.json (the only memory a cloud run has),
 * and these functions turn it into updates for the student's database.
 */

import type { DailyStateEntry } from './daily-state.js';
import { extractRecordingPart, extractSessionNumber } from './daily-matcher.js';
import { sentenceCase } from './analysis.js';
import { contentTokens } from '../study/grounding.js';
import type { SyllabusEntry } from '../database/CampusRepository.js';

export interface OfficialTitle {
  session: number | null;
  /** recording_1, recording_2… when a session was recorded in several parts */
  part: number | null;
  topicNumber: number | null;
  topicName: string | null;
}

const RECORDING_SUFFIX = /[\s./-]*recording[\s_-]*\d+\s*$/i;

/** The campus title without the "/recording_N" Collaborate appends. */
export function cleanOfficialTitle(title: string): string {
  return title.replace(RECORDING_SUFFIX, '').replace(/\s+/g, ' ').trim();
}

/** "Sesión 3. Tema 2: Contabilidad Financiera. Estructura…/recording_1" → session 3, part 1, topic 2 "Contabilidad Financiera". */
export function parseOfficialTitle(title: string): OfficialTitle {
  const clean = cleanOfficialTitle(title);
  const topic = /\btema\s*(\d{1,2})(?:\s*[,y]\s*\d{1,2})*\s*[.:]?\s*(.*)$/i.exec(clean);
  let topicName: string | null = null;
  if (topic) {
    const firstSentence = (topic[2] ?? '').split(/\.(?:\s|$)/)[0]!.replace(/[\s.:;,-]+$/, '').trim();
    topicName = firstSentence.length >= 3 ? firstSentence : null;
  }
  return {
    session: extractSessionNumber(title),
    part: extractRecordingPart(title),
    topicNumber: topic ? Number(topic[1]) : null,
    topicName,
  };
}

/** "Tema N. Name", with the syllabus wording of block N when the course sheet has it. */
export function officialTopicLabel(parsed: Pick<OfficialTitle, 'topicNumber' | 'topicName'>, syllabus: SyllabusEntry[]): string | null {
  if (parsed.topicNumber === null) return null;
  // The syllabus wording of block N only when the campus' own name does not contradict it: in 02MUIN the
  // sessions' "Tema 1" is structural analysis while the guide's block 1 is "Conceptos de diseño de máquinas"
  const candidate = syllabus.find((s) => s.n === parsed.topicNumber);
  const own = new Set(contentTokens(parsed.topicName ?? ''));
  const block = candidate && (own.size === 0 || contentTokens(candidate.title).some((w) => own.has(w))) ? candidate : undefined;
  const name = block ? sentenceCase(block.title) : parsed.topicName ? sentenceCase(parsed.topicName) : '';
  return name ? `Tema ${parsed.topicNumber}. ${name}` : `Tema ${parsed.topicNumber}`;
}

const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar day (YYYY-MM-DD) of an instant in Madrid: a class at 00:30 is that day, not the UTC one before. */
export function madridDay(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : MADRID_DAY.format(new Date(t));
}

export interface OfficialRow {
  id: number;
  collab_id: string;
  transcript_id: string | null;
  course: string | null;
  class_date: string | null;
  /** 'user' when the student set the date by hand: the campus does not overwrite it */
  class_date_source?: string | null;
  official_title: string | null;
  session_number: number | null;
  session_part: number | null;
  official_topic: string | null;
}

export interface OfficialUpdate {
  id: number;
  classDate: string | null;
  sessionNumber: number | null;
  sessionPart: number | null;
  officialTitle: string;
  officialTopic: string | null;
}

/** The entry (with a campus listing) that describes this class, matched by id or by transcript folder. */
function entryFor(row: OfficialRow, entries: DailyStateEntry[]): DailyStateEntry | undefined {
  return entries.find(
    (e) =>
      e.official &&
      e.course === row.course &&
      (e.collabId === row.collab_id || (Boolean(e.transcriptId) && e.transcriptId === row.transcript_id))
  );
}

/** Updates needed so each class carries what the campus says about it. Only rows that change are listed. */
export function planOfficialUpdates(
  rows: OfficialRow[],
  entries: DailyStateEntry[],
  syllabusByCourse: Map<string, SyllabusEntry[]>
): OfficialUpdate[] {
  const plan: OfficialUpdate[] = [];
  for (const row of rows) {
    if (!row.course) continue;
    const entry = entryFor(row, entries);
    if (!entry?.official) continue;
    const parsed = parseOfficialTitle(entry.official.title);
    const officialDay = madridDay(entry.official.createdAt);
    const update: OfficialUpdate = {
      id: row.id,
      classDate: row.class_date_source === 'user' ? row.class_date : officialDay ?? row.class_date,
      sessionNumber: parsed.session,
      sessionPart: parsed.part,
      officialTitle: cleanOfficialTitle(entry.official.title),
      officialTopic: officialTopicLabel(parsed, syllabusByCourse.get(row.course) ?? []),
    };
    const same =
      update.classDate === row.class_date &&
      update.sessionNumber === row.session_number &&
      update.sessionPart === row.session_part &&
      update.officialTitle === row.official_title &&
      update.officialTopic === row.official_topic;
    if (!same) plan.push(update);
  }
  return plan;
}
