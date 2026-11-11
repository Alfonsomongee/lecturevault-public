/**
 * StudyPipeline — turns a transcribed recording into everything the dashboard shows: the session
 * analysis routed to the campus (title, ranges, course sheet, deliverables, exams, calendar),
 * clean notes (.clean.md + SQLite), alerts, flashcards, glossary and searchable/embedded chunks.
 *
 * Each step is independent and failure-isolated: if flashcards fail (rate limit, bad JSON) the
 * notes are still saved, and the report says exactly what happened. Re-running only does the
 * missing work unless `force` is set.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { CampusRepository } from '../database/CampusRepository.js';
import { ANALYSIS_PROMPT_VERSION, SessionAnalyzer } from '../campus/analysis.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { TranscriptRefiner } from '../ai/TranscriptRefiner.js';
import type { TranscriptSegment } from '../library/transcript-files.js';
import { NOTES_PROMPT_VERSION, composeCleanMd, planNotes, wholeClassRange, type NotesPart, type NotesRange } from './notes-sections.js';
import { StudyGenerator } from './StudyGenerator.js';
import { ExamRepository } from '../database/ExamRepository.js';
import { EXAM_PROMPT_VERSION, ExamQuestionGenerator } from './exam-questions.js';
import { Rag } from '../search/Rag.js';
import { chunkNotes } from '../library/chunker.js';
import { hasKeyPoints, notesBody, summarizeNotes, withSummary } from './class-summary.js';
import { isSafeTranscriptId } from '../utils/ids.js';

export const PIPELINE_STEPS = ['analysis', 'notes', 'summary', 'study', 'exam', 'embeddings'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export interface PipelineOptions {
  force?: boolean;
  steps?: PipelineStep[];
}

export interface PipelineReport {
  recordingId: number;
  analysis: 'created' | 'kept' | 'skipped' | 'failed';
  /** Title shown for the class after the analysis ("Clase 3. …") */
  title: string | null;
  /** New items waiting in the review inbox */
  proposals: number;
  /** 'partial': some ranges got no notes (they are retried next time) */
  notes: 'created' | 'kept' | 'skipped' | 'partial' | 'failed';
  alerts: number;
  flashcards: number;
  glossary: number;
  /** Practice questions written for the exam bank */
  examQuestions: number;
  embedded: number;
  /** Things that worked only partly (not failures) */
  warnings: string[];
  errors: string[];
}

/** True when the class has notes to publish (a partial set still counts: the rest is retried next time). */
export function notesReady(report: Pick<PipelineReport, 'notes'>): boolean {
  return report.notes === 'created' || report.notes === 'kept' || report.notes === 'partial';
}

function emptyReport(recordingId: number): PipelineReport {
  return {
    recordingId, analysis: 'skipped', title: null, proposals: 0, notes: 'skipped',
    alerts: 0, flashcards: 0, glossary: 0, examQuestions: 0, embedded: 0, warnings: [], errors: [],
  };
}

export interface PipelineConfig {
  dataDir: string;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiEmbeddingModel?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  /** Two-pass notes (facts first). Default false (one call per batch); NOTES_FACTS=true turns it on. */
  notesFacts?: boolean;
}

export class StudyPipeline {
  readonly study: StudyRepository;
  readonly campus: CampusRepository;
  readonly exam: ExamRepository;
  private readonly client: GeminiClient;
  private readonly logger?: Logger;

  constructor(
    private readonly db: DatabaseManager,
    private readonly config: PipelineConfig,
    logger?: Logger,
    client?: GeminiClient
  ) {
    this.logger = logger?.child({ component: 'study-pipeline' });
    this.study = new StudyRepository(db.handle);
    this.campus = new CampusRepository(db.handle);
    this.exam = new ExamRepository(db.handle);
    this.client =
      client ??
      new GeminiClient({
        apiKey: config.geminiApiKey ?? '',
        model: config.geminiModel,
        embeddingModel: config.geminiEmbeddingModel,
        deepseekApiKey: config.deepseekApiKey ?? '',
        deepseekModel: config.deepseekModel,
        logger,
      });
  }

  get hasAi(): boolean {
    return this.client.hasKey;
  }

  /** Terms learned from earlier classes of the same course (spelling + Whisper hotwords). */
  courseTerms(course: string, limit = 60): string[] {
    return this.study.courseTerms(course, limit);
  }

  async process(recordingId: number, options: PipelineOptions = {}): Promise<PipelineReport> {
    const steps = new Set<PipelineStep>(options.steps ?? [...PIPELINE_STEPS]);
    const report = emptyReport(recordingId);

    const recording = this.db.getRecordingById(recordingId);
    if (!recording) throw new Error(`No existe la grabación ${recordingId}`);

    const segments = this.study.getSegments(recordingId).map((s) => ({
      start: s.start_ms / 1000,
      end: s.end_ms / 1000,
      text: s.text,
      avg_logprob: s.avg_logprob ?? undefined,
      no_speech_prob: s.no_speech_prob ?? undefined,
    }));
    if (segments.length === 0) throw new Error('La grabación aún no tiene transcripción (ejecuta "ingest" primero).');

    if (!this.client.hasKey) {
      report.errors.push('GEMINI_API_KEY no configurada: solo se indexa el texto para búsqueda.');
      return report;
    }

    const glossary = this.courseTerms(recording.course);
    // midday keeps the ISO day stable in any time zone; without class_date, created_at of an
    // imported transcript is the day Whisper ran, not the class
    const classDate = recording.class_date ? `${recording.class_date}T12:00:00` : recording.created_at;
    const classDateConfirmed = recording.class_date !== null;
    let notesChanged = false;
    let summarized = false;

    // 0. Session analysis: classify by time ranges and route everything to the campus
    if (steps.has('analysis')) {
      if (options.force || recording.analysis_version !== ANALYSIS_PROMPT_VERSION) {
        try {
          const course = recording.course;
          if (course) this.campus.renumberClasses(course);
          const profile = course ? this.campus.getProfile(course) : undefined;
          const entities = (rows: { key: string; title: string }[]) => rows.map(({ key, title }) => ({ key, title }));
          const analysis = await new SessionAnalyzer({ client: this.client, logger: this.logger }).analyze(segments, {
            title: recording.title,
            course,
            classNumber: this.db.getRecordingById(recordingId)!.class_number,
            classDate,
            classDateConfirmed,
            durationSeconds: recording.duration_seconds,
            profileExists: !!profile,
            syllabus: profile?.syllabus,
            known: course
              ? { deliverables: entities(this.campus.listDeliverables(course)), exams: entities(this.campus.listExams(course)) }
              : undefined,
            glossary,
          });
          const applied = this.campus.applyAnalysis(recordingId, analysis, ANALYSIS_PROMPT_VERSION);
          report.analysis = 'created';
          report.title = applied.title;
          report.proposals = applied.proposals;
          report.warnings.push(...applied.skipped);
        } catch (err) {
          report.analysis = 'failed';
          report.errors.push(`Análisis: ${(err as Error).message}`);
        }
      } else {
        report.analysis = 'kept';
      }
    }

    // 1. Notes, written range by range with the destination each range was routed to
    if (steps.has('notes')) {
      try {
        const outcome = await this.writeNotes(recordingId, segments, glossary, options);
        report.notes = outcome.status;
        report.warnings.push(...outcome.warnings);
        notesChanged = outcome.status === 'created' || outcome.status === 'partial';
        summarized = outcome.summarized;
      } catch (err) {
        report.notes = 'failed';
        report.errors.push(`Apuntes: ${(err as Error).message}`);
      }
    }

    // 1b. The summary (paragraph + key points) of notes that do not have the current one: classes written before it
    // existed, or whose summary failed when the notes were written. Never touches the text of the ranges.
    if (steps.has('summary') && !summarized) {
      try {
        const notes = this.study.getNotes(recordingId);
        if (notes && notes.prompt_version !== 'manual' && (options.force || !hasKeyPoints(notes.markdown))) {
          const result = await this.summarizeDocument(notes.markdown, recording.display_title ?? recording.title, recording.course);
          report.warnings.push(...result.warnings);
          if (result.markdown !== null) {
            this.study.snapshotNotes(recordingId, result.markdown);
            this.study.saveNotes(recordingId, result.markdown, notes.model, notes.prompt_version);
            this.writeNotesFile(recording.transcript_id, result.markdown);
            notesChanged = true;
          }
        }
      } catch (err) {
        report.warnings.push(`Resumen: ${(err as Error).message}`);
      }
    }

    // 2. Alerts, flashcards, glossary
    if (steps.has('study')) {
      const hasStudy =
        this.study.listAlerts({ recordingId, includeDismissed: true }).length > 0 ||
        this.study.listFlashcards({ recordingId }).length > 0;
      if (options.force || !hasStudy) {
        try {
          const generator = new StudyGenerator({ client: this.client, logger: this.logger });
          const out = await generator.generate(segments, {
            title: recording.title,
            course: recording.course,
            classDate,
            classDateConfirmed,
            durationSeconds: recording.duration_seconds,
            glossary,
            ranges: this.campus.listNoteSections(recordingId).map(({ start_ms, end_ms, destination }) => ({ start_ms, end_ms, destination })),
          });
          report.alerts = this.study.replaceAlerts(recordingId, out.alerts);
          report.flashcards = this.study.upsertFlashcards(recordingId, out.flashcards);
          report.glossary = this.study.upsertGlossary(recordingId, out.glossary);
        } catch (err) {
          report.errors.push(`Estudio: ${(err as Error).message}`);
        }
      }
    }

    // 2b. Exam question bank (DeepSeek first). Its failure never touches the notes: it is retried next time.
    if (steps.has('exam') && (options.force || recording.exam_version !== EXAM_PROMPT_VERSION)) {
      try {
        const generator = new ExamQuestionGenerator({ client: this.client, logger: this.logger });
        const out = await generator.generate(segments, {
          title: recording.display_title ?? recording.title,
          course: recording.course,
          durationSeconds: recording.duration_seconds,
          ranges: this.campus.listNoteSections(recordingId).map(({ start_ms, end_ms, destination }) => ({ start_ms, end_ms, destination })),
        });
        report.examQuestions = this.exam.replaceQuestions(recordingId, out.questions, generator.model, EXAM_PROMPT_VERSION);
      } catch (err) {
        report.warnings.push(`Preguntas de examen: ${(err as Error).message}`);
      }
    }

    // 3. Retrieval index: rebuild chunks when notes changed, then embed what is missing
    if (notesChanged) {
      const notes = this.study.getNotes(recordingId);
      this.study.replaceChunks(recordingId, 'notes', notes ? chunkNotes(notes.markdown) : []);
    }
    if (steps.has('embeddings')) {
      try {
        report.embedded = await new Rag(this.db.handle, this.client, this.logger).indexEmbeddings();
      } catch (err) {
        report.errors.push(`Embeddings: ${(err as Error).message}`);
      }
    }

    this.logger?.info({ report }, 'Procesado de estudio terminado');
    return report;
  }

  /** Process every transcribed recording that still lacks something. */
  async processPending(options: PipelineOptions = {}): Promise<PipelineReport[]> {
    const reports: PipelineReport[] = [];
    for (const row of this.study.getOverview()) {
      if (row.segment_count === 0) continue;
      const missing =
        !row.has_notes ||
        (row.alert_count === 0 && row.flashcard_count === 0) ||
        this.db.getRecordingById(row.id)?.analysis_version !== ANALYSIS_PROMPT_VERSION ||
        this.db.getRecordingById(row.id)?.exam_version !== EXAM_PROMPT_VERSION;
      if (!options.force && !missing) continue;
      try {
        reports.push(await this.process(row.id, options));
      } catch (err) {
        reports.push({ ...emptyReport(row.id), notes: 'failed', errors: [(err as Error).message] });
      }
    }
    return reports;
  }

  /**
   * Write the class notes range by range and recompose the document from the ranges. What gets
   * written depends on `planNotes`: everything, only the ranges that have no text yet, or nothing.
   * Without ranges (the analysis has not run or failed) the whole class goes as one theory range.
   */
  private async writeNotes(
    recordingId: number,
    segments: TranscriptSegment[],
    glossary: string[],
    options: PipelineOptions
  ): Promise<{ status: PipelineReport['notes']; warnings: string[]; summarized: boolean }> {
    const recording = this.db.getRecordingById(recordingId)!;
    const rows = this.campus.listNoteSections(recordingId);
    const plan = planNotes({
      notes: this.study.getNotes(recordingId),
      sections: rows,
      version: NOTES_PROMPT_VERSION,
      force: !!options.force,
      explicit: !!options.steps?.includes('notes'),
    });
    if (plan === 'none') return { status: 'kept', warnings: [], summarized: false };

    const course = recording.course;
    const titles = new Map<string, string>();
    if (course) {
      for (const d of this.campus.listDeliverables(course)) titles.set(`deliverable:${d.id}`, d.title);
      for (const e of this.campus.listExams(course)) titles.set(`exam:${e.id}`, e.title);
    }
    const lastEnd = segments[segments.length - 1]?.end ?? 0;
    const durationMs = Math.round(Math.max(recording.duration_seconds, lastEnd) * 1000);
    const ranges: NotesRange[] = rows.length
      ? rows.map((s) => ({
          ord: s.ord, start_ms: s.start_ms, end_ms: s.end_ms, destination: s.destination, heading: s.heading,
          entity_title: s.entity_id !== null ? titles.get(`${s.destination}:${s.entity_id}`) ?? null : null,
        }))
      : [wholeClassRange(durationMs)];
    const missing = new Set(rows.filter((s) => !s.markdown.trim()).map((s) => s.ord));
    const only = plan === 'all' || rows.length === 0 ? undefined : ranges.filter((r) => missing.has(r.ord)).map((r) => r.ord);

    const refiner = new TranscriptRefiner({ client: this.client, logger: this.logger, facts: this.config.notesFacts });
    const result = await refiner.refineSections(segments, ranges, { title: recording.display_title ?? recording.title, course, glossary }, only);
    if (result.sections.length === 0 && result.silent.length === 0) {
      throw new Error(result.errors[0] ?? 'La IA no devolvió apuntes para ningún tramo.');
    }

    // What every range holds now: the new text, or nothing where the model failed (so a later run retries it)
    const written = new Map(result.sections.map((s) => [s.ord, s]));
    const targets = ranges.filter((r) => r.destination !== 'admin' && (only === undefined || only.includes(r.ord)));
    const stored = targets.map((r) => {
      if (result.silent.includes(r.ord)) return { ord: r.ord, gist: '', markdown: '*(Sin voz en este tramo.)*' };
      return written.get(r.ord) ?? { ord: r.ord, gist: '', markdown: '' };
    });
    if (rows.length) this.campus.setSectionNotes(recordingId, stored);

    const current = rows.length ? this.campus.listNoteSections(recordingId) : [];
    const parts: NotesPart[] = rows.length
      ? ranges.map((range) => {
          const row = current.find((s) => s.ord === range.ord);
          return { range, gist: row?.gist ?? '', markdown: row?.markdown ?? '' };
        })
      : stored.map((s) => ({ range: ranges[0]!, gist: s.gist, markdown: s.markdown }));
    const title = recording.display_title ?? recording.title;
    const composed = composeCleanMd(title, parts);
    // Which model wrote the notes is read now: the summary call below may be answered by another one
    const notesModel = this.client.lastModelUsed;
    // The summary is written from the finished document; when it fails the per-range gists stay as the summary
    const summary = await this.summarizeDocument(composed, title, course).catch((err: Error) => ({
      markdown: null, warnings: [`Resumen: ${err.message}`],
    }));
    const markdown = summary.markdown ?? composed;

    this.study.snapshotNotes(recordingId, markdown);
    this.study.saveNotes(recordingId, markdown, notesModel, NOTES_PROMPT_VERSION);
    this.writeNotesFile(recording.transcript_id, markdown);
    return {
      status: result.failed.length > 0 ? 'partial' : 'created',
      warnings: [...result.warnings, ...summary.warnings],
      summarized: summary.markdown !== null,
    };
  }

  /** The notes document with a model-written summary under its title, or null (and why) when none could be made. */
  private async summarizeDocument(markdown: string, title: string, course: string): Promise<{ markdown: string | null; warnings: string[] }> {
    const { summary, warnings } = await summarizeNotes(this.client, notesBody(markdown), { title, course });
    return { markdown: summary ? withSummary(markdown, summary) : null, warnings };
  }

  /** Keep the notes file next to the transcript so data/ stays the source of truth. */
  private writeNotesFile(transcriptId: string | null, markdown: string): void {
    if (!transcriptId || !isSafeTranscriptId(transcriptId)) return;
    const dir = path.join(this.config.dataDir, 'transcripts', transcriptId);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(path.join(dir, `${transcriptId}.clean.md`), markdown, 'utf8');
    fs.writeFileSync(path.join(dir, `${transcriptId}.clean.txt`), markdown, 'utf8');
  }
}
