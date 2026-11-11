/**
 * Persistence for the course-centric campus: course profile (fixed sheet), grading, deliverables,
 * exams, calendar events, mentions, note sections, AI key moments and the review inbox (proposals).
 *
 * Shares the DatabaseManager connection. The same rule as StudyRepository applies: AI output can be
 * regenerated at will, but anything the user decided (source = 'user', confirmed, dismissed, a locked
 * profile, title_source = 'user') survives it. When the AI wants to change something the user owns,
 * it leaves a proposal in the inbox instead of writing it.
 */

import type Database from 'better-sqlite3';
import type { SessionKind } from '../types.js';
import type { Confidence } from './StudyRepository.js';
import { foldWs } from '../utils/text.js';
import { officialTimetable, suspiciousRemoval } from '../campus/lms-calendar.js';
import { parseIso, resolveDateText } from '../study/dates.js';
import {
  classTitle, cleanSchedule, cleanTeacher, isExamSitting, isMislabelledAdmin, isOpeningEvent, isPlaceholderText, isRealSyllabusTitle,
  findSyllabusBlock, isNextSessionNoise, isRepeatedEvent, sameCalendarThing, sameEntityTitle, sentenceCase, shortSyllabusTitle, syllabusLabel, type AnalysisEvent, type SessionAnalysis,
} from '../campus/analysis.js';
import { planOfficialUpdates, type OfficialRow } from '../campus/official-sessions.js';
import type { DailyStateEntry } from '../campus/daily-state.js';

/** 'lms': imported from the university calendar (see syncLmsEvents) */
export type Source = 'ai' | 'user' | 'lms';
export type EventKind = 'exam' | 'deadline' | 'session' | 'lab' | 'other';
export type EntityType = 'deliverable' | 'exam' | 'course';
export type MentionKind = 'requirement' | 'syllabus' | 'format' | 'date' | 'tip' | 'grading';
export type NoteDestination = 'theory' | 'deliverable' | 'exam' | 'course_info' | 'admin';
export type DeliverableStatus = 'todo' | 'doing' | 'done';
export type ProposalStatus = 'open' | 'accepted' | 'rejected';

export interface TaskInput {
  text: string;
  quote?: string;
  t_ms: number;
}

export interface TaskRow {
  id: number;
  course: string;
  recording_id: number;
  text: string;
  quote: string;
  t_ms: number;
  done: number;
  dismissed: number;
  created_at: string;
  recording_title: string;
  class_number: number | null;
}

export interface RepairReport {
  profiles: number;
  formats: number;
  exams: number;
  events: number;
  /** Long "logistics" ranges that were really class content and went back to theory (their notes are written next) */
  sections: number;
}

/** Where something was said: recording + minute + literal quote */
export interface Evidence {
  recording_id?: number | null;
  t_ms?: number;
  quote?: string;
}

// ── Profile ───────────────────────────────────────────────────────────────

export interface SyllabusEntry {
  n: number;
  title: string;
}

export interface CourseProfileInput {
  overview_md?: string;
  teacher?: string;
  schedule?: string;
  syllabus?: SyllabusEntry[];
  pass_rules?: string;
  resources?: string[];
}

export interface CourseProfile extends Required<CourseProfileInput> {
  course: string;
  source_recording_id: number | null;
  locked: number;
  updated_at: string;
}

const TEXT_FIELDS = ['overview_md', 'teacher', 'schedule', 'pass_rules'] as const;
const PROFILE_FIELDS = [...TEXT_FIELDS, 'syllabus', 'resources'] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface ApplyProfileResult {
  action: 'created' | 'updated' | 'proposed' | 'unchanged';
  proposals: number;
}

// ── Grading ───────────────────────────────────────────────────────────────

export interface GradingInput extends Evidence {
  name: string;
  weight_pct?: number | null;
  /** Name of the parent item ("Foro 1" ⊂ "Proyecto parte 1") */
  parent?: string;
  min_grade?: number | null;
  deliverable_id?: number | null;
  exam_id?: number | null;
}

export interface GradingRow {
  id: number;
  course: string;
  name: string;
  weight_pct: number | null;
  parent_id: number | null;
  min_grade: number | null;
  deliverable_id: number | null;
  exam_id: number | null;
  quote: string;
  recording_id: number | null;
  t_ms: number;
  source: Source;
}

// ── Deliverables and exams ────────────────────────────────────────────────

export interface DeliverableInput {
  key: string;
  title: string;
  description?: string;
  format?: string;
  group_size?: string;
  weight_pct?: number | null;
}

export interface DeliverableRow extends Required<DeliverableInput> {
  id: number;
  course: string;
  weight_pct: number | null;
  status: DeliverableStatus;
  source: Source;
}

export interface ExamInput {
  key: string;
  title: string;
  format?: string;
  weight_pct?: number | null;
}

export interface ExamRow extends Required<ExamInput> {
  id: number;
  course: string;
  weight_pct: number | null;
  source: Source;
}

// ── Events ────────────────────────────────────────────────────────────────

export interface EventInput extends Evidence {
  kind: EventKind;
  title: string;
  date?: string | null;
  time?: string | null;
  deliverable_id?: number | null;
  exam_id?: number | null;
  date_text?: string;
  confidence?: Confidence;
}

export interface EventRow {
  id: number;
  course: string;
  kind: EventKind;
  title: string;
  date: string | null;
  time: string | null;
  deliverable_id: number | null;
  exam_id: number | null;
  recording_id: number | null;
  t_ms: number;
  quote: string;
  date_text: string;
  confidence: Confidence;
  confirmed: number;
  dismissed: number;
  source: Source;
  created_at: string;
  external_uid?: string | null;
  recording_title?: string | null;
}

/** An event of the university calendar, already classified and given its course label. */
export interface LmsEventInput {
  uid: string;
  course: string;
  kind: EventKind;
  title: string;
  date: string;
  time: string | null;
}

export interface LmsSyncResult {
  added: number;
  updated: number;
  /** AI or manual events the university confirmed (same course, kind and day) */
  matched: number;
  removed: number;
  /** Events the feed no longer lists but were kept because the feed looked broken (see suspiciousRemoval) */
  held: number;
}

export interface EventPatch {
  kind?: EventKind;
  title?: string;
  date?: string | null;
  time?: string | null;
  confirmed?: boolean;
  dismissed?: boolean;
}

// ── Mentions, note sections, key moments ──────────────────────────────────

export interface MentionInput {
  entity_type: EntityType;
  entity_id: number;
  kind: MentionKind;
  text: string;
  quote?: string;
  t_ms: number;
  confidence?: Confidence;
}

export interface MentionRow extends Required<MentionInput> {
  id: number;
  recording_id: number;
  dismissed: number;
  recording_title?: string;
  class_number?: number | null;
}

export interface NoteSectionInput {
  destination: NoteDestination;
  entity_id?: number | null;
  heading: string;
  markdown: string;
  /** One sentence on what the range is about (feeds the class summary) */
  gist?: string;
  start_ms: number;
  end_ms: number;
}

export interface NoteSectionRow extends Required<NoteSectionInput> {
  id: number;
  recording_id: number;
  ord: number;
  entity_id: number | null;
  /** Model that wrote the notes ('' when unknown or not written yet) */
  model: string;
}

export interface HighlightInput {
  t_ms: number;
  text: string;
  why?: string;
}

// ── Proposals ─────────────────────────────────────────────────────────────

export interface ProposalInput extends Evidence {
  course: string;
  /** 'profile.<field>', 'profile.grading', 'event:<id>.date' … */
  target: string;
  current_value?: string | null;
  proposed_value: string;
}

export interface ProposalRow {
  id: number;
  course: string;
  target: string;
  current_value: string | null;
  proposed_value: string;
  recording_id: number | null;
  t_ms: number;
  quote: string;
  status: ProposalStatus;
  created_at: string;
}

export interface ApplyAnalysisReport {
  /** Title shown for the class after routing (the user's one if they wrote it) */
  title: string | null;
  class_number: number | null;
  session_kind: SessionKind;
  profile: ApplyProfileResult['action'] | 'skipped';
  deliverables: number;
  exams: number;
  events: number;
  mentions: number;
  sections: number;
  highlights: number;
  /** New items in the review inbox */
  proposals: number;
  skipped: string[];
}

/** A regenerated item this close to one the user already decided on is the same item. */
const SAME_MOMENT_MS = 20_000;

export class CampusRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Recordings: campus title, number and analysis ───────────────────────

  /** Set the campus title. The AI never overwrites a title the user wrote. Returns whether it changed. */
  setDisplayTitle(recordingId: number, title: string, source: Source): boolean {
    const guard = source === 'ai' ? " AND title_source != 'user'" : '';
    return (
      this.db
        .prepare(`UPDATE recordings SET display_title = ?, title_source = ? WHERE id = ?${guard}`)
        .run(title.trim(), source, recordingId).changes > 0
    );
  }

  /** The student fixes the number by hand; the "Clase N." prefix of the title follows it. */
  setClassNumber(recordingId: number, classNumber: number | null): void {
    const run = this.db.transaction(() => {
      this.db.prepare('UPDATE recordings SET class_number = ? WHERE id = ?').run(classNumber, recordingId);
      if (classNumber) {
        this.db
          .prepare(
            `UPDATE recordings SET display_title = ? || substr(display_title, instr(display_title, '. ') + 2)
             WHERE id = ? AND display_title LIKE 'Clase %. %'`
          )
          .run(`Clase ${classNumber}. `, recordingId);
      }
    });
    run();
  }

  /** The AI's topic, unless the campus title already named one (the campus wins: official-sessions.ts). */
  setSessionAnalysis(recordingId: number, analysis: { session_kind: SessionKind | null; topic?: string; analysis_version: string }): void {
    this.db
      .prepare(
        `UPDATE recordings SET session_kind = ?, analysis_version = ?,
           topic = CASE WHEN COALESCE(official_topic, '') != '' THEN official_topic ELSE ? END
         WHERE id = ?`
      )
      .run(analysis.session_kind, analysis.analysis_version, analysis.topic ?? '', recordingId);
  }

  /**
   * Number the classes of a course by class day (Clase 1, 2, …) and keep the "Clase N." prefix of
   * AI titles in step. The parts of one campus session (recording_1, recording_2) share a number, so
   * "Clase N" is the campus "Sesión N". Recordings without a course are not numbered. Returns how many were numbered.
   */
  renumberClasses(course: string): number {
    if (!course) return 0;
    const rows = this.db
      .prepare(
        `SELECT id, session_number FROM recordings WHERE course = ?
         ORDER BY COALESCE(class_date, substr(created_at, 1, 10)), session_number, session_part, created_at, id`
      )
      .all(course) as { id: number; session_number: number | null }[];
    const setNumber = this.db.prepare('UPDATE recordings SET class_number = ? WHERE id = ?');
    const fixTitle = this.db.prepare(
      `UPDATE recordings SET display_title = ? || substr(display_title, instr(display_title, '. ') + 2)
       WHERE id = ? AND title_source = 'ai' AND display_title LIKE 'Clase %. %'`
    );
    const run = this.db.transaction(() => {
      const bySession = new Map<number, number>();
      let next = 0;
      for (const row of rows) {
        let n: number;
        if (row.session_number !== null && bySession.has(row.session_number)) n = bySession.get(row.session_number)!;
        else {
          n = ++next;
          if (row.session_number !== null) bySession.set(row.session_number, n);
        }
        setNumber.run(n, row.id);
        fixTitle.run(`Clase ${n}. `, row.id);
      }
    });
    run();
    return rows.length;
  }

  /**
   * Writes what the campus says about each class (date, session, part, title, topic) from the daily agent's
   * memory and renumbers the courses that changed. Idempotent. Returns how many classes changed.
   */
  applyOfficialSessions(entries: DailyStateEntry[]): number {
    const rows = this.db
      .prepare(
        `SELECT id, collab_id, transcript_id, course, class_date, class_date_source, official_title, session_number,
                session_part, official_topic
         FROM recordings WHERE COALESCE(course, '') != ''`
      )
      .all() as OfficialRow[];
    const syllabus = new Map<string, NonNullable<ReturnType<CampusRepository['getProfile']>>['syllabus']>();
    for (const course of new Set(rows.map((r) => r.course!))) syllabus.set(course, this.getProfile(course)?.syllabus ?? []);
    const plan = planOfficialUpdates(rows, entries, syllabus);
    if (plan.length === 0) return 0;

    const update = this.db.prepare(
      `UPDATE recordings SET class_date = ?, session_number = ?, session_part = ?, official_title = ?, official_topic = ?,
         topic = CASE WHEN ? IS NOT NULL THEN ? ELSE topic END
       WHERE id = ?`
    );
    const courses = new Set<string>();
    const run = this.db.transaction(() => {
      for (const u of plan) {
        update.run(u.classDate, u.sessionNumber, u.sessionPart, u.officialTitle, u.officialTopic, u.officialTopic, u.officialTopic, u.id);
        courses.add(rows.find((r) => r.id === u.id)!.course!);
      }
      for (const course of courses) this.renumberClasses(course);
    });
    run();
    return plan.length;
  }

  // ── Course profile ──────────────────────────────────────────────────────

  getProfile(course: string): CourseProfile | undefined {
    const row = this.db.prepare('SELECT * FROM course_profiles WHERE course = ?').get(course) as
      | (Omit<CourseProfile, 'syllabus' | 'resources'> & { syllabus_json: string; resources_json: string })
      | undefined;
    if (!row) return undefined;
    const { syllabus_json, resources_json, ...rest } = row;
    return { ...rest, syllabus: parseJsonArray(syllabus_json), resources: parseJsonArray(resources_json) };
  }

  /**
   * Teacher and schedule from the university's timetable, for the courses that already have a sheet. A locked
   * sheet is the student's own and is left alone. Returns how many fields changed.
   */
  applyOfficialTimetable(): number {
    let changed = 0;
    const courses = this.db.prepare('SELECT course FROM course_profiles WHERE locked = 0').all() as { course: string }[];
    const run = this.db.transaction(() => {
      for (const { course } of courses) {
        const sessions = this.db
          .prepare("SELECT date, time, title FROM events WHERE course = ? AND source = 'lms' AND kind = 'session' AND dismissed = 0")
          .all(course) as { date: string; time: string | null; title: string }[];
        if (sessions.length === 0) continue;
        const official = officialTimetable(sessions);
        const current = this.getProfile(course);
        for (const field of ['teacher', 'schedule'] as const) {
          if (official[field] && official[field] !== (current?.[field] ?? '')) {
            this.writeProfileField(course, field, official[field]);
            changed++;
          }
        }
      }
    });
    run();
    return changed;
  }

  /** A user edit: writes the given fields whether or not the profile is locked. */
  saveProfile(course: string, input: CourseProfileInput, sourceRecordingId?: number | null): CourseProfile {
    const run = this.db.transaction(() => {
      this.ensureProfile(course, sourceRecordingId ?? null);
      for (const field of PROFILE_FIELDS) {
        if (input[field] !== undefined) this.writeProfileField(course, field, input[field]!);
      }
    });
    run();
    return this.getProfile(course)!;
  }

  setProfileLocked(course: string, locked: boolean): boolean {
    return this.db.prepare('UPDATE course_profiles SET locked = ? WHERE course = ?').run(locked ? 1 : 0, course).changes > 0;
  }

  /**
   * Route AI course info: create the profile if missing, fill it while unlocked, and once locked turn
   * every differing field into a proposal. Empty AI values never erase anything. While unlocked, a
   * later class only fills gaps: passing remarks must not replace what the presentation class said.
   */
  applyAiProfile(course: string, input: CourseProfileInput, evidence: Evidence = {}): ApplyProfileResult {
    let result: ApplyProfileResult = { action: 'unchanged', proposals: 0 };
    const run = this.db.transaction(() => {
      const existing = this.getProfile(course);
      // The class that gave the sheet, or one that came before it (a presentation recorded late must correct the
      // sheet a later class filled in first)
      const fromSource = !existing?.source_recording_id || !evidence.recording_id || existing.source_recording_id === evidence.recording_id
        || this.cameBefore(evidence.recording_id, existing.source_recording_id);
      const changed = PROFILE_FIELDS.filter((field) => {
        const value = input[field];
        if (value === undefined || isEmptyValue(value)) return false;
        if (existing && !existing.locked && !fromSource && !isEmptyValue(existing[field])) return false;
        return !existing || serializeField(value) !== serializeField(existing[field]);
      });

      if (!existing) {
        this.ensureProfile(course, evidence.recording_id ?? null);
        for (const field of changed) this.writeProfileField(course, field, input[field]!);
        result = { action: 'created', proposals: 0 };
      } else if (changed.length === 0) {
        result = { action: 'unchanged', proposals: 0 };
      } else if (existing.locked) {
        let proposals = 0;
        for (const field of changed) {
          const id = this.createProposal({
            ...evidence,
            course,
            target: `profile.${field}`,
            current_value: serializeField(existing[field]),
            proposed_value: serializeField(input[field]!),
          });
          if (id !== null) proposals++;
        }
        result = { action: 'proposed', proposals };
      } else {
        for (const field of changed) this.writeProfileField(course, field, input[field]!);
        if (evidence.recording_id && existing.source_recording_id !== evidence.recording_id && this.cameBefore(evidence.recording_id, existing.source_recording_id)) {
          this.db.prepare('UPDATE course_profiles SET source_recording_id = ? WHERE course = ?').run(evidence.recording_id, course);
        }
        result = { action: 'updated', proposals: 0 };
      }
    });
    run();
    return result;
  }

  /** True when recording `a` is an earlier class than `b` (date, then campus session and part). */
  private cameBefore(a: number, b: number | null): boolean {
    if (!b || a === b) return false;
    const get = this.db.prepare('SELECT COALESCE(class_date, substr(created_at, 1, 10)) AS day, COALESCE(session_number, 0) AS n, COALESCE(session_part, 0) AS part FROM recordings WHERE id = ?');
    const x = get.get(a) as { day: string; n: number; part: number } | undefined;
    const y = get.get(b) as { day: string; n: number; part: number } | undefined;
    if (!x || !y) return false;
    return x.day.localeCompare(y.day) < 0 || (x.day === y.day && (x.n < y.n || (x.n === y.n && x.part < y.part)));
  }

  private ensureProfile(course: string, sourceRecordingId: number | null): void {
    this.db
      .prepare('INSERT INTO course_profiles (course, source_recording_id) VALUES (?, ?) ON CONFLICT(course) DO NOTHING')
      .run(course, sourceRecordingId);
  }

  private writeProfileField(course: string, field: ProfileField, value: unknown): void {
    const column = field === 'syllabus' ? 'syllabus_json' : field === 'resources' ? 'resources_json' : field;
    const stored = field === 'syllabus' || field === 'resources' ? JSON.stringify(value ?? []) : String(value ?? '');
    this.db.prepare(`UPDATE course_profiles SET ${column} = ?, updated_at = datetime('now') WHERE course = ?`).run(stored, course);
  }

  // ── Grading ─────────────────────────────────────────────────────────────

  listGradingItems(course: string): GradingRow[] {
    return this.db.prepare('SELECT * FROM grading_items WHERE course = ? ORDER BY COALESCE(parent_id, id), id').all(course) as GradingRow[];
  }

  /**
   * Replace the AI grading table of a course (user items stay). Under a locked profile the new table
   * becomes a single 'profile.grading' proposal instead. Returns how many items were written.
   */
  replaceAiGradingItems(course: string, items: GradingInput[], evidence: Evidence = {}): number {
    // A table the student has edited is theirs, like a locked sheet: the model can only propose
    const owned = this.listGradingItems(course).some((g) => g.source === 'user');
    if (this.getProfile(course)?.locked || owned) {
      const current = this.listGradingItems(course).filter((g) => owned || g.source === 'ai');
      const same = JSON.stringify(gradingSignature(current, current)) === JSON.stringify(gradingSignature(items));
      if (!same && items.length > 0) {
        this.createProposal({
          ...evidence,
          course,
          target: 'profile.grading',
          current_value: JSON.stringify(gradingSignature(current, current)),
          proposed_value: JSON.stringify(items),
        });
      }
      return 0;
    }
    return this.writeGradingItems(course, items);
  }

  private writeGradingItems(course: string, items: GradingInput[]): number {
    const insert = this.db.prepare(
      `INSERT INTO grading_items (course, name, weight_pct, parent_id, min_grade, deliverable_id, exam_id, quote, recording_id, t_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM grading_items WHERE course = ? AND source = 'ai'").run(course);
      const ids = new Map<string, number>();
      for (const row of this.listGradingItems(course)) ids.set(normalizeName(row.name), row.id);
      // Parents first, so children can point at them by name
      const ordered = [...items.filter((i) => !i.parent), ...items.filter((i) => i.parent)];
      for (const item of ordered) {
        if (ids.has(normalizeName(item.name))) continue; // the student's own item of that name stays
        const info = insert.run(
          course,
          item.name.trim(),
          item.weight_pct ?? null,
          item.parent ? ids.get(normalizeName(item.parent)) ?? null : null,
          item.min_grade ?? null,
          item.deliverable_id ?? null,
          item.exam_id ?? null,
          item.quote ?? '',
          item.recording_id ?? null,
          item.t_ms ?? 0
        );
        ids.set(normalizeName(item.name), Number(info.lastInsertRowid));
        inserted++;
      }
    });
    run();
    return inserted;
  }

  getGradingItem(id: number): GradingRow | undefined {
    return this.db.prepare('SELECT * FROM grading_items WHERE id = ?').get(id) as GradingRow | undefined;
  }

  /** A parent must be another item of the same course that does not hang from this one. */
  private checkGradingParent(course: string, id: number | null, parentId: number | null): void {
    if (parentId === null) return;
    for (let p = this.getGradingItem(parentId); ; p = this.getGradingItem(p.parent_id!)) {
      if (!p || p.course !== course) throw new Error('El criterio padre no es de esta asignatura');
      if (p.id === id) throw new Error('Un criterio no puede estar dentro de sí mismo');
      if (p.parent_id === null) return;
    }
  }

  addGradingItem(course: string, input: { name: string; weight_pct?: number | null; parent_id?: number | null; min_grade?: number | null }): GradingRow {
    this.checkGradingParent(course, null, input.parent_id ?? null);
    const info = this.db
      .prepare("INSERT INTO grading_items (course, name, weight_pct, parent_id, min_grade, source) VALUES (?, ?, ?, ?, ?, 'user')")
      .run(course, input.name.trim(), input.weight_pct ?? null, input.parent_id ?? null, input.min_grade ?? null);
    return this.getGradingItem(Number(info.lastInsertRowid))!;
  }

  /** An edited item becomes the student's (see replaceAiGradingItems); a renamed one keeps its score. */
  updateGradingItem(id: number, patch: { name?: string; weight_pct?: number | null; parent_id?: number | null; min_grade?: number | null }): GradingRow | undefined {
    const row = this.getGradingItem(id);
    if (!row) return undefined;
    if (patch.parent_id !== undefined) this.checkGradingParent(row.course, id, patch.parent_id);
    const next = { ...row, ...patch, name: patch.name?.trim() || row.name };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE grading_items SET name = ?, weight_pct = ?, parent_id = ?, min_grade = ?, source = 'user' WHERE id = ?")
        .run(next.name, next.weight_pct, next.parent_id, next.min_grade, id);
      if (normalizeName(next.name) !== normalizeName(row.name)) {
        this.db
          .prepare('UPDATE OR REPLACE grade_scores SET item_key = ? WHERE course = ? AND item_key = ?')
          .run(normalizeName(next.name), row.course, normalizeName(row.name));
      }
    })();
    return this.getGradingItem(id);
  }

  /** Removes the item and its parts. The other items of the course become the student's too. */
  deleteGradingItem(id: number): boolean {
    const row = this.getGradingItem(id);
    if (!row) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM grading_items WHERE id = ?').run(id);
      this.db.prepare("UPDATE grading_items SET source = 'user' WHERE course = ?").run(row.course);
    })();
    return true;
  }

  /** The student's scores of a course, by normalised item name. */
  gradeScores(course: string): Map<string, number> {
    const rows = this.db.prepare('SELECT item_key, score FROM grade_scores WHERE course = ?').all(course) as { item_key: string; score: number }[];
    return new Map(rows.map((r) => [r.item_key, r.score]));
  }

  /** The grading table with the student's score of each item (null when not graded yet). */
  listGradesWithScores(course: string): (GradingRow & { score: number | null })[] {
    const scores = this.gradeScores(course);
    return this.listGradingItems(course).map((g) => ({ ...g, score: scores.get(normalizeName(g.name)) ?? null }));
  }

  /** null clears the score. */
  setGradeScore(course: string, name: string, score: number | null): void {
    if (score === null) {
      this.db.prepare('DELETE FROM grade_scores WHERE course = ? AND item_key = ?').run(course, normalizeName(name));
      return;
    }
    this.db
      .prepare(
        `INSERT INTO grade_scores (course, item_key, score) VALUES (?, ?, ?)
         ON CONFLICT(course, item_key) DO UPDATE SET score = excluded.score, updated_at = datetime('now')`
      )
      .run(course, normalizeName(name), score);
  }

  // ── Deliverables ────────────────────────────────────────────────────────

  /**
   * Create a deliverable or enrich the existing one with the same key. A deliverable the user edited
   * (source = 'user') keeps its content; empty values never erase anything.
   */
  upsertDeliverable(course: string, input: DeliverableInput, source: Source = 'ai'): DeliverableRow {
    const existing = this.findDeliverable(course, input.key);
    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO deliverables (course, key, title, description, format, group_size, weight_pct, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(course, input.key, input.title.trim(), input.description ?? '', input.format ?? '', input.group_size ?? '', input.weight_pct ?? null, source);
      return this.getDeliverable(Number(info.lastInsertRowid))!;
    }
    if (existing.source === 'user' && source === 'ai') return existing;
    this.patchContent('deliverables', existing.id, input, ['title', 'description', 'format', 'group_size', 'weight_pct'], source);
    return this.getDeliverable(existing.id)!;
  }

  getDeliverable(id: number): DeliverableRow | undefined {
    return this.db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as DeliverableRow | undefined;
  }

  findDeliverable(course: string, key: string): DeliverableRow | undefined {
    return this.db.prepare('SELECT * FROM deliverables WHERE course = ? AND key = ?').get(course, key) as DeliverableRow | undefined;
  }

  listDeliverables(course: string): DeliverableRow[] {
    return this.db.prepare('SELECT * FROM deliverables WHERE course = ? ORDER BY id').all(course) as DeliverableRow[];
  }

  /** User edit. Changing the status is progress, not authorship, so only content edits set source = 'user'. */
  updateDeliverable(id: number, patch: Partial<Omit<DeliverableInput, 'key'>> & { status?: DeliverableStatus }): DeliverableRow | undefined {
    if (!this.getDeliverable(id)) return undefined;
    const run = this.db.transaction(() => {
      if (patch.status) this.db.prepare('UPDATE deliverables SET status = ? WHERE id = ?').run(patch.status, id);
      this.patchContent('deliverables', id, patch, ['title', 'description', 'format', 'group_size', 'weight_pct'], 'user');
    });
    run();
    return this.getDeliverable(id);
  }

  deleteDeliverable(id: number): boolean {
    let deleted = false;
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM mentions WHERE entity_type = 'deliverable' AND entity_id = ?").run(id);
      this.db.prepare("UPDATE note_sections SET entity_id = NULL WHERE destination = 'deliverable' AND entity_id = ?").run(id);
      deleted = this.db.prepare('DELETE FROM deliverables WHERE id = ?').run(id).changes > 0;
    });
    run();
    return deleted;
  }

  // ── Exams ───────────────────────────────────────────────────────────────

  /** Same rules as upsertDeliverable. */
  upsertExam(course: string, input: ExamInput, source: Source = 'ai'): ExamRow {
    const existing = this.findExam(course, input.key);
    if (!existing) {
      const info = this.db
        .prepare('INSERT INTO exams (course, key, title, format, weight_pct, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(course, input.key, input.title.trim(), input.format ?? '', input.weight_pct ?? null, source);
      return this.getExam(Number(info.lastInsertRowid))!;
    }
    if (existing.source === 'user' && source === 'ai') return existing;
    this.patchContent('exams', existing.id, input, ['title', 'format', 'weight_pct'], source);
    return this.getExam(existing.id)!;
  }

  getExam(id: number): ExamRow | undefined {
    return this.db.prepare('SELECT * FROM exams WHERE id = ?').get(id) as ExamRow | undefined;
  }

  findExam(course: string, key: string): ExamRow | undefined {
    return this.db.prepare('SELECT * FROM exams WHERE course = ? AND key = ?').get(course, key) as ExamRow | undefined;
  }

  listExams(course: string): ExamRow[] {
    return this.db.prepare('SELECT * FROM exams WHERE course = ? ORDER BY id').all(course) as ExamRow[];
  }

  updateExam(id: number, patch: Partial<Omit<ExamInput, 'key'>>): ExamRow | undefined {
    if (!this.getExam(id)) return undefined;
    this.patchContent('exams', id, patch, ['title', 'format', 'weight_pct'], 'user');
    return this.getExam(id);
  }

  deleteExam(id: number): boolean {
    let deleted = false;
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM mentions WHERE entity_type = 'exam' AND entity_id = ?").run(id);
      this.db.prepare("UPDATE note_sections SET entity_id = NULL WHERE destination = 'exam' AND entity_id = ?").run(id);
      deleted = this.db.prepare('DELETE FROM exams WHERE id = ?').run(id).changes > 0;
    });
    run();
    return deleted;
  }

  /** Write the non-empty fields of a patch; an AI patch leaves weight alone unless it brings a number. */
  private patchContent(
    table: 'deliverables' | 'exams',
    id: number,
    patch: object,
    fields: string[],
    source: Source
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of fields) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (source === 'ai' && (value === null || (typeof value === 'string' && !value.trim()))) continue;
      sets.push(`${field} = ?`);
      params.push(typeof value === 'string' ? value.trim() : value);
    }
    if (sets.length === 0) return;
    if (source === 'user') sets.push("source = 'user'");
    this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  listEvents(
    filter: {
      course?: string; from?: string; to?: string; includeDismissed?: boolean; recordingId?: number;
      deliverableId?: number; examId?: number; datedOnly?: boolean;
    } = {}
  ): EventRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.deliverableId !== undefined) {
      where.push('e.deliverable_id = ?');
      params.push(filter.deliverableId);
    }
    if (filter.examId !== undefined) {
      where.push('e.exam_id = ?');
      params.push(filter.examId);
    }
    if (filter.datedOnly) where.push('e.date IS NOT NULL');
    if (filter.course !== undefined) {
      where.push('e.course = ?');
      params.push(filter.course);
    }
    if (filter.recordingId !== undefined) {
      where.push('e.recording_id = ?');
      params.push(filter.recordingId);
    }
    // A range only applies to dated events; undated ones stay visible in the "Sin fecha" list
    if (filter.from) {
      where.push('(e.date IS NULL OR e.date >= ?)');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('(e.date IS NULL OR e.date <= ?)');
      params.push(filter.to);
    }
    if (!filter.includeDismissed) where.push('e.dismissed = 0');

    return this.db
      .prepare(
        `SELECT e.*, COALESCE(r.display_title, r.title) AS recording_title
         FROM events e LEFT JOIN recordings r ON r.id = e.recording_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY (e.date IS NULL), e.date, (e.time IS NULL), e.time, e.id`
      )
      .all(...params) as EventRow[];
  }

  getEvent(id: number): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  }

  /** An event the user adds by hand is confirmed from the start. */
  createEvent(course: string, input: EventInput, source: Source = 'user'): EventRow {
    const id = this.insertEvent(course, input, source, source === 'user');
    return this.getEvent(id)!;
  }

  /** Editing what an event says makes it the user's; confirming or dismissing is a decision on the AI's. */
  updateEvent(id: number, patch: EventPatch): EventRow | undefined {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const field of ['kind', 'title', 'date', 'time'] as const) {
      if (patch[field] === undefined) continue;
      sets.push(`${field} = ?`);
      params.push(typeof patch[field] === 'string' ? patch[field]!.trim() : patch[field]);
    }
    if (sets.length > 0) sets.push("source = 'user'");
    if (patch.confirmed !== undefined) {
      sets.push('confirmed = ?');
      params.push(patch.confirmed ? 1 : 0);
    }
    if (patch.dismissed !== undefined) {
      sets.push('dismissed = ?');
      params.push(patch.dismissed ? 1 : 0);
    }
    if (sets.length === 0) return this.getEvent(id);
    this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getEvent(id);
  }

  /** User events are deleted; AI events are dismissed, so regenerating never brings them back. */
  deleteEvent(id: number): boolean {
    const event = this.getEvent(id);
    if (!event) return false;
    if (event.source === 'ai') return this.db.prepare('UPDATE events SET dismissed = 1 WHERE id = ?').run(id).changes > 0;
    return this.db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Replace the AI events found in one recording. Events the user confirmed, dismissed or edited are
   * kept, and a regenerated event at the same moment as one of them is not added again.
   * Returns the new id of each input event, or null where it was skipped.
   */
  replaceAiEvents(recordingId: number, course: string, events: EventInput[]): (number | null)[] {
    const ids: (number | null)[] = [];
    const run = this.db.transaction(() => {
      const replaced = "SELECT id FROM events WHERE recording_id = ? AND source = 'ai' AND confirmed = 0 AND dismissed = 0";
      // Open questions about events that are about to disappear would point at nothing
      this.db
        .prepare(
          `DELETE FROM proposals WHERE status = 'open' AND target LIKE 'event:%'
             AND CAST(substr(target, 7, instr(target, '.') - 7) AS INTEGER) IN (${replaced})`
        )
        .run(recordingId);
      this.db.prepare(`DELETE FROM events WHERE id IN (${replaced})`).run(recordingId);
      const kept = this.db.prepare('SELECT kind, t_ms, date, dismissed FROM events WHERE recording_id = ?').all(recordingId) as {
        kind: string; t_ms: number; date: string | null; dismissed: number;
      }[];
      // Something discarded only silences itself: discarding "sin fecha" must not hide the real date said next to it
      const decided = (event: EventInput) => kept.some((k) =>
        k.kind === event.kind && Math.abs(k.t_ms - (event.t_ms ?? 0)) <= SAME_MOMENT_MS && (!k.dismissed || !event.date || k.date === event.date));
      for (const event of events) {
        ids.push(decided(event) ? null : this.insertEvent(course, { ...event, recording_id: recordingId }, 'ai', false));
      }
    });
    run();
    return ids;
  }

  /**
   * Bring the university calendar in. Each feed event is found again by its uid next time:
   * - an event the student edited (source 'user') keeps what they wrote; any other follows the university;
   * - a deadline, exam or lab the AI already heard in class (same course, kind and day) is not doubled: it is
   *   linked to the feed event and marked confirmed, and keeps its quote;
   * - discarding stays discarded;
   * - what leaves the feed is deleted if it was only the university's and is still ahead (past ones stay as
   *   a record); an AI event that loses its link keeps everything else;
   * - but nothing is removed when the feed comes empty or loses over half of what the university had
   *   published (`held` says how many were kept), unless `force` says the change is real.
   */
  syncLmsEvents(items: LmsEventInput[], today: string, options: { force?: boolean } = {}): LmsSyncResult {
    const result: LmsSyncResult = { added: 0, updated: 0, matched: 0, removed: 0, held: 0 };
    const run = this.db.transaction(() => {
      const linked = new Map(
        (this.db.prepare('SELECT * FROM events WHERE external_uid IS NOT NULL').all() as EventRow[]).map((e) => [e.external_uid!, e])
      );
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.uid)) continue;
        seen.add(item.uid);
        const row = linked.get(item.uid);
        if (row) {
          if (row.source === 'user') continue;
          const own = row.source === 'lms';
          const next = { course: own ? item.course : row.course, kind: own ? item.kind : row.kind, title: own ? item.title : row.title, date: item.date, time: item.time ?? (own ? null : row.time) };
          if (next.course !== row.course || next.kind !== row.kind || next.title !== row.title || next.date !== row.date || next.time !== row.time) {
            this.db.prepare('UPDATE events SET course = ?, kind = ?, title = ?, date = ?, time = ?, confirmed = 1 WHERE id = ?')
              .run(next.course, next.kind, next.title, next.date, next.time, row.id);
            result.updated++;
          }
          continue;
        }
        const twin = item.kind === 'session' ? undefined : (this.db
          .prepare('SELECT * FROM events WHERE external_uid IS NULL AND course = ? AND kind = ? AND date = ? ORDER BY id LIMIT 1')
          .get(item.course, item.kind, item.date) as EventRow | undefined);
        if (twin) {
          this.db.prepare('UPDATE events SET external_uid = ?, confirmed = 1, time = COALESCE(time, ?) WHERE id = ?').run(item.uid, item.time, twin.id);
          result.matched++;
          continue;
        }
        const heard = this.heardOnAnotherDay(item);
        if (heard) {
          this.linkHeardEvent(heard, item);
          result.matched++;
          continue;
        }
        const id = this.insertEvent(item.course, { kind: item.kind, title: item.title, date: item.date, time: item.time, confidence: 'high' }, 'lms', true);
        this.db.prepare('UPDATE events SET external_uid = ? WHERE id = ?').run(item.uid, id);
        result.added++;
      }
      const gone = [...linked].filter(([uid]) => !seen.has(uid)).map(([, row]) => row);
      const doomed = gone.filter((row) => row.source === 'lms' && (!row.date || row.date >= today));
      const owned = [...linked.values()].filter((row) => row.source === 'lms').length;
      if (!options.force && suspiciousRemoval(seen.size, owned, doomed.length)) {
        result.held = doomed.length;
        return;
      }
      for (const row of gone) {
        if (doomed.includes(row)) {
          this.db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
          result.removed++;
        } else if (row.source !== 'lms') {
          this.db.prepare('UPDATE events SET external_uid = NULL WHERE id = ?').run(row.id);
        }
      }
    });
    run();
    return result;
  }

  /** An AI event that is the same exam, deadline or lab as a feed event but on another day (or with no day). */
  private heardOnAnotherDay(item: LmsEventInput): EventRow | undefined {
    if (!['exam', 'deadline', 'lab'].includes(item.kind)) return undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE external_uid IS NULL AND source = 'ai' AND dismissed = 0
           AND course = ? AND kind = ? AND (date IS NULL OR date != ?) ORDER BY id`
      )
      .all(item.course, item.kind, item.date) as EventRow[];
    return rows.find((e) => sameCalendarThing(e, item));
  }

  /**
   * One event instead of two. The university's day is the official one; where the class said another
   * day, that goes to review ("Ahora: universidad · Propuesto: clase", with the quote). A day the
   * student already confirmed stays, protected as theirs, and the university's day is what gets proposed.
   */
  private linkHeardEvent(heard: EventRow, item: LmsEventInput): void {
    const ownDay = heard.date !== null && heard.confirmed === 1;
    this.db
      .prepare('UPDATE events SET external_uid = ?, date = ?, time = COALESCE(time, ?), confirmed = 1, source = ? WHERE id = ?')
      .run(item.uid, ownDay ? heard.date : item.date, item.time, ownDay ? 'user' : 'ai', heard.id);
    const target = `event:${heard.id}.date`;
    if (ownDay) {
      this.createProposal({ course: heard.course, target, current_value: heard.date, proposed_value: item.date });
    } else if (heard.date !== null) {
      this.createProposal({
        course: heard.course, target, current_value: item.date, proposed_value: heard.date,
        recording_id: heard.recording_id, t_ms: heard.t_ms, quote: heard.quote,
      });
    }
  }

  private insertEvent(course: string, input: EventInput, source: Source, confirmed: boolean): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (course, kind, title, date, time, deliverable_id, exam_id, recording_id, t_ms, quote,
                             date_text, confidence, confirmed, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        course,
        input.kind,
        input.title.trim(),
        input.date ?? null,
        input.time ?? null,
        input.deliverable_id ?? null,
        input.exam_id ?? null,
        input.recording_id ?? null,
        input.t_ms ?? 0,
        input.quote ?? '',
        input.date_text ?? '',
        input.confidence ?? 'medium',
        confirmed ? 1 : 0,
        source
      );
    return Number(info.lastInsertRowid);
  }

  // ── Mentions ────────────────────────────────────────────────────────────

  /** Replace what one recording said about entities; dismissed mentions stay dismissed. */
  replaceMentions(recordingId: number, mentions: MentionInput[]): number {
    const insert = this.db.prepare(
      `INSERT INTO mentions (entity_type, entity_id, recording_id, kind, text, quote, t_ms, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM mentions WHERE recording_id = ? AND dismissed = 0').run(recordingId);
      const dismissed = this.db
        .prepare('SELECT entity_type, entity_id, kind, t_ms FROM mentions WHERE recording_id = ?')
        .all(recordingId) as { entity_type: string; entity_id: number; kind: string; t_ms: number }[];
      for (const m of mentions) {
        const same = dismissed.some(
          (d) => d.entity_type === m.entity_type && d.entity_id === m.entity_id && d.kind === m.kind && Math.abs(d.t_ms - m.t_ms) <= SAME_MOMENT_MS
        );
        if (same) continue;
        insert.run(m.entity_type, m.entity_id, recordingId, m.kind, m.text.trim(), m.quote ?? '', m.t_ms, m.confidence ?? 'medium');
        inserted++;
      }
    });
    run();
    return inserted;
  }

  /** Everything said about an entity, in class order, with the class it was said in. */
  listMentions(entityType: EntityType, entityId: number, options: { includeDismissed?: boolean } = {}): MentionRow[] {
    return this.db
      .prepare(
        `SELECT m.*, COALESCE(r.display_title, r.title) AS recording_title, r.class_number
         FROM mentions m JOIN recordings r ON r.id = m.recording_id
         WHERE m.entity_type = ? AND m.entity_id = ? ${options.includeDismissed ? '' : 'AND m.dismissed = 0'}
         ORDER BY COALESCE(r.class_date, substr(r.created_at, 1, 10)), r.id, m.t_ms`
      )
      .all(entityType, entityId) as MentionRow[];
  }

  /** What any class of the course said about the course itself (entity_id is 0 for these). */
  listCourseMentions(course: string, options: { includeDismissed?: boolean } = {}): MentionRow[] {
    return this.db
      .prepare(
        `SELECT m.*, COALESCE(r.display_title, r.title) AS recording_title, r.class_number
         FROM mentions m JOIN recordings r ON r.id = m.recording_id
         WHERE m.entity_type = 'course' AND r.course = ? ${options.includeDismissed ? '' : 'AND m.dismissed = 0'}
         ORDER BY COALESCE(r.class_date, substr(r.created_at, 1, 10)), r.id, m.t_ms`
      )
      .all(course) as MentionRow[];
  }

  setMentionDismissed(id: number, dismissed: boolean): boolean {
    return this.db.prepare('UPDATE mentions SET dismissed = ? WHERE id = ?').run(dismissed ? 1 : 0, id).changes > 0;
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  /** Replace what one class asked the student to do; a task already ticked or dismissed is not asked again. */
  replaceAiTasks(recordingId: number, course: string, tasks: TaskInput[]): void {
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM tasks WHERE recording_id = ? AND done = 0 AND dismissed = 0').run(recordingId);
      const decided = this.db.prepare('SELECT text, t_ms FROM tasks WHERE recording_id = ?').all(recordingId) as { text: string; t_ms: number }[];
      const insert = this.db.prepare('INSERT INTO tasks (course, recording_id, text, quote, t_ms) VALUES (?, ?, ?, ?, ?)');
      for (const task of tasks) {
        if (decided.some((d) => Math.abs(d.t_ms - task.t_ms) <= SAME_MOMENT_MS || sameEntityTitle(d.text, task.text))) continue;
        insert.run(course, recordingId, task.text.trim(), task.quote ?? '', task.t_ms);
      }
    });
    run();
  }

  /** What is still to do, from the latest class back. */
  listOpenTasks(limit = 50): TaskRow[] {
    return this.db
      .prepare(
        `SELECT t.*, COALESCE(r.display_title, r.title) AS recording_title, r.class_number
         FROM tasks t JOIN recordings r ON r.id = t.recording_id
         WHERE t.done = 0 AND t.dismissed = 0
         ORDER BY COALESCE(r.class_date, substr(r.created_at, 1, 10)) DESC, t.recording_id DESC, t.t_ms
         LIMIT ?`
      )
      .all(limit) as TaskRow[];
  }

  /** What one class asked, ticked ones included. */
  listRecordingTasks(recordingId: number): Omit<TaskRow, 'recording_title' | 'class_number'>[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE recording_id = ? AND dismissed = 0 ORDER BY t_ms')
      .all(recordingId) as Omit<TaskRow, 'recording_title' | 'class_number'>[];
  }

  updateTask(id: number, patch: { done?: boolean; dismissed?: boolean }): boolean {
    const sets: string[] = [];
    const params: number[] = [];
    if (patch.done !== undefined) { sets.push('done = ?'); params.push(patch.done ? 1 : 0); }
    if (patch.dismissed !== undefined) { sets.push('dismissed = ?'); params.push(patch.dismissed ? 1 : 0); }
    if (sets.length === 0) return false;
    return this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id).changes > 0;
  }

  // ── Note sections and AI key moments ────────────────────────────────────

  replaceNoteSections(recordingId: number, sections: NoteSectionInput[]): number {
    const insert = this.db.prepare(
      `INSERT INTO note_sections (recording_id, ord, destination, entity_id, heading, markdown, gist, start_ms, end_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM note_sections WHERE recording_id = ?').run(recordingId);
      sections.forEach((s, ord) =>
        insert.run(recordingId, ord, s.destination, s.entity_id ?? null, s.heading.trim(), s.markdown, s.gist ?? '', s.start_ms, s.end_ms)
      );
    });
    run();
    return sections.length;
  }

  /** Store the notes written for some ranges of a class; the other ranges keep what they have. */
  setSectionNotes(recordingId: number, notes: { ord: number; gist: string; markdown: string; model?: string }[]): number {
    const update = this.db.prepare('UPDATE note_sections SET gist = ?, markdown = ?, model = ? WHERE recording_id = ? AND ord = ?');
    let changed = 0;
    this.db.transaction(() => {
      for (const n of notes) changed += update.run(n.gist, n.markdown, n.markdown.trim() ? n.model ?? '' : '', recordingId, n.ord).changes;
    })();
    return changed;
  }

  listNoteSections(recordingId: number): NoteSectionRow[] {
    return this.db.prepare('SELECT * FROM note_sections WHERE recording_id = ? ORDER BY ord').all(recordingId) as NoteSectionRow[];
  }

  /** Every range of any class routed to a deliverable or exam, in class order. */
  listSectionsForEntity(destination: 'deliverable' | 'exam', entityId: number): (NoteSectionRow & {
    recording_title: string; class_number: number | null; session_kind: SessionKind | null;
  })[] {
    return this.db
      .prepare(
        `SELECT s.*, COALESCE(r.display_title, r.title) AS recording_title, r.class_number, r.session_kind
         FROM note_sections s JOIN recordings r ON r.id = s.recording_id
         WHERE s.destination = ? AND s.entity_id = ?
         ORDER BY COALESCE(r.class_date, substr(r.created_at, 1, 10)), r.id, s.ord`
      )
      .all(destination, entityId) as (NoteSectionRow & { recording_title: string; class_number: number | null; session_kind: SessionKind | null })[];
  }

  /** What one class said about deliverables, exams and the course, with the entity's title. */
  listRecordingMentions(recordingId: number): (MentionRow & { entity_title: string | null })[] {
    return this.db
      .prepare(
        `SELECT m.*, CASE m.entity_type
                       WHEN 'deliverable' THEN (SELECT title FROM deliverables d WHERE d.id = m.entity_id)
                       WHEN 'exam' THEN (SELECT title FROM exams x WHERE x.id = m.entity_id)
                     END AS entity_title
         FROM mentions m WHERE m.recording_id = ? AND m.dismissed = 0 ORDER BY m.t_ms`
      )
      .all(recordingId) as (MentionRow & { entity_title: string | null })[];
  }

  listAiMarkers(recordingId: number): { id: number; t_ms: number; text: string; why: string }[] {
    return this.db
      .prepare("SELECT id, t_ms, text, why FROM markers WHERE recording_id = ? AND source = 'ai' ORDER BY t_ms")
      .all(recordingId) as { id: number; t_ms: number; text: string; why: string }[];
  }

  /** Replace the AI key moments of a recording; the student's own bookmarks are untouched. */
  replaceAiMarkers(recordingId: number, highlights: HighlightInput[]): number {
    const insert = this.db.prepare("INSERT INTO markers (recording_id, t_ms, text, why, source) VALUES (?, ?, ?, ?, 'ai')");
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM markers WHERE recording_id = ? AND source = 'ai'").run(recordingId);
      for (const h of highlights) insert.run(recordingId, h.t_ms, h.text.trim(), h.why ?? '');
    });
    run();
    return highlights.length;
  }

  // ── Routing a session analysis ──────────────────────────────────────────

  /**
   * Route a validated analysis to its places in one transaction: title and kind on the recording,
   * entities, course sheet (or proposals if locked), grading, calendar, mentions, ranges and key
   * moments. Nothing the user owns is overwritten. Without a course only the recording-level
   * results are stored, since entities and the sheet belong to a course.
   */
  applyAnalysis(recordingId: number, analysis: SessionAnalysis, analysisVersion: string): ApplyAnalysisReport {
    const rec = this.db.prepare('SELECT id, course FROM recordings WHERE id = ?').get(recordingId) as { id: number; course: string } | undefined;
    if (!rec) throw new Error(`No existe la grabación ${recordingId}`);
    const course = rec.course;
    const evidence = (g: { quote: string; t_ms: number }): Evidence => ({ recording_id: recordingId, t_ms: g.t_ms, quote: g.quote });
    const openProposals = () => (this.db.prepare("SELECT count(*) AS n FROM proposals WHERE status = 'open'").get() as { n: number }).n;
    const report: ApplyAnalysisReport = {
      title: null, class_number: null, session_kind: analysis.session_kind, profile: 'skipped',
      deliverables: 0, exams: 0, events: 0, mentions: 0, sections: 0, highlights: 0, proposals: 0, skipped: [],
    };

    const run = this.db.transaction(() => {
      const proposalsBefore = openProposals();

      // 1. The recording itself
      if (course) this.renumberClasses(course);
      const number = course
        ? (this.db.prepare('SELECT class_number FROM recordings WHERE id = ?').get(recordingId) as { class_number: number | null }).class_number
        : null;
      if (analysis.title_summary) this.setDisplayTitle(recordingId, classTitle(number, analysis.title_summary), 'ai');
      this.setSessionAnalysis(recordingId, { session_kind: analysis.session_kind, topic: analysis.topic, analysis_version: analysisVersion });
      report.highlights = this.replaceAiMarkers(recordingId, analysis.highlights);

      if (!course) {
        report.sections = this.replaceNoteSections(recordingId, analysis.sections.map((s) => ({ ...s, entity_id: null, markdown: '' })));
        report.skipped.push('La clase no tiene asignatura: no se han creado ficha, trabajos, exámenes ni eventos.');
        return;
      }

      // 2. Entities: one row per real deliverable/exam of the course
      const ids = { deliverable: new Map<string, number>(), exam: new Map<string, number>() };
      for (const d of analysis.deliverables) {
        ids.deliverable.set(d.key, this.upsertDeliverable(course, d).id);
        report.deliverables++;
      }
      for (const e of analysis.exams) {
        ids.exam.set(e.key, this.upsertExam(course, e).id);
        report.exams++;
      }
      const idOf = (type: 'deliverable' | 'exam' | null, key: string | null): number | null => {
        if (!type || !key) return null;
        const id = ids[type].get(key) ?? (type === 'deliverable' ? this.findDeliverable(course, key)?.id : this.findExam(course, key)?.id);
        return id ?? null;
      };

      // 3. Course sheet and grading (a locked sheet only receives proposals)
      if (analysis.course_info) {
        const { quote, t_ms, ...info } = analysis.course_info;
        report.profile = this.applyAiProfile(course, info, evidence({ quote, t_ms })).action;
      }
      if (analysis.grading.length > 0) {
        this.replaceAiGradingItems(
          course,
          analysis.grading.map((g) => ({
            name: g.name,
            weight_pct: g.weight_pct,
            parent: g.parent ?? undefined,
            deliverable_id: g.entity_type === 'deliverable' ? idOf('deliverable', g.entity_key) : null,
            exam_id: g.entity_type === 'exam' ? idOf('exam', g.entity_key) : null,
            ...evidence(g),
          })),
          evidence(analysis.grading[0]!)
        );
      }

      // 4. Calendar. An entity date already known from another class is not added twice; a
      // different date for it becomes a proposal ("Fecha cambiada en Clase 4").
      const otherDates = this.db.prepare(
        `SELECT * FROM events
         WHERE course = ? AND kind = ? AND dismissed = 0 AND (deliverable_id = ? OR exam_id = ?)
           AND NOT (recording_id = ? AND source = 'ai' AND confirmed = 0)`
      );
      const toInsert: { input: EventInput; claimed: string | null; source: AnalysisEvent }[] = [];
      // Everything that survives this analysis, dismissed included: what you discarded stays discarded
      const standing = this.listEvents({ course, includeDismissed: true }).filter(
        (o) => !(o.recording_id === recordingId && o.source === 'ai' && !o.confirmed && !o.dismissed)
      );
      for (const ev of analysis.events) {
        const entityId = idOf(ev.entity_type, ev.entity_key);
        const input: EventInput = {
          kind: ev.kind, title: ev.title, date: ev.date, time: ev.time, date_text: ev.date_text, confidence: ev.confidence,
          deliverable_id: ev.entity_type === 'deliverable' ? entityId : null,
          exam_id: ev.entity_type === 'exam' ? entityId : null,
          t_ms: ev.t_ms, quote: ev.quote,
        };
        // The university already lists this one: it owns the day, so the class only adds its entity
        // and, if it said another day, a question for the inbox
        const official = standing.find((o) => o.source === 'lms' && !o.dismissed && sameCalendarThing(o, ev));
        if (official) {
          if (entityId !== null && official.deliverable_id === null && official.exam_id === null) {
            this.db.prepare('UPDATE events SET deliverable_id = ?, exam_id = ? WHERE id = ?').run(input.deliverable_id ?? null, input.exam_id ?? null, official.id);
          }
          if (ev.date && official.date !== ev.date) {
            this.createProposal({ ...evidence(ev), course, target: `event:${official.id}.date`, current_value: official.date, proposed_value: ev.date });
          }
          continue;
        }
        const identity = { kind: ev.kind, title: ev.title, date: ev.date, deliverable_id: input.deliverable_id, exam_id: input.exam_id };
        const accepted = toInsert.map(({ input: i }) => ({ kind: i.kind, title: i.title, date: i.date ?? null, deliverable_id: i.deliverable_id, exam_id: i.exam_id }));
        if (!ev.claimed_date && isRepeatedEvent(identity, [...standing, ...accepted])) continue;
        if (entityId !== null && ev.date) {
          const others = otherDates.all(course, ev.kind, input.deliverable_id ?? -1, input.exam_id ?? -1, recordingId) as EventRow[];
          if (others.some((o) => o.date === ev.date)) continue;
          const target = others.find((o) => o.confirmed) ?? others.find((o) => o.date) ?? others[0];
          // The user already corrected what this very class said: hearing it again is not news
          if (target?.source === 'user' && target.recording_id === recordingId) continue;
          if (target) {
            this.createProposal({ ...evidence(ev), course, target: `event:${target.id}.date`, current_value: target.date, proposed_value: ev.date });
            continue;
          }
        }
        toInsert.push({ input, claimed: ev.claimed_date, source: ev });
      }
      const eventIds = this.replaceAiEvents(recordingId, course, toInsert.map((x) => x.input));
      eventIds.forEach((id, i) => {
        if (id === null) return;
        report.events++;
        const { claimed, source } = toInsert[i]!;
        // The model gave a day the transcript does not back: the user decides, the calendar does not guess
        if (claimed) this.createProposal({ ...evidence(source), course, target: `event:${id}.date`, current_value: null, proposed_value: claimed });
      });

      // 5. What was said about each entity
      const mentions: MentionInput[] = [];
      for (const m of analysis.mentions) {
        const entityId = m.entity_type === 'course' ? 0 : idOf(m.entity_type, m.entity_key);
        if (entityId === null) continue;
        mentions.push({ entity_type: m.entity_type, entity_id: entityId, kind: m.kind, text: m.text, quote: m.quote, t_ms: m.t_ms, confidence: m.confidence });
      }
      report.mentions = this.replaceMentions(recordingId, mentions);
      this.replaceAiTasks(recordingId, course, analysis.tasks);

      // 6. Ranges (their notes are written by the notes step)
      report.sections = this.replaceNoteSections(
        recordingId,
        analysis.sections.map((s) => ({ ...s, entity_id: idOf(s.entity_type, s.entity_key), markdown: '' }))
      );

      report.proposals = Math.max(0, openProposals() - proposalsBefore);
    });
    run();

    const after = this.db.prepare('SELECT COALESCE(display_title, title) AS title, class_number FROM recordings WHERE id = ?').get(recordingId) as {
      title: string;
      class_number: number | null;
    };
    report.title = after.title;
    report.class_number = after.class_number;
    return report;
  }

  // ── Proposals (review inbox) ────────────────────────────────────────────

  /**
   * Queue a change for review. Returns null when the same change is already waiting or was rejected,
   * so regenerating never re-asks a question the user already answered.
   */
  createProposal(input: ProposalInput): number | null {
    const duplicate = this.db
      .prepare("SELECT id FROM proposals WHERE course = ? AND target = ? AND proposed_value = ? AND status IN ('open','rejected')")
      .get(input.course, input.target, input.proposed_value);
    if (duplicate) return null;
    // A regenerated AI event gets a new id: the same class proposing the same value for the same
    // field is still the same question
    const eventField = /^event:\d+\.(\w+)$/.exec(input.target)?.[1];
    if (eventField && input.recording_id) {
      const asked = this.db
        .prepare(
          `SELECT id FROM proposals WHERE course = ? AND recording_id = ? AND proposed_value = ?
             AND target LIKE 'event:%.' || ? AND status IN ('open','rejected')`
        )
        .get(input.course, input.recording_id, input.proposed_value, eventField);
      if (asked) return null;
    }
    const info = this.db
      .prepare(
        `INSERT INTO proposals (course, target, current_value, proposed_value, recording_id, t_ms, quote)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.course, input.target, input.current_value ?? null, input.proposed_value, input.recording_id ?? null, input.t_ms ?? 0, input.quote ?? '');
    return Number(info.lastInsertRowid);
  }

  listProposals(filter: { status?: ProposalStatus; course?: string } = {}): ProposalRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.course !== undefined) {
      where.push('course = ?');
      params.push(filter.course);
    }
    return this.db
      .prepare(`SELECT * FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`)
      .all(...params) as ProposalRow[];
  }

  getProposal(id: number): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
  }

  /** Apply an open proposal (the user's decision, so it goes through even on a locked profile). */
  acceptProposal(id: number): ProposalRow {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error(`No existe la propuesta ${id}`);
    if (proposal.status !== 'open') throw new Error('La propuesta ya está resuelta');

    const run = this.db.transaction(() => {
      this.applyProposal(proposal);
      this.db.prepare("UPDATE proposals SET status = 'accepted' WHERE id = ?").run(id);
    });
    run();
    return this.getProposal(id)!;
  }

  rejectProposal(id: number): ProposalRow {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error(`No existe la propuesta ${id}`);
    if (proposal.status !== 'open') throw new Error('La propuesta ya está resuelta');
    this.db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id);
    return this.getProposal(id)!;
  }

  /**
   * The proposed date is real but is not a new date for that event ("el primer examencito" is not the
   * final exam): keep the event as it is and add the date as its own. The change itself counts as
   * rejected, so regenerating does not ask again. A milestone stays under its deliverable; an exam
   * entity is one sitting, so nothing else goes under it.
   */
  addProposalAsEvent(id: number, input: { title: string; kind: EventKind }): EventRow {
    const proposal = this.getProposal(id);
    if (!proposal) throw new Error(`No existe la propuesta ${id}`);
    if (proposal.status !== 'open') throw new Error('La propuesta ya está resuelta');
    const targetId = /^event:(\d+)\.date$/.exec(proposal.target)?.[1];
    if (!targetId) throw new Error('Solo una fecha propuesta puede añadirse como evento');
    const target = this.getEvent(Number(targetId));

    const run = this.db.transaction(() => {
      const event = this.createEvent(proposal.course, {
        kind: input.kind,
        title: input.title,
        date: proposal.proposed_value,
        deliverable_id: target?.deliverable_id ?? null,
        recording_id: proposal.recording_id,
        t_ms: proposal.t_ms,
        quote: proposal.quote,
      });
      this.db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id);
      return event;
    });
    return run();
  }

  // ── Maintenance ─────────────────────────────────────────────────────────

  /** Move everything of a course to a new label (a bare "01" to its catalog name). */
  renameCourse(from: string, to: string): void {
    if (!from || !to || from === to) return;
    const taken = (['course_profiles', 'deliverables', 'exams'] as const).some(
      (table) => this.db.prepare(`SELECT 1 FROM ${table} WHERE course = ? LIMIT 1`).get(to)
    );
    if (taken) throw new Error(`La asignatura «${to}» ya tiene datos: no se puede fusionar con «${from}» automáticamente`);
    const run = this.db.transaction(() => {
      for (const table of ['recordings', 'course_profiles', 'grading_items', 'deliverables', 'exams', 'events', 'proposals', 'tasks', 'grade_scores']) {
        this.db.prepare(`UPDATE ${table} SET course = ? WHERE course = ?`).run(to, from);
      }
      this.db.prepare("UPDATE settings SET value = ? WHERE key = 'course' AND value = ?").run(to, from);
    });
    run();
  }

  /**
   * Apply today's quality rules to what older analyses stored, without calling the model. Only AI data
   * the user has not decided on is touched: duplicate or false events are dismissed (the calendar can
   * still show them) and locked profiles are left alone.
   */
  repairAiData(): RepairReport {
    const report: RepairReport = { profiles: 0, formats: 0, exams: 0, events: 0, sections: 0 };
    const run = this.db.transaction(() => {
      const courses = this.db.prepare('SELECT course FROM course_profiles WHERE locked = 0').all() as { course: string }[];
      for (const { course } of courses) {
        const p = this.getProfile(course)!;
        const clean: CourseProfileInput = {
          teacher: cleanTeacher(p.teacher),
          schedule: cleanSchedule(p.schedule),
          overview_md: sentenceCase(p.overview_md),
          pass_rules: sentenceCase(p.pass_rules),
          syllabus: p.syllabus.filter((s) => isRealSyllabusTitle(s.title)).map((s) => ({ ...s, title: shortSyllabusTitle(s.title) })),
          resources: p.resources.map(sentenceCase),
        };
        const fields = PROFILE_FIELDS.filter((f) => clean[f] !== undefined && serializeField(clean[f]!) !== serializeField(p[f]));
        for (const field of fields) this.writeProfileField(course, field, clean[field]!);
        if (fields.length) report.profiles++;
      }

      // A class' topic is the label of its syllabus block, in the wording the sheet has now
      for (const { course } of courses) {
        const syllabus = this.getProfile(course)?.syllabus ?? [];
        if (syllabus.length === 0) continue;
        const recs = this.db.prepare("SELECT id, topic FROM recordings WHERE course = ? AND topic != ''").all(course) as { id: number; topic: string }[];
        for (const r of recs) {
          const block = findSyllabusBlock(r.topic, syllabus);
          if (block && syllabusLabel(block) !== r.topic) this.db.prepare('UPDATE recordings SET topic = ? WHERE id = ?').run(syllabusLabel(block), r.id);
        }
      }

      for (const table of ['deliverables', 'exams'] as const) {
        const rows = this.db.prepare(`SELECT id, format FROM ${table} WHERE source = 'ai'`).all() as { id: number; format: string }[];
        for (const row of rows.filter((r) => r.format && isPlaceholderText(r.format))) {
          this.db.prepare(`UPDATE ${table} SET format = '' WHERE id = ?`).run(row.id);
          report.formats++;
        }
      }

      // "Preguntas tipo examen" is not an exam: what was said about it moves to the course
      const exams = this.db.prepare("SELECT id, title FROM exams WHERE source = 'ai'").all() as { id: number; title: string }[];
      for (const exam of exams) {
        const events = this.listEvents({ examId: exam.id, includeDismissed: true });
        const onlyQuestions = events.length > 0 && events.every((e) => !isExamSitting(e.title));
        if (isExamSitting(exam.title) && !onlyQuestions) continue;
        if (events.some((e) => e.source === 'user' || e.confirmed)) continue;
        for (const e of events) this.db.prepare('DELETE FROM proposals WHERE target LIKE ?').run(`event:${e.id}.%`);
        this.db.prepare("UPDATE mentions SET entity_type = 'course', entity_id = 0 WHERE entity_type = 'exam' AND entity_id = ?").run(exam.id);
        this.db.prepare("UPDATE note_sections SET destination = 'course_info', entity_id = NULL WHERE destination = 'exam' AND entity_id = ?").run(exam.id);
        this.db.prepare('DELETE FROM exams WHERE id = ?').run(exam.id);
        report.exams++;
      }

      // The teacher's "next session" goodbyes duplicate the university's timetable
      for (const e of this.db.prepare("SELECT id, kind, title FROM events WHERE source = 'ai' AND confirmed = 0 AND dismissed = 0").all() as { id: number; kind: string; title: string }[]) {
        if (!isNextSessionNoise(e.kind, e.title)) continue;
        this.db.prepare('UPDATE events SET dismissed = 1 WHERE id = ?').run(e.id);
        report.events++;
      }
      // A date that lies months before the class that mentioned it is a misheard year: say it again from the spoken words
      const stale = this.db.prepare(
        `SELECT e.id, e.date_text, r.class_date FROM events e JOIN recordings r ON r.id = e.recording_id
         WHERE e.source = 'ai' AND e.confirmed = 0 AND e.date IS NOT NULL AND r.class_date IS NOT NULL AND e.date < date(r.class_date, '-60 days')`
      ).all() as { id: number; date_text: string; class_date: string }[];
      for (const e of stale) {
        const cd = parseIso(e.class_date);
        const fixed = cd && e.date_text ? resolveDateText(e.date_text, cd) : null;
        this.db.prepare('UPDATE events SET date = ?, confidence = ? WHERE id = ?').run(fixed?.date ?? null, 'low', e.id);
        report.events++;
      }

      const hasQuestion = this.db.prepare("SELECT 1 FROM proposals WHERE status = 'open' AND target LIKE ? LIMIT 1");
      const dismiss = this.db.prepare('UPDATE events SET dismissed = 1 WHERE id = ?');
      const courseNames = (this.db.prepare('SELECT DISTINCT course FROM events').all() as { course: string }[]).map((c) => c.course);
      for (const course of courseNames) {
        const events = this.listEvents({ course });
        const open = (e: EventRow) => e.source === 'ai' && !e.confirmed;
        // Decided and dated events first: they are the ones the others may repeat
        const kept: EventRow[] = events.filter((e) => !open(e));
        for (const e of events.filter(open).sort((a, b) => Number(!a.date) - Number(!b.date))) {
          const asked = hasQuestion.get(`event:${e.id}.%`);
          if (!asked && ((e.kind === 'exam' && !isExamSitting(e.title)) || isRepeatedEvent(e, kept))) {
            dismiss.run(e.id);
            report.events++;
            continue;
          }
          if (e.kind === 'deadline' && isOpeningEvent(e.title)) {
            this.db.prepare("UPDATE events SET kind = 'other' WHERE id = ?").run(e.id);
            report.events++;
          }
          kept.push(e);
        }
      }

      // A long "logistics" range whose own heading is about the subject ("Demostración práctica de ANSYS") was
      // never written up: it goes back to theory and the notes step fills it in
      const admin = this.db.prepare("SELECT recording_id, ord, heading, start_ms, end_ms FROM note_sections WHERE destination = 'admin'")
        .all() as { recording_id: number; ord: number; heading: string; start_ms: number; end_ms: number }[];
      for (const s of admin.filter((row) => isMislabelledAdmin({ ...row, destination: 'admin' }))) {
        this.db.prepare("UPDATE note_sections SET destination = 'theory' WHERE recording_id = ? AND ord = ?").run(s.recording_id, s.ord);
        report.sections++;
      }
    });
    run();
    // Teacher and schedule as the university's timetable gives them, not as heard in class
    report.profiles += this.applyOfficialTimetable();
    return report;
  }

  private applyProposal(p: ProposalRow): void {
    if (p.target === 'profile.grading') {
      this.writeGradingItems(p.course, parseJsonArray<GradingInput>(p.proposed_value));
      return;
    }
    const profileField = /^profile\.(\w+)$/.exec(p.target)?.[1];
    if (profileField && (PROFILE_FIELDS as readonly string[]).includes(profileField)) {
      const field = profileField as ProfileField;
      const value = field === 'syllabus' || field === 'resources' ? parseJsonArray(p.proposed_value) : p.proposed_value;
      this.ensureProfile(p.course, p.recording_id);
      this.writeProfileField(p.course, field, value);
      return;
    }
    const eventField = /^event:(\d+)\.(date|time|title)$/.exec(p.target);
    if (eventField) {
      const eventId = Number(eventField[1]);
      if (!this.getEvent(eventId)) throw new Error('El evento de la propuesta ya no existe');
      this.updateEvent(eventId, { [eventField[2]!]: p.proposed_value, confirmed: true });
      return;
    }
    throw new Error(`No se puede aplicar la propuesta «${p.target}»`);
  }
}

function parseJsonArray<T = never>(json: string): T[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isEmptyValue(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : !String(value ?? '').trim();
}

function serializeField(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value ?? '').trim();
}

const normalizeName = foldWs;

/** What makes two grading tables the same: names, weights and nesting, not ids or quotes. */
function gradingSignature(items: (GradingInput | GradingRow)[], rows: GradingRow[] = []): string[] {
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  return items
    .map((i) => {
      const parent = 'parent_id' in i ? (i.parent_id ? nameOf.get(i.parent_id) ?? '' : '') : i.parent ?? '';
      return `${normalizeName(i.name)}|${i.weight_pct ?? ''}|${normalizeName(parent)}`;
    })
    .sort();
}
