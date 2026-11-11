/**
 * Exam question bank and practice attempts.
 *
 * Regenerating a class keeps what the student decided: a question they starred or dismissed stays (same guid),
 * and only questions nobody touched are replaced by the new batch.
 */

import type Database from 'better-sqlite3';
import { questionGuid, type ExamQuestionInput, type QuestionKind, type QuestionOrigin, type RubricItem } from '../study/exam-questions.js';

export interface ExamQuestionRow {
  id: number;
  recording_id: number;
  kind: QuestionKind;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
  rubric: RubricItem[];
  topic: string;
  origin: QuestionOrigin;
  emphasis: boolean;
  quote: string;
  t_ms: number;
  dismissed: boolean;
  starred: boolean;
  model: string;
  /** Class it comes from */
  course: string;
  recording_title: string;
  class_number: number | null;
  class_date: string | null;
}

export interface ExamCourseSummary {
  course: string;
  total: number;
  explicit: number;
  emphasis: number;
  byKind: Record<QuestionKind, number>;
  classes: number;
}

export interface AttemptItem {
  id: number;
  /** 0 to 1 */
  score: number;
}

export interface ExamAttemptRow {
  id: number;
  course: string;
  total: number;
  correct: number;
  items: AttemptItem[];
  created_at: string;
}

interface RawRow {
  id: number; recording_id: number; kind: QuestionKind; question: string; options: string; answer: string;
  explanation: string; rubric: string; topic: string; origin: QuestionOrigin; emphasis: number; quote: string;
  t_ms: number; dismissed: number; starred: number; model: string;
  course: string | null; recording_title: string; class_number: number | null; class_date: string | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const v: unknown = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toRow(r: RawRow): ExamQuestionRow {
  return {
    id: r.id, recording_id: r.recording_id, kind: r.kind, question: r.question,
    options: parseJson<string[]>(r.options, []), answer: r.answer, explanation: r.explanation,
    rubric: parseJson<RubricItem[]>(r.rubric, []), topic: r.topic, origin: r.origin,
    emphasis: r.emphasis === 1, quote: r.quote, t_ms: r.t_ms, dismissed: r.dismissed === 1, starred: r.starred === 1,
    model: r.model, course: r.course ?? '', recording_title: r.recording_title, class_number: r.class_number, class_date: r.class_date,
  };
}

const SELECT = `
  SELECT q.*, r.course AS course, COALESCE(r.display_title, r.title) AS recording_title,
         r.class_number AS class_number, r.class_date AS class_date
  FROM exam_questions q JOIN recordings r ON r.id = q.recording_id`;

export class ExamRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Store a class's new batch. Questions the student starred or dismissed are kept; the rest of the previous
   * batch is replaced. Returns how many questions are new.
   */
  replaceQuestions(recordingId: number, questions: ExamQuestionInput[], model: string, version: string): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO exam_questions
         (recording_id, kind, question, options, answer, explanation, rubric, topic, origin, emphasis, quote, t_ms, guid, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    this.db.transaction(() => {
      const guids = questions.map((q) => questionGuid(recordingId, q.question));
      const keep = new Set(guids);
      const old = this.db
        .prepare('SELECT id, guid FROM exam_questions WHERE recording_id = ? AND starred = 0 AND dismissed = 0')
        .all(recordingId) as { id: number; guid: string }[];
      const del = this.db.prepare('DELETE FROM exam_questions WHERE id = ?');
      for (const o of old) if (!keep.has(o.guid)) del.run(o.id);
      questions.forEach((q, i) => {
        inserted += insert.run(
          recordingId, q.kind, q.question, JSON.stringify(q.options), q.answer, q.explanation, JSON.stringify(q.rubric),
          q.topic, q.origin, q.emphasis ? 1 : 0, q.quote, q.t_ms, guids[i]!, model
        ).changes;
      });
      this.db.prepare('UPDATE recordings SET exam_version = ? WHERE id = ?').run(version, recordingId);
    })();
    return inserted;
  }

  /** Mark a class as processed even though it produced nothing (so it is not retried on every run). */
  markGenerated(recordingId: number, version: string): void {
    this.db.prepare('UPDATE recordings SET exam_version = ? WHERE id = ?').run(version, recordingId);
  }

  list(filter: { course?: string; recordingId?: number; includeDismissed?: boolean } = {}): ExamQuestionRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.course !== undefined) { where.push('r.course = ?'); params.push(filter.course); }
    if (filter.recordingId !== undefined) { where.push('q.recording_id = ?'); params.push(filter.recordingId); }
    if (!filter.includeDismissed) where.push('q.dismissed = 0');
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(r.class_date, r.created_at), r.id, q.t_ms, q.id`;
    return (this.db.prepare(sql).all(...params) as RawRow[]).map(toRow);
  }

  get(id: number): ExamQuestionRow | null {
    const row = this.db.prepare(`${SELECT} WHERE q.id = ?`).get(id) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  summaries(): ExamCourseSummary[] {
    const byCourse = new Map<string, ExamCourseSummary>();
    for (const q of this.list()) {
      let s = byCourse.get(q.course);
      if (!s) {
        s = { course: q.course, total: 0, explicit: 0, emphasis: 0, byKind: { tf: 0, mcq: 0, short: 0, essay: 0 }, classes: 0 };
        byCourse.set(q.course, s);
      }
      s.total++;
      if (q.origin === 'explicit') s.explicit++;
      if (q.emphasis) s.emphasis++;
      s.byKind[q.kind]++;
    }
    for (const s of byCourse.values()) {
      s.classes = (this.db
        .prepare('SELECT COUNT(DISTINCT q.recording_id) AS n FROM exam_questions q JOIN recordings r ON r.id = q.recording_id WHERE r.course = ? AND q.dismissed = 0')
        .get(s.course) as { n: number }).n;
    }
    return [...byCourse.values()];
  }

  setFlags(id: number, flags: { dismissed?: boolean; starred?: boolean }): ExamQuestionRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (flags.dismissed !== undefined) { sets.push('dismissed = ?'); params.push(flags.dismissed ? 1 : 0); }
    if (flags.starred !== undefined) { sets.push('starred = ?'); params.push(flags.starred ? 1 : 0); }
    if (sets.length > 0) this.db.prepare(`UPDATE exam_questions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.get(id);
  }

  /** Classes with a transcript whose bank is missing or comes from an older prompt. */
  listOutdated(version: string): number[] {
    return (
      this.db
        .prepare(
          `SELECT r.id FROM recordings r
           WHERE r.course != '' AND r.ignored_at IS NULL AND r.exam_version != ?
             AND EXISTS (SELECT 1 FROM segments s WHERE s.recording_id = r.id)
           ORDER BY COALESCE(r.class_date, r.created_at), r.id`
        )
        .all(version) as { id: number }[]
    ).map((r) => r.id);
  }

  saveAttempt(course: string, items: AttemptItem[]): ExamAttemptRow {
    const total = items.length;
    const correct = Math.round(items.reduce((sum, i) => sum + i.score, 0) * 100) / 100;
    const info = this.db
      .prepare('INSERT INTO exam_attempts (course, total, correct, items) VALUES (?, ?, ?, ?)')
      .run(course, total, correct, JSON.stringify(items));
    return this.getAttempt(Number(info.lastInsertRowid))!;
  }

  getAttempt(id: number): ExamAttemptRow | null {
    const r = this.db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(id) as
      | { id: number; course: string; total: number; correct: number; items: string; created_at: string }
      | undefined;
    return r ? { ...r, items: parseJson<AttemptItem[]>(r.items, []) } : null;
  }

  listAttempts(course: string, limit = 30): ExamAttemptRow[] {
    return (
      this.db.prepare('SELECT * FROM exam_attempts WHERE course = ? ORDER BY id DESC LIMIT ?').all(course, limit) as {
        id: number; course: string; total: number; correct: number; items: string; created_at: string;
      }[]
    ).map((r) => ({ ...r, items: parseJson<AttemptItem[]>(r.items, []) }));
  }
}
