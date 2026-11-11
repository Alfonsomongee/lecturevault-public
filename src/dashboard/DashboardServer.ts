/**
 * LectureVault — Dashboard Server
 *
 * Express-based local dashboard bound to localhost only.
 * Serves the study-campus UI and a JSON API: library, notes, transcript, audio (with Range),
 * full-text search, "ask your classes", alerts + calendar, flashcards + Anki export.
 *
 * Local-only does not mean unguarded: any web page you visit can try to talk to
 * http://localhost:<port>. Every request is checked against the expected Host (DNS-rebinding)
 * and every mutating request against the expected Origin (CSRF); responses carry a strict CSP.
 */

import express from 'express';
import fs from 'node:fs';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { DatabaseManager } from '../database/DatabaseManager.js';
import { StudyRepository, byClassOrder, type AlertKind, type AlertRow } from '../database/StudyRepository.js';
import { ExamRepository } from '../database/ExamRepository.js';
import { EXAM_PROMPT_VERSION } from '../study/exam-questions.js';
import { CampusRepository, type EventKind, type EventPatch } from '../database/CampusRepository.js';
import { ANALYSIS_PROMPT_VERSION, canonicalTopics } from '../campus/analysis.js';
import { gradeProjection } from '../campus/grades.js';
import { foldWs } from '../utils/text.js';
import { extractKeyPoints, extractSummary, summaryLine, withClassTitle } from '../study/notes-summary.js';
import type { RecordingStatus } from '../types.js';
import { SearchIndex } from '../search/SearchIndex.js';
import { Rag } from '../search/Rag.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { AiQueue } from '../study/AiQueue.js';
import { StudyPipeline, PIPELINE_STEPS, notesReady, type PipelineStep } from '../study/StudyPipeline.js';
import { NOTES_PROMPT_VERSION } from '../study/notes-sections.js';
import { PdfExporter } from '../export/PdfExporter.js';
import { CaptureRunner, CaptureBusyError, selfCommand, type CaptureCommand, type LiveCaptureOptions } from '../capture/CaptureRunner.js';
import { LIVE_CAPTURE_ID } from '../capture/progress.js';
import { venvPython } from '../transcriber/transcribe-cli.js';
import { contentDisposition, stripLeadingTitle, theoryMarkdown } from '../export/pdf-content.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { findPlaybackAudio } from '../library/audio.js';
import { segmentsToVtt } from '../library/transcript-files.js';
import { buildAnkiTsv, buildIcs, parseReminderDays, DEFAULT_REMINDERS, type Reminders } from '../study/exporters.js';
import { weeklyLoad, describeWeek } from '../campus/workload.js';
import { addDays, localCalendarDate, parseIso, toIso } from '../study/dates.js';
import { fetchLmsFeed } from '../campus/lms-sync.js';
import { CourseCatalog, courseLabel, COURSES_FILE } from '../library/courses.js';
import { chunkNotes } from '../library/chunker.js';
import { isSafeTranscriptId, sanitizeRecordingId } from '../utils/ids.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import { moveToTrash, purgeTrash, TRASH_DAYS } from '../utils/trash.js';
import { autoBackupDue, backupDatabase, listBackups } from '../database/backup.js';
import { refreshSharedWebIfRealData } from '../cli/export-web.js';
import { loadDailyState } from '../campus/daily-state.js';
import { loadMaterialsIndex, materialsDir } from '../campus/materials-sync.js';

/** "04MUIN" of "04MUIN Tecnología electrónica e instrumentación" (the folder of its materials). */
const courseCodeOf = (course: string) => course.trim().split(/\s+/)[0] ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DashboardConfig {
  port: number;
  /** Root of data/ (audio, transcripts). Default: data/ in the project folder */
  dataDir?: string;
  /** Where the database copies go (BACKUP_DIR). Default: backups/ inside dataDir */
  backupDir?: string;
  /** Take a copy of the database once a day while the server runs (the real server turns it on) */
  autoBackup?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  geminiEmbeddingModel?: string;
  deepseekApiKey?: string;
  deepseekModel?: string;
  notesFacts?: boolean;
  /** Called when a class's notes are ready (AUTO_GIT_SYNC: commit and push, so Vercel deploys). Tests leave it out. */
  publishTranscript?: (transcriptId: string) => Promise<unknown>;
  /** The university's .ics feed, synced into the calendar on start and every LMS_SYNC_MS */
  lmsCalendarUrl?: string;
  /** What "Grabar y transcribir" runs for these recording ids (tests replace it: the default opens a browser) */
  captureCommand?: (ids: number[]) => CaptureCommand;
  /** What the "+" button runs for a class chosen in the campus (tests replace it, too) */
  liveCaptureCommand?: (options: LiveCaptureOptions) => CaptureCommand;
}

const LMS_SYNC_MS = 6 * 60 * 60 * 1000;

/** Query value that selects recordings without a course (an empty string means "no filter" in URLs). */
export const NO_COURSE = '__none__';

const REMINDER_KEYS = ['reminders_exam', 'reminders_deadline', 'reminders_other'];

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export class DashboardServer {
  private app: express.Application;
  private server: ReturnType<express.Application['listen']> | null = null;
  private db: DatabaseManager;
  private study: StudyRepository;
  private campus: CampusRepository;
  private exam: ExamRepository;
  private search: SearchIndex;
  private config: DashboardConfig;
  private logger: Logger;
  private dataDir: string;
  private backupDir: string;
  private client: GeminiClient;
  private queue: AiQueue;
  private pdf: PdfExporter;
  private capture: CaptureRunner;
  private rate = new Map<string, number[]>();

  constructor(db: DatabaseManager, config: DashboardConfig, logger: Logger) {
    this.db = db;
    this.config = config;
    this.logger = logger.child({ component: 'dashboard' });
    this.dataDir = path.resolve(config.dataDir ?? path.join(PROJECT_ROOT, 'data'));
    this.backupDir = path.resolve(config.backupDir ?? path.join(this.dataDir, 'backups'));
    this.study = new StudyRepository(db.handle);
    this.campus = new CampusRepository(db.handle);
    this.exam = new ExamRepository(db.handle);
    this.search = new SearchIndex(db.handle);
    this.client = new GeminiClient({
      apiKey: config.geminiApiKey ?? '',
      model: config.geminiModel,
      embeddingModel: config.geminiEmbeddingModel,
      deepseekApiKey: config.deepseekApiKey ?? '',
      deepseekModel: config.deepseekModel,
      logger,
    });
    this.queue = new AiQueue(db.handle, (recordingId, { force, steps }) => new StudyPipeline(this.db, {
      dataDir: this.dataDir,
      geminiApiKey: this.config.geminiApiKey,
      geminiModel: this.config.geminiModel,
      geminiEmbeddingModel: this.config.geminiEmbeddingModel,
      deepseekApiKey: this.config.deepseekApiKey,
      deepseekModel: this.config.deepseekModel,
      notesFacts: this.config.notesFacts,
    }, this.logger, this.client).process(recordingId, { force, steps: steps as PipelineStep[] | undefined }).then(async (rep) => {
      await refreshSharedWebIfRealData(this.db, this.dataDir, { logger: this.logger, quiet: true });
      // Notes are ready: upload them (and the refreshed web) so Vercel deploys them. A failed upload is
      // logged by the hook and never turns a finished job into a failed one.
      const transcriptId = this.db.getRecordingById(recordingId)?.transcript_id;
      if (transcriptId && notesReady(rep) && this.config.publishTranscript) {
        await this.config.publishTranscript(transcriptId).catch((err) => {
          this.logger.warn({ err: (err as Error).message, transcriptId }, 'Could not upload the notes');
        });
      }
      return rep;
    }), this.logger);
    this.pdf = new PdfExporter(() => `http://127.0.0.1:${this.port}`, this.logger);
    // The same flow as `npm run batch:transcribe`, started from here: at 2x and muted, with the window visible
    // so a campus login can be done in it. Only ids of known recordings ever reach the command line.
    this.capture = new CaptureRunner({
      command: config.captureCommand ?? ((ids) => selfCommand(['batch-transcribe', '--id', ids.join(','), '--speed', '2', '--silent'], PROJECT_ROOT)),
      logger: this.logger,
    });
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  // ── Middleware ────────────────────────────────────────────────────────────

  private lmsTimer: NodeJS.Timeout | null = null;

  /**
   * Fetch the university calendar and merge it into events. Courses are named as in the catalog when their
   * code is there, else as the campus names them (and listed in Ajustes to add). Status goes to settings;
   * the URL never reaches a log or a response, since it carries a personal token.
   */
  private async syncLmsCalendar(options: { force?: boolean } = {}): Promise<void> {
    const url = this.config.lmsCalendarUrl;
    if (!url) throw new HttpError(400, 'Falta LMS_CALENDAR_URL en .env');
    const now = new Date().toISOString();
    try {
      const { items, total, skipped, unknown } = await fetchLmsFeed(url, this.dataDir);
      const result = this.campus.syncLmsEvents(items, toIso(localCalendarDate(new Date())), options);
      this.campus.applyOfficialTimetable();
      if (result.held) this.logger.warn({ held: result.held, feed: total }, 'university calendar: removals held back, the feed looks incomplete');
      this.study.setSetting('lms_last_sync', now);
      this.study.setSetting('lms_last_result', JSON.stringify({ ...result, total, skipped }));
      this.study.setSetting('lms_unknown_courses', JSON.stringify([...unknown].map(([code, name]) => ({ code, name }))));
      this.study.setSetting('lms_last_error', '');
      this.logger.info({ ...result, total }, 'university calendar synced');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.study.setSetting('lms_last_error', `${now} ${message}`);
      this.logger.warn({ error: message }, 'university calendar sync failed');
      throw new HttpError(502, `No se pudo leer el calendario de la universidad: ${message}`);
    }
  }

  private stopped = false;

  /**
   * Embed the chunks that still have no vector (classes ingested without AI, a step that failed) while nobody
   * waits. One run at a time (Rag dedupes), and a failure only means those chunks stay lexical-only for now.
   */
  private indexEmbeddingsInBackground(): void {
    if (!this.client.hasEmbeddingKey || this.stopped) return;
    new Rag(this.db.handle, this.client, this.logger).indexEmbeddings()
      .catch((err) => { if (!this.stopped) this.logger.warn({ err: (err as Error).message }, 'embeddings could not be indexed'); });
  }

  private backupTimer: NodeJS.Timeout | null = null;
  private backupRun: Promise<void> | null = null;

  /** One copy of the database a day while the server runs: checked at start and every hour after. */
  private autoBackupIfDue(): void {
    if (this.stopped || this.backupRun || !autoBackupDue(this.backupDir)) return;
    this.backupRun = backupDatabase(this.db.handle, this.backupDir, 'auto')
      .then((file) => { this.logger.info({ file }, 'daily database copy made'); })
      .catch((err) => { if (!this.stopped) this.logger.warn({ err: (err as Error).message }, 'daily database copy failed'); })
      .finally(() => { this.backupRun = null; });
  }

  private lmsStatus() {
    const s = this.study.getSettings('lms_');
    const json = <T>(v: string | undefined, fallback: T): T => { try { return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
    let host = '';
    try { host = this.config.lmsCalendarUrl ? new URL(this.config.lmsCalendarUrl).host : ''; } catch { /* bad URL: reported on sync */ }
    return {
      configured: !!this.config.lmsCalendarUrl,
      host,
      last_sync: s['lms_last_sync'] || null,
      result: json(s['lms_last_result'], null),
      error: s['lms_last_error'] || null,
      unknown_courses: json<{ code: string; name: string }[]>(s['lms_unknown_courses'], [])
        .filter((c) => !CourseCatalog.load(this.dataDir).courses.some((k) => k.code.toUpperCase() === c.code)),
    };
  }

  private get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.config.port;
  }

  private allowedHosts(): string[] {
    const p = this.port;
    return [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`];
  }

  private setupMiddleware(): void {
    // Security headers + Host/Origin guards come first, before anything is served.
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      const host = (req.headers.host ?? '').toLowerCase();
      if (!this.allowedHosts().includes(host)) {
        res.status(403).json({ error: 'Host no permitido' });
        return;
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && !this.allowedHosts().some((h) => origin === `http://${h}`)) {
          res.status(403).json({ error: 'Origen no permitido' });
          return;
        }
        if (!req.is('application/json')) {
          res.status(415).json({ error: 'Se requiere Content-Type: application/json' });
          return;
        }
      }
      next();
    });

    this.app.use(express.json({ limit: '1mb' }));

    // Static UI + vendored libraries (no CDN: the dashboard works offline)
    const root = path.resolve(__dirname, '../..');
    this.app.use('/vendor/katex', express.static(path.join(root, 'node_modules/katex/dist'), { index: false }));
    this.app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/marked/lib/marked.umd.js')));
    this.app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/dompurify/dist/purify.min.js')));
    this.app.use('/compartido', express.static(path.join(root, 'docs')));
    this.app.use(express.static(path.join(root, 'public')));

    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      this.logger.debug({ method: req.method, path: req.path }, 'request');
      next();
    });
  }

  /** Tiny in-memory limiter for the endpoints that cost API quota. */
  private limit(name: string, max: number, windowMs = 60_000): RequestHandler {
    return (_req, res, next) => {
      const now = Date.now();
      const hits = (this.rate.get(name) ?? []).filter((t) => now - t < windowMs);
      if (hits.length >= max) {
        res.status(429).json({ error: 'Demasiadas peticiones; espera un momento.' });
        return;
      }
      hits.push(now);
      this.rate.set(name, hits);
      next();
    };
  }

  private wrap(handler: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler {
    return (req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => {
          if (err instanceof HttpError) {
            res.status(err.status).json({ error: err.message });
            return;
          }
          this.logger.error({ err, path: req.path }, 'Request failed');
          res.status(500).json({ error: 'Internal server error' });
        });
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private parseId(raw: unknown): number {
    const text = String(raw ?? '');
    if (!/^\d{1,9}$/.test(text)) throw new HttpError(400, 'Identificador no válido');
    return parseInt(text, 10);
  }

  private optionalId(raw: unknown): number | undefined {
    return raw === undefined || raw === '' ? undefined : this.parseId(raw);
  }

  private recording(req: Request) {
    const rec = this.db.getRecordingById(this.parseId(req.params['id']));
    if (!rec) throw new HttpError(404, 'Grabación no encontrada');
    return rec;
  }

  private str(value: unknown, max = 200): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  }

  /**
   * The theory of a course by topic, in class order: project sessions live under their deliverable, and a
   * mixed session only counts through its theory ranges. Shared by the Teoría view and the PDF of the course.
   */
  private theoryByTopic(course: string) {
    const syllabus = this.campus.getProfile(course)?.syllabus ?? [];
    type Session = ReturnType<StudyRepository['getOverview']>[number];
    const groups = new Map<string, { session: Session; theory: ReturnType<CampusRepository['listNoteSections']> }[]>();
    const sessions = this.study.getOverview({ course }).sort(byClassOrder);
    const topicNames = canonicalTopics(sessions.map((s) => s.topic), syllabus);
    for (const session of sessions) {
      if (session.session_kind === 'project') continue;
      const sections = this.campus.listNoteSections(session.id);
      const theory = sections.filter((x) => x.destination === 'theory');
      if (sections.length > 0 && theory.length === 0) continue;
      const key = topicNames.get(session.topic) ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ session, theory });
    }
    const order = (topic: string) => {
      const n = /^Tema\s+(\d+)/i.exec(topic)?.[1];
      return topic ? (n ? Number(n) : 500) : 1000;
    };
    return {
      syllabus,
      groups: [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([topic, classes]) => ({ topic, classes })),
    };
  }

  /** Why a capture cannot start right now, or null. Better to say so before a browser opens and an hour is spent. */
  private captureProblem(): string | null {
    if (this.config.captureCommand || this.config.liveCaptureCommand) return null;
    if (!fs.existsSync(venvPython(PROJECT_ROOT))) {
      return 'Falta el entorno de Python para transcribir (carpeta .venv). Créalo con: python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt';
    }
    return null;
  }

  private captureStatus() {
    return { ...this.capture.status(), problem: this.captureProblem() };
  }

  /** The course a live capture is for: one of the catalog or one that already has classes. Nothing else reaches the command. */
  private liveCourse(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) throw new HttpError(400, 'Elige la asignatura de la clase');
    if (value.length > 120 || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, 'Asignatura no válida');
    const found = CourseCatalog.load(this.dataDir).find(value);
    if (found) return courseLabel(found);
    if (this.db.getCourses().some((c) => c.course === value)) return value;
    throw new HttpError(400, 'Esa asignatura no está en tu catálogo');
  }

  private liveDate(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !parseIso(raw)) throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
    if (raw > toIso(localCalendarDate(new Date()))) throw new HttpError(400, 'La fecha de una clase grabada no puede ser futura');
    return raw;
  }

  private liveCaptureCommand(options: LiveCaptureOptions): CaptureCommand {
    if (this.config.liveCaptureCommand) return this.config.liveCaptureCommand(options);
    return selfCommand(
      ['capture-and-transcribe', '--course', options.course, ...(options.date ? ['--date', options.date] : []), '--speed', String(options.speed), '--silent'],
      PROJECT_ROOT
    );
  }

  private sendPdf(res: Response, pdf: Buffer, title: string): void {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition(title), 'Cache-Control': 'no-store' });
    res.send(pdf);
  }

  /** Persist notes (history kept), mirror them to data/ and refresh the search chunks. */
  private saveNotes(rec: { id: number; transcript_id: string | null }, markdown: string): void {
    this.study.editNotes(rec.id, markdown);
    this.study.replaceChunks(rec.id, 'notes', chunkNotes(markdown));
    if (rec.transcript_id && isSafeTranscriptId(rec.transcript_id)) {
      const dir = path.join(this.dataDir, 'transcripts', rec.transcript_id);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, `${rec.transcript_id}.clean.md`), markdown, 'utf8');
        fs.writeFileSync(path.join(dir, `${rec.transcript_id}.clean.txt`), markdown, 'utf8');
      }
    }
    void refreshSharedWebIfRealData(this.db, this.dataDir, { logger: this.logger, quiet: true });
  }

  private oneLineSummary(recordingId: number): string {
    return summaryLine(extractSummary(this.study.getNotes(recordingId)?.markdown));
  }

  /** The student's subject list (data/courses.json); read per request, it is tiny and editable by hand. */
  private catalogPayload() {
    const catalog = CourseCatalog.load(this.dataDir);
    return catalog.courses.map((c) => ({ code: c.code, name: c.name, teacher: c.teacher ?? '', label: courseLabel(c) }));
  }

  /** `?course=` filter: absent/blank → all courses; "__none__" → recordings without a course. */
  /** undefined when absent, null when cleared ('' or null), else a number within [min, max]. */
  private number(value: unknown, min: number, max: number, label: string): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}: tiene que estar entre ${min} y ${max}`);
    return n;
  }

  /** Repository rules (a loop in the grading tree, another course's parent) come back as 400s. */
  private gradeWrite<T>(write: () => T): T {
    try {
      return write();
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'No se pudo guardar');
    }
  }

  private course(value: unknown): string | undefined {
    const text = this.str(value, 80);
    return text === NO_COURSE ? '' : text;
  }

  private hasAudio(transcriptId: string | null): boolean {
    return findPlaybackAudio(this.dataDir, transcriptId) !== null;
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  private setupRoutes(): void {
    const api = express.Router();

    api.get('/health', (_req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString(), ai: this.client.hasKey });
    });

    // Library overview (kept backwards compatible: `recordings`, `stats`, `timestamp`)
    api.get('/recordings', this.wrap((req, res) => {
      const status = req.query['status'] as RecordingStatus | undefined;
      const valid: RecordingStatus[] = ['new', 'seen', 'processed'];
      const course = this.course(req.query['course']);
      const recordings = this.study
        .getOverview({ status: status && valid.includes(status) ? status : undefined, course })
        .map((r) => ({ ...r, has_audio: this.hasAudio(r.transcript_id), summary: this.oneLineSummary(r.id) }));

      res.json({
        recordings,
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
        courses: this.db.getCourses(),
        catalog: this.catalogPayload(),
        ai: this.client.hasKey,
        timestamp: new Date().toISOString(),
      });
    }));

    api.get('/stats', this.wrap((_req, res) => {
      res.json({ ...this.db.getStats(), ...this.study.getStudyStats() });
    }));

    // Light sidebar/nav data (the SPA polls this; the full library list is only fetched by the library view)
    api.get('/meta', this.wrap((_req, res) => {
      res.json({
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
        courses: this.db.getCourses(),
        catalog: this.catalogPayload(),
        pending: this.db.getPendingCaptures().length,
        proposals: this.campus.listProposals({ status: 'open' }).length,
        ai: this.client.hasKey,
      });
    }));

    api.get('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const notes = this.study.getNotes(rec.id);
      // A session recorded in several parts (recording_1, recording_2): the class shows "Parte 1 de 2"
      const sessionParts = rec.course && rec.session_number
        ? (this.db.handle.prepare('SELECT COUNT(*) AS n FROM recordings WHERE course = ? AND session_number = ?').get(rec.course, rec.session_number) as { n: number }).n
        : 1;
      res.json({
        recording: rec,
        session_parts: sessionParts,
        has_audio: this.hasAudio(rec.transcript_id),
        notes: notes ? { markdown: withClassTitle(notes.markdown, rec.display_title), model: notes.model, created_at: notes.created_at } : null,
        summary: extractSummary(notes?.markdown),
        key_points: extractKeyPoints(notes?.markdown),
        alerts: this.study.listAlerts({ recordingId: rec.id, includeDismissed: true }),
        flashcards: this.study.listFlashcards({ recordingId: rec.id }),
        glossary: this.study.listGlossaryForRecording(rec.id),
        markers: this.study.listMarkers(rec.id),
        position: Number(this.study.getSetting(`pos:${rec.id}`) ?? 0),
        versions: this.study.listNoteVersions(rec.id),
        ai: this.client.hasKey,
        campus: {
          // Without the text: the class view already gets the whole notes, and each range would double the payload
          sections: this.campus.listNoteSections(rec.id).map(({ markdown: _markdown, ...s }) => ({ ...s, entity_title: this.entityTitle(s.destination, s.entity_id) })),
          highlights: this.campus.listAiMarkers(rec.id),
          mentions: this.campus.listRecordingMentions(rec.id),
          events: this.campus.listEvents({ recordingId: rec.id }),
          tasks: this.campus.listRecordingTasks(rec.id),
        },
      });
    }));

    api.patch('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const course = typeof req.body?.course === 'string' ? req.body.course.trim().slice(0, 80) : undefined;
      const date = req.body?.date;
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : undefined;
      const classNumber = req.body?.class_number;
      const ignored = req.body?.ignored;
      if (course === undefined && date === undefined && !title && classNumber === undefined && ignored === undefined) {
        throw new HttpError(400, 'Falta "course", "date", "title", "class_number" o "ignored"');
      }
      if (ignored !== undefined && typeof ignored !== 'boolean') throw new HttpError(400, '"ignored" debe ser true o false');
      if (classNumber !== undefined && classNumber !== null && !(Number.isInteger(classNumber) && classNumber > 0 && classNumber < 1000)) {
        throw new HttpError(400, 'Número de clase no válido');
      }
      // A rename is the campus title, locked against the AI; the Collab2 title stays for sync (B5)
      if (title) this.campus.setDisplayTitle(rec.id, title, 'user');
      if (classNumber !== undefined) this.campus.setClassNumber(rec.id, classNumber);
      if (ignored !== undefined) this.db.setIgnored(rec.id, ignored);
      if (course !== undefined) this.db.setCourse(rec.id, course === NO_COURSE ? '' : CourseCatalog.load(this.dataDir).resolve(course));
      if (date !== undefined) {
        // The class date anchors relative deadlines ("hasta el día 20"), so it must be a real calendar day
        if (typeof date !== 'string' || !parseIso(date)) throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
        this.db.setCreatedAt(rec.id, new Date(`${date}T10:00:00`).toISOString(), 'user');
      }
      res.json({ recording: this.db.getRecordingById(rec.id) });
    }));

    // Move several classes to a course at once (typed value is resolved through the catalog: "03" → "03MUIN …")
    api.post('/recordings/assign', this.wrap((req, res) => {
      const ids: unknown = req.body?.ids;
      const course = typeof req.body?.course === 'string' ? req.body.course.trim().slice(0, 120) : undefined;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || course === undefined) {
        throw new HttpError(400, 'Indica "ids" (1-500) y "course"');
      }
      const label = course === NO_COURSE ? '' : CourseCatalog.load(this.dataDir).resolve(course);
      let updated = 0;
      for (const raw of ids) {
        const rec = this.db.getRecordingById(this.parseId(raw));
        if (rec) { this.db.setCourse(rec.id, label); updated++; }
      }
      res.json({ updated, course: label });
    }));

    api.get('/recordings/:id/segments', this.wrap((req, res) => {
      const rec = this.recording(req);
      res.json({
        segments: this.study.getSegments(rec.id).map((s) => ({
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text: s.text,
          doubtful: (s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1.0,
        })),
      });
    }));

    api.get('/recordings/:id/subtitles.vtt', this.wrap((req, res) => {
      const rec = this.recording(req);
      const segs = this.study.getSegments(rec.id).map((s) => ({ start: s.start_ms / 1000, end: s.end_ms / 1000, text: s.text }));
      res.type('text/vtt').send(segmentsToVtt(segs));
    }));

    // Audio: path comes from the DB and a validated id, never from the client. sendFile gives Range support.
    api.get('/recordings/:id/audio', this.wrap((req, res) => {
      const rec = this.recording(req);
      const audio = findPlaybackAudio(this.dataDir, rec.transcript_id);
      if (!audio) throw new HttpError(404, 'Esta grabación no tiene audio local');
      res.sendFile(audio.file, { root: audio.dir, acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=3600' } });
    }));

    // "Generar con IA" goes through the background queue: the request only queues, the worker runs Gemini
    api.post('/jobs', this.limit('process', 10), this.wrap((req, res) => {
      if (!this.client.hasKey) throw new HttpError(400, 'Configura GEMINI_API_KEY en .env para generar apuntes con IA.');
      const ids: unknown = req.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 300) throw new HttpError(400, 'Indica "ids" (1-300)');
      const recordings = [...new Set(ids.map((raw) => this.parseId(String(raw))))].map((id) => {
        const rec = this.db.getRecordingById(id);
        if (!rec) throw new HttpError(404, `Grabación ${id} no encontrada`);
        if (!rec.transcript_id) throw new HttpError(400, `«${rec.display_title ?? rec.title}» aún no tiene transcripción`);
        return rec;
      });
      const steps: unknown = req.body?.steps;
      if (steps !== undefined && (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => (PIPELINE_STEPS as readonly unknown[]).includes(s)))) {
        throw new HttpError(400, `"steps" debe ser una lista de: ${PIPELINE_STEPS.join(', ')}`);
      }
      const result = this.queue.enqueue(recordings.map((r) => r.id), req.body?.force === true, steps as string[] | undefined);
      res.status(202).json({ ...result, ...this.queue.status() });
    }));

    // "Grabar y transcribir": captures pending Collab2 classes in a child process (one run at a time) and
    // follows it. The ids are checked against the pending list here; nothing from the client reaches the command.
    api.get('/capture', this.wrap((_req, res) => {
      res.json(this.captureStatus());
    }));

    api.post('/capture', this.limit('capture', 20), this.wrap((req, res) => {
      const problem = this.captureProblem();
      if (problem) throw new HttpError(400, problem);
      const pending = this.db.getPendingCaptures();
      let chosen: typeof pending;
      if (req.body?.all === true) {
        chosen = [...pending].sort((a, b) => a.created_at.localeCompare(b.created_at)); // class order
      } else {
        const ids: unknown = req.body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) throw new HttpError(400, 'Indica "ids" (1-50) o "all": true');
        const byId = new Map(pending.map((r) => [r.id, r]));
        chosen = [...new Set(ids.map((raw) => this.parseId(String(raw))))].map((id) => {
          const rec = byId.get(id);
          if (!rec) throw new HttpError(400, `La grabación ${id} no está pendiente de capturar (ya tiene transcripción, es local o está ignorada)`);
          return rec;
        });
      }
      if (chosen.length === 0) throw new HttpError(400, 'No hay clases pendientes de capturar');
      try {
        this.capture.start(chosen.map((r) => ({ id: r.id, title: r.display_title ?? r.title })));
      } catch (err) {
        if (err instanceof CaptureBusyError) throw new HttpError(409, err.message);
        throw err;
      }
      res.status(202).json(this.captureStatus());
    }));

    // "+": a class the student picks in the campus. They say which subject it is; the campus opens in a window
    // and the capture waits for their "Empezar a grabar" (the ENTER of the terminal flow).
    api.post('/capture/live', this.limit('capture-live', 20), this.wrap((req, res) => {
      const problem = this.captureProblem();
      if (problem) throw new HttpError(400, problem);
      const course = this.liveCourse(req.body?.course);
      const date = this.liveDate(req.body?.date);
      const speed = req.body?.speed === undefined ? 2 : Number(req.body.speed);
      if (![1, 2].includes(speed)) throw new HttpError(400, 'La velocidad tiene que ser 1 o 2 (a 4× el audio se estropea y Whisper no entiende la clase)');
      try {
        this.capture.start([{ id: LIVE_CAPTURE_ID, title: `Clase nueva · ${course.split(' ')[0]}` }], this.liveCaptureCommand({ course, ...(date ? { date } : {}), speed }));
      } catch (err) {
        if (err instanceof CaptureBusyError) throw new HttpError(409, err.message);
        throw err;
      }
      res.status(202).json(this.captureStatus());
    }));

    // The ENTER a live capture asks for: "Empezar a grabar" while waiting, "Parar y guardar" while recording
    api.post('/capture/enter', this.wrap((_req, res) => {
      if (!this.capture.enter()) throw new HttpError(409, 'Ahora no hay nada que empezar o parar: si acabas de pulsar, espera a que la captura avance');
      res.json(this.captureStatus());
    }));

    // Close the notice of a finished run
    api.post('/capture/dismiss', this.wrap((_req, res) => {
      this.capture.clear();
      res.json(this.captureStatus());
    }));

    api.post('/capture/cancel', this.wrap((_req, res) => {
      const stopped = this.capture.cancel(); // false when nothing was running
      res.json({ stopped, ...this.captureStatus() });
    }));

    // Classes whose notes come from an older prompt: what "Regenerar apuntes" would rewrite
    api.get('/notes/outdated', this.wrap((_req, res) => {
      res.json({ version: NOTES_PROMPT_VERSION, ids: this.study.listOutdatedNotes(NOTES_PROMPT_VERSION) });
    }));

    api.get('/jobs', this.wrap((req, res) => {
      const since = Number(req.query['since']);
      res.json(this.queue.status(Number.isInteger(since) && since > 0 ? since : 0));
    }));

    api.post('/jobs/cancel', this.wrap((req, res) => {
      const id = req.body?.id === undefined ? undefined : this.parseId(String(req.body.id));
      res.json({ cancelled: this.queue.cancel(id) });
    }));

    api.post('/ingest', this.limit('ingest', 6), this.wrap((_req, res) => {
      const result = new TranscriptIngestor(this.db, this.dataDir, this.logger).ingestAll();
      void refreshSharedWebIfRealData(this.db, this.dataDir, { logger: this.logger, quiet: true });
      res.json({ result });
    }));

    // Full-text search
    api.get('/search', this.wrap((req, res) => {
      const q = this.str(req.query['q'], 200);
      if (!q) {
        res.json({ query: '', corrected: [], hits: [] });
        return;
      }
      const recordingId = this.optionalId(req.query['recording']);
      res.json(this.search.search(q, { course: this.course(req.query['course']), recordingId, limit: 60 }));
    }));

    // Ask your classes
    api.post('/ask', this.limit('ask', 20), this.wrap(async (req, res) => {
      const question = this.str(req.body?.question, 500);
      if (!question) throw new HttpError(400, 'Escribe una pregunta');
      // The question never waits for embeddings (thousands of chunks can mean minutes of Gemini calls):
      // it uses the vectors that exist, and anything still missing is indexed in the background
      const answer = await new Rag(this.db.handle, this.client, this.logger).ask(question, { course: this.course(req.body?.course) });
      this.indexEmbeddingsInBackground();
      res.json(answer);
    }));

    // Alerts + calendar
    api.get('/alerts', this.wrap((req, res) => {
      res.json({ alerts: this.study.listAlerts({ course: this.course(req.query['course']), includeDismissed: req.query['dismissed'] !== '0' }) });
    }));

    api.patch('/alerts/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      if (!this.study.getAlert(id)) throw new HttpError(404, 'Aviso no encontrado');
      const { confirmed, dismissed, due_date } = req.body ?? {};
      if (due_date !== undefined && due_date !== null && !parseIso(String(due_date))) {
        throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
      }
      this.study.updateAlert(id, {
        confirmed: typeof confirmed === 'boolean' ? confirmed : undefined,
        dismissed: typeof dismissed === 'boolean' ? dismissed : undefined,
        due_date: due_date === undefined ? undefined : due_date,
      });
      res.json({ alert: this.study.getAlert(id) });
    }));

    // The calendar feed reads the campus events, plus the dated exam/deadline alerts of classes
    // that have not been analysed yet (transition: those have no events)
    api.get('/calendar.ics', this.wrap((req, res) => {
      const course = this.course(req.query['course']);
      const analysed = new Set(this.db.getAllRecordings().filter((r) => r.analysis_version).map((r) => r.id));
      const items = [
        ...this.campus.listEvents({ course, datedOnly: true }).map((e) => ({ ...e, text: e.title, due_date: e.date, uid: `event-${e.id}` })),
        ...this.study.listAlerts({ course })
          // the student's own alerts always count; AI ones only where no analysis has made events yet
          .filter((a) => a.due_date && (a.kind === 'exam' || a.kind === 'deadline') && ((a as { source?: string }).source === 'manual' || !analysed.has(a.recording_id)))
          .map((a) => ({ ...a, uid: `alert-${a.id}` })),
      ].filter((i) => req.query['confirmed'] !== '1' || i.confirmed) as unknown as (AlertRow & { uid: string })[];
      res.type('text/calendar; charset=utf-8');
      // A subscription (webcal://…?subscribe=1) reads the feed in place; a download saves a file
      if (req.query['subscribe'] !== '1') res.set('Content-Disposition', 'attachment; filename="lecturevault.ics"');
      res.send(buildIcs(items, { reminders: this.reminders() }));
    }));

    this.campusRoutes(api);
    this.examRoutes(api);

    // Flashcards
    api.get('/flashcards', this.wrap((req, res) => {
      const recordingId = this.optionalId(req.query['recording']);
      res.json({
        flashcards: this.study.listFlashcards({
          course: this.course(req.query['course']),
          recordingId,
          dueOnly: req.query['due'] === '1',
          limit: 500,
        }),
      });
    }));

    api.post('/flashcards/:id/review', this.wrap((req, res) => {
      if (typeof req.body?.correct !== 'boolean') throw new HttpError(400, 'Falta "correct"');
      const card = this.study.reviewFlashcard(this.parseId(req.params['id']), req.body.correct);
      if (!card) throw new HttpError(404, 'Tarjeta no encontrada');
      res.json({ flashcard: card });
    }));

    api.get('/export/anki', this.wrap((req, res) => {
      const kind = req.query['kind'] === 'cloze' ? 'cloze' : 'basic';
      const recordingId = this.optionalId(req.query['recording']);
      const cards = this.study.listFlashcards({ course: this.course(req.query['course']), recordingId, limit: 5000 });
      res
        .type('text/tab-separated-values; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="lecturevault-anki-${kind}.txt"`)
        .send(buildAnkiTsv(cards, kind));
    }));


    // ── Editing: everything the student can change is stored in SQLite (and mirrored to files where it applies)
    api.delete('/recordings/:id', this.wrap((req, res) => {
      const rec = this.recording(req);
      const removeFiles = req.query['files'] === '1';
      // Audio and transcript are moved to data/trash (kept TRASH_DAYS days), never deleted on the spot
      let trash: string | null = null;
      if (removeFiles && rec.transcript_id && isSafeTranscriptId(rec.transcript_id)) {
        const id = rec.transcript_id;
        const audioDir = path.join(this.dataDir, 'audio');
        const entries = (fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [])
          .filter((file) => file === id + path.extname(file) || file === `raw-${id}.webm`)
          .map((file) => ({ from: path.join(audioDir, file), to: path.join('audio', file) }));
        entries.push({ from: path.join(this.dataDir, 'transcripts', id), to: path.join('transcripts', id) });
        trash = moveToTrash(this.dataDir, id, entries);
      }
      const trashed = trash ? path.relative(this.dataDir, trash) : null;
      // A class listed by Collab2 keeps its row (the next sync would re-create it anyway); a purely local one goes away
      if (rec.collab_id.startsWith('local:')) { this.db.deleteRecording(rec.id); res.json({ removed: 'recording', trash: trashed }); }
      else { this.db.resetLocalData(rec.id); res.json({ removed: 'local-data', trash: trashed }); }
    }));

    api.put('/recordings/:id/notes', this.wrap((req, res) => {
      const rec = this.recording(req);
      const markdown = req.body?.markdown;
      if (typeof markdown !== 'string' || markdown.length > 300_000) throw new HttpError(400, 'Apuntes no válidos');
      this.saveNotes(rec, markdown);
      res.json({ saved: true, versions: this.study.listNoteVersions(rec.id) });
    }));

    api.post('/recordings/:id/notes/restore', this.wrap((req, res) => {
      const rec = this.recording(req);
      const version = this.study.getNoteVersion(rec.id, this.parseId(req.body?.version));
      if (!version) throw new HttpError(404, 'Versión no encontrada');
      this.saveNotes(rec, version.markdown);
      res.json({ markdown: version.markdown, versions: this.study.listNoteVersions(rec.id) });
    }));

    api.get('/recordings/:id/notes/versions/:version', this.wrap((req, res) => {
      const rec = this.recording(req);
      const version = this.study.getNoteVersion(rec.id, this.parseId(req.params['version']));
      if (!version) throw new HttpError(404, 'Versión no encontrada');
      res.json(version);
    }));

    api.put('/recordings/:id/position', this.wrap((req, res) => {
      const rec = this.recording(req);
      const t = Number(req.body?.t);
      if (!Number.isFinite(t) || t < 0 || t > 86_400) throw new HttpError(400, 'Posición no válida');
      this.study.setSetting(`pos:${rec.id}`, String(Math.floor(t)));
      res.json({ saved: true });
    }));

    api.post('/recordings/:id/markers', this.wrap((req, res) => {
      const rec = this.recording(req);
      const text = this.str(req.body?.text, 500);
      const t = Number(req.body?.t_ms);
      if (!text || !Number.isFinite(t) || t < 0) throw new HttpError(400, 'Marcador no válido');
      this.study.addMarker(rec.id, Math.round(t), text);
      res.json({ markers: this.study.listMarkers(rec.id) });
    }));

    api.delete('/recordings/:id/markers/:marker', this.wrap((req, res) => {
      const rec = this.recording(req);
      if (!this.study.deleteMarker(rec.id, this.parseId(req.params['marker']))) throw new HttpError(404, 'Marcador no encontrado');
      res.json({ markers: this.study.listMarkers(rec.id) });
    }));

    api.post('/recordings/:id/alerts', this.wrap((req, res) => {
      const rec = this.recording(req);
      const kind = String(req.body?.kind);
      const text = this.str(req.body?.text, 400);
      const due = req.body?.due_date ? String(req.body.due_date) : null;
      if (!['exam', 'deadline', 'grading', 'warning', 'formula'].includes(kind) || !text) throw new HttpError(400, 'Aviso no válido');
      if (due && !parseIso(due)) throw new HttpError(400, 'Fecha no válida (usa AAAA-MM-DD)');
      const t = Number.isFinite(Number(req.body?.t_ms)) ? Math.max(0, Math.round(Number(req.body.t_ms))) : 0;
      res.json({ alert: this.study.createAlert(rec.id, { kind: kind as AlertKind, text, t_ms: t, due_date: due }) });
    }));

    api.delete('/alerts/:id', this.wrap((req, res) => {
      if (!this.study.deleteAlert(this.parseId(req.params['id']))) throw new HttpError(400, 'Solo se pueden borrar avisos creados a mano (los demás se descartan)');
      res.json({ deleted: true });
    }));

    const cardInput = (body: any, partial = false) => {
      const kind: 'basic' | 'cloze' | undefined = body?.kind === 'cloze' ? 'cloze' : body?.kind === 'basic' ? 'basic' : partial ? undefined : 'basic';
      const front = this.str(body?.front, 2000);
      const back = typeof body?.back === 'string' ? body.back.trim().slice(0, 2000) : partial ? undefined : '';
      const tag = typeof body?.tag === 'string' ? body.tag.trim().replace(/\s+/g, '_').slice(0, 40) : undefined;
      if (!partial && !front) throw new HttpError(400, 'La tarjeta necesita anverso');
      const effectiveKind = kind;
      if (front && effectiveKind === 'cloze' && !/\{\{c\d+::.+?\}\}/.test(front)) throw new HttpError(400, 'Una tarjeta cloze necesita un hueco {{c1::respuesta}}');
      if (!partial && effectiveKind === 'basic' && !back) throw new HttpError(400, 'La tarjeta necesita reverso');
      return { kind: effectiveKind, front, back, tag };
    };

    api.post('/recordings/:id/flashcards', this.wrap((req, res) => {
      const rec = this.recording(req);
      const c = cardInput(req.body);
      const card = this.study.createFlashcard(rec.id, { kind: c.kind as 'basic' | 'cloze', front: c.front!, back: c.back ?? '', tag: c.tag, t_ms: Math.max(0, Math.round(Number(req.body?.t_ms) || 0)) });
      if (!card) throw new HttpError(409, 'Ya existe una tarjeta con ese anverso en esta clase');
      res.json({ flashcard: card });
    }));

    api.patch('/flashcards/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      const existing = this.study.getFlashcard(id);
      if (!existing) throw new HttpError(404, 'Tarjeta no encontrada');
      const c = cardInput(req.body, true);
      const merged = { kind: c.kind ?? existing.kind, front: c.front ?? existing.front };
      if (merged.kind === 'cloze' && !/\{\{c\d+::.+?\}\}/.test(merged.front)) throw new HttpError(400, 'Una tarjeta cloze necesita un hueco {{c1::respuesta}}');
      res.json({ flashcard: this.study.updateFlashcard(id, { kind: c.kind, front: c.front, back: c.back, tag: c.tag }) });
    }));

    api.delete('/flashcards/:id', this.wrap((req, res) => {
      if (!this.study.deleteFlashcard(this.parseId(req.params['id']))) throw new HttpError(404, 'Tarjeta no encontrada');
      res.json({ deleted: true });
    }));

    // ── Pending: Collab2 classes with no local capture yet, with the exact command to run.
    // Ignored ones (empty tutorials, duplicates) are listed apart so they can be brought back.
    api.get('/pending', this.wrap((_req, res) => {
      const catalog = CourseCatalog.load(this.dataDir);
      const pending = this.db.getPendingCaptures();
      const ignored = this.db.getAllRecordings().filter((r) => r.ignored_at && !r.transcript_id);
      const d = (iso: string) => { const x = new Date(iso); return Number.isNaN(x.getTime()) ? '' : `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
      res.json({
        pending: pending.map((r) => {
          const found = r.course ? catalog.find(r.course) : undefined;
          const parts = ['npm run capture:and:transcribe --'];
          if (found) parts.push(`--course ${found.code}`);
          else if (r.course) parts.push(`--course "${r.course.replace(/"/g, '')}"`);
          if (d(r.created_at)) parts.push(`--date ${d(r.created_at)}`);
          parts.push(`--name ${sanitizeRecordingId(r.collab_id)}`);
          return { id: r.id, title: r.title, course: r.course, created_at: r.created_at, duration_seconds: r.duration_seconds, command: parts.join(' ') };
        }),
        ignored: ignored.map((r) => ({ id: r.id, title: r.title, course: r.course, created_at: r.created_at, duration_seconds: r.duration_seconds })),
        batch: 'npm run batch:transcribe -- --speed 2 --silent',
      });
    }));

    // ── Settings, catalog, backup
    const SETTING_KEYS = new Set(['theme', 'course', ...REMINDER_KEYS]);
    api.get('/settings', this.wrap((_req, res) => {
      res.json({ settings: Object.fromEntries(Object.entries(this.study.getSettings()).filter(([k]) => SETTING_KEYS.has(k))), reminders: this.reminders() });
    }));

    api.put('/settings', this.wrap((req, res) => {
      // Everything is checked before anything is written: a bad value saves nothing
      const writes: [string, string][] = [];
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (!SETTING_KEYS.has(key) || typeof value !== 'string' || value.length > 200) throw new HttpError(400, `Ajuste no válido: ${key}`);
        if (key === 'theme' && !['light', 'dark', 'system'].includes(value)) throw new HttpError(400, 'Tema no válido');
        if (!REMINDER_KEYS.includes(key)) {
          writes.push([key, value]);
          continue;
        }
        try {
          writes.push([key, parseReminderDays(value).join(', ')]);
        } catch (err) {
          throw new HttpError(400, `Avisos: ${(err as Error).message}`);
        }
      }
      for (const [key, value] of writes) this.study.setSetting(key, value);
      res.json({ saved: true });
    }));

    api.get('/system', this.wrap((_req, res) => {
      const dbPath = this.db.handle.name;
      res.json({
        ai: this.client.hasKey,
        model: this.client.lastModelUsed,
        dataDir: this.dataDir,
        dbPath,
        dbBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
        backupDir: this.backupDir,
        backups: listBackups(this.backupDir).slice(0, 10).map((b) => b.file),
        trashDays: TRASH_DAYS,
        stats: { ...this.db.getStats(), ...this.study.getStudyStats() },
      });
    }));

    api.post('/backup', this.limit('backup', 6), this.wrap(async (_req, res) => {
      const file = await backupDatabase(this.db.handle, this.backupDir, 'manual'); // consistent online copy
      res.json({ file, bytes: fs.statSync(file).size });
    }));

    api.get('/catalog', this.wrap((_req, res) => {
      res.json({ courses: CourseCatalog.load(this.dataDir).courses });
    }));

    api.put('/catalog', this.wrap((req, res) => {
      const list: unknown = req.body?.courses;
      if (!Array.isArray(list) || list.length > 60) throw new HttpError(400, 'Catálogo no válido');
      const clean = list.map((c: any) => ({
        code: String(c?.code ?? '').trim().slice(0, 30),
        name: String(c?.name ?? '').trim().slice(0, 160),
        ...(c?.teacher ? { teacher: String(c.teacher).trim().slice(0, 120) } : {}),
        ...(c?.lmsId ? { lmsId: String(c.lmsId).trim().slice(0, 60) } : {}),
      }));
      if (clean.some((c) => !c.code || !c.name)) throw new HttpError(400, 'Cada asignatura necesita código y nombre');
      if (new Set(clean.map((c) => c.code.toLowerCase())).size !== clean.length) throw new HttpError(400, 'Hay códigos repetidos');
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, COURSES_FILE), JSON.stringify(clean, null, 2));
      res.json({ courses: clean });
    }));

    api.use((_req, res) => {
      res.status(404).json({ error: 'No encontrado' });
    });

    this.app.use('/api', api);

    // Serve index.html for all other routes (SPA fallback)
    this.app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, '../../public/index.html'));
    });

    // Last-resort handler: malformed JSON etc. must not leak stack traces
    this.app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
      if (status === 500) this.logger.error({ err }, 'Unhandled error');
      res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Petición no válida' });
    });
  }

  // ── Campus: home, calendar, course pages, deliverables, exams, review inbox ──

  private entityTitle(destination: string, entityId: number | null): string | null {
    if (!entityId) return null;
    if (destination === 'deliverable') return this.campus.getDeliverable(entityId)?.title ?? null;
    if (destination === 'exam') return this.campus.getExam(entityId)?.title ?? null;
    return null;
  }

  /** `?today=` lets tests and the UI pin "today"; otherwise the machine's local day. */
  /** Dated events that still ask for work: a deliverable marked as handed in no longer weighs. */
  private loadEvents(course?: string) {
    const done = new Set(
      (this.db.handle.prepare("SELECT id FROM deliverables WHERE status = 'done'").all() as { id: number }[]).map((d) => d.id)
    );
    return this.campus.listEvents({ course, datedOnly: true }).filter((e) => !(e.deliverable_id && done.has(e.deliverable_id)));
  }

  /** Calendar reminders from Ajustes, with the defaults for what was never set. */
  private reminders(): Reminders {
    const settings = this.study.getSettings();
    const read = (key: string, fallback: number[]) => {
      try {
        return settings[key] !== undefined ? parseReminderDays(settings[key]!) : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      exam: read('reminders_exam', DEFAULT_REMINDERS.exam),
      deadline: read('reminders_deadline', DEFAULT_REMINDERS.deadline),
      other: read('reminders_other', DEFAULT_REMINDERS.other),
    };
  }

  private today(raw: unknown): string {
    const text = typeof raw === 'string' ? raw : '';
    return parseIso(text) ? text : toIso(localCalendarDate(new Date()));
  }

  private isoOrNull(value: unknown, field: string): string | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !parseIso(value)) throw new HttpError(400, `${field} no válida (usa AAAA-MM-DD)`);
    return value;
  }

  private timeOrNull(value: unknown): string | null {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HttpError(400, 'Hora no válida (usa HH:MM)');
    return value;
  }

  /** Course from a URL segment: must be a course that exists (in recordings or in the catalog). */
  private courseParam(req: Request): string {
    const course = String(req.params['course'] ?? '').trim();
    const known = new Set([...this.db.getCourses().map((c) => c.course), ...CourseCatalog.load(this.dataDir).labels]);
    if (!course || !known.has(course)) throw new HttpError(404, 'Asignatura no encontrada');
    return course;
  }

  /** Exam question bank: per subject, plus practice attempts (the friends' web keeps its own in the browser). */
  private examRoutes(api: express.Router): void {
    const labels = () => [...new Set([...CourseCatalog.load(this.dataDir).labels, ...this.db.getCourses().map((c) => c.course).filter(Boolean)])];

    // One card per subject, even those without questions yet
    api.get('/exam-bank', this.wrap((_req, res) => {
      const byCourse = new Map(this.exam.summaries().map((s) => [s.course, s]));
      const empty = (course: string) => ({ course, total: 0, explicit: 0, emphasis: 0, byKind: { tf: 0, mcq: 0, short: 0, essay: 0 }, classes: 0 });
      res.json({ courses: labels().map((c) => byCourse.get(c) ?? empty(c)) });
    }));

    // Classes whose bank is missing or older than the current prompt: what «Generar preguntas» would write
    api.get('/exam-questions/outdated', this.wrap((_req, res) => {
      res.json({ version: EXAM_PROMPT_VERSION, ids: this.exam.listOutdated(EXAM_PROMPT_VERSION) });
    }));

    api.get('/courses/:course/questions', this.wrap((req, res) => {
      const course = this.courseParam(req);
      res.json({ course, questions: this.exam.list({ course, includeDismissed: req.query['all'] === '1' }) });
    }));

    api.patch('/exam-questions/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      const { dismissed, starred } = req.body ?? {};
      if ((dismissed !== undefined && typeof dismissed !== 'boolean') || (starred !== undefined && typeof starred !== 'boolean')) {
        throw new HttpError(400, '"dismissed" y "starred" son verdadero o falso');
      }
      const row = this.exam.get(id) && this.exam.setFlags(id, { dismissed, starred });
      if (!row) throw new HttpError(404, 'Pregunta no encontrada');
      res.json({ question: row });
    }));

    api.get('/courses/:course/exam-attempts', this.wrap((req, res) => {
      res.json({ attempts: this.exam.listAttempts(this.courseParam(req)) });
    }));

    api.post('/courses/:course/exam-attempts', this.limit('exam-attempt', 60), this.wrap((req, res) => {
      const course = this.courseParam(req);
      const items: unknown = req.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new HttpError(400, 'Indica "items" (1-100)');
      const clean = items.map((i: { id?: unknown; score?: unknown }) => {
        const id = Number(i?.id);
        const score = Number(i?.score);
        if (!Number.isInteger(id) || id < 1 || !Number.isFinite(score) || score < 0 || score > 1) throw new HttpError(400, 'Cada item lleva "id" y "score" entre 0 y 1');
        return { id, score };
      });
      res.status(201).json({ attempt: this.exam.saveAttempt(course, clean) });
    }));
  }

  private campusRoutes(api: express.Router): void {
    const EVENT_KINDS: EventKind[] = ['exam', 'deadline', 'session', 'lab', 'other'];

    // Home: what is coming, what needs a decision, one card per course and where you left off
    api.get('/home', this.wrap((req, res) => {
      const today = this.today(req.query['today']);
      const days = Math.min(Math.max(Number(req.query['days']) || 14, 1), 90);
      const until = toIso(addDays(parseIso(today)!, days));
      const since = toIso(addDays(parseIso(today)!, -days)); // "Vencido" looks back as far as "Próximos" looks ahead
      const doneDeliverables = new Set(
        (this.db.handle.prepare("SELECT id FROM deliverables WHERE status = 'done'").all() as { id: number }[]).map((d) => d.id)
      );

      const dated = this.campus.listEvents({ from: since, to: until, datedOnly: true });
      const overdue = dated.filter(
        (e) => e.date! < today && (e.kind === 'deadline' || e.kind === 'exam') && !(e.deliverable_id && doneDeliverables.has(e.deliverable_id))
      );
      const upcoming = dated.filter((e) => e.date! >= today);
      // What you have to do something about, however far away: an ordinary session is not a milestone
      const ahead = this.campus.listEvents({ from: today, datedOnly: true });
      const milestones = ahead
        .filter((e) => e.kind !== 'session' && !(e.deliverable_id && doneDeliverables.has(e.deliverable_id)))
        .slice(0, 6);
      const toConfirm = this.campus.listEvents({}).filter((e) => !e.confirmed && e.source === 'ai' && (e.confidence !== 'high' || !e.date));

      const courses = this.db.getCourses().filter((c) => c.course).map((c) => {
        const next = ahead.find((e) => e.course === c.course && e.kind !== 'session' && !(e.deliverable_id && doneDeliverables.has(e.deliverable_id))) ?? null;
        const classes = this.study.getOverview({ course: c.course }).filter((s) => s.segment_count > 0);
        return {
          course: c.course,
          classes: c.count,
          // The last class given, even if it asked for nothing: older requests are no longer "for the next class"
          latest_recording_id: classes.sort((a, b) => (b.class_number ?? 0) - (a.class_number ?? 0))[0]?.id ?? null,
          next,
          deliverables_open: this.campus.listDeliverables(c.course).filter((d) => d.status !== 'done').length,
          flashcards_due: this.study.listFlashcards({ course: c.course, dueOnly: true, limit: 500 }).length,
          proposals: this.campus.listProposals({ status: 'open', course: c.course }).length,
          locked: this.campus.getProfile(c.course)?.locked ?? 0,
        };
      });

      const last = this.study.lastPosition();
      const lastRec = last ? this.db.getRecordingById(last.recordingId) : undefined;
      res.json({
        today,
        overdue,
        upcoming,
        milestones,
        next_session: ahead.find((e) => e.kind === 'session') ?? null,
        tasks: this.campus.listOpenTasks(),
        heavy_weeks: weeklyLoad(this.loadEvents(), today, 8)
          .filter((w) => w.level === 'critical')
          .map((w) => ({ start: w.start, end: w.end, summary: describeWeek(w), courses: [...new Set(w.events.map((e) => e.course))] })),
        flashcards_due: this.study.listFlashcards({ dueOnly: true, limit: 5000 }).length,
        to_confirm: toConfirm,
        proposals: this.campus.listProposals({ status: 'open' }).length,
        courses,
        continue: lastRec
          ? { id: lastRec.id, title: lastRec.display_title ?? lastRec.title, course: lastRec.course, seconds: last!.seconds, duration_seconds: lastRec.duration_seconds }
          : null,
      });
    }));

    // Tasks: ticking or dismissing what a class asked for
    api.patch('/tasks/:id', this.wrap((req, res) => {
      const { done, dismissed } = req.body ?? {};
      if ((done !== undefined && typeof done !== 'boolean') || (dismissed !== undefined && typeof dismissed !== 'boolean')) throw new HttpError(400, 'Valores no válidos');
      if (!this.campus.updateTask(this.parseId(req.params['id']), { done, dismissed })) throw new HttpError(404, 'Tarea no encontrada');
      res.json({ ok: true });
    }));

    // University calendar (.ics from the campus): status and a sync on demand
    api.get('/lms-calendar', this.wrap((_req, res) => { res.json(this.lmsStatus()); }));
    api.post('/lms-calendar/sync', this.limit('lms', 6), this.wrap(async (req, res) => {
      // `force`: the student confirms that the events missing from the feed really are gone
      await this.syncLmsCalendar({ force: req.body?.force === true });
      res.json(this.lmsStatus());
    }));

    // Weekly workload: from the current week, how much is due each week
    api.get('/workload', this.wrap((req, res) => {
      const from = this.today(req.query['from']);
      const weeks = Math.min(Math.max(Number(req.query['weeks']) || 12, 1), 52);
      res.json({ weeks: weeklyLoad(this.loadEvents(this.course(req.query['course'])), from, weeks) });
    }));

    // Grade calculator: the grading table, the student's scores and what is still needed
    // The target grade is per course and lives with the rest of the student's state (settings)
    const targetKey = (course: string) => `grade_target:${course}`;
    const grades = (course: string, target: number) => {
      const items = this.campus.listGradesWithScores(course);
      return { items, target, targetSaved: this.study.getSetting(targetKey(course)) !== undefined, projection: gradeProjection(items, target) };
    };
    api.get('/courses/:course/grades', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const saved = Number(this.study.getSetting(targetKey(course)));
      const target = this.number(req.query['target'], 0, 10, 'Nota objetivo') ?? (saved > 0 && saved <= 10 ? saved : 5);
      res.json(grades(course, target));
    }));

    api.put('/courses/:course/grades/target', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const target = this.number(req.body?.target, 1, 10, 'Nota objetivo');
      if (target === undefined || target === null) throw new HttpError(400, 'Indica "target"');
      this.study.setSetting(targetKey(course), String(target));
      res.json(grades(course, target));
    }));

    api.post('/courses/:course/grades', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const b = req.body ?? {};
      const name = this.str(b.name, 120);
      if (!name) throw new HttpError(400, 'Escribe el nombre del criterio');
      const item = this.gradeWrite(() => this.campus.addGradingItem(course, {
        name,
        weight_pct: this.number(b.weight_pct, 0, 100, 'Peso'),
        parent_id: b.parent_id === null || b.parent_id === undefined ? null : this.parseId(String(b.parent_id)),
        min_grade: this.number(b.min_grade, 0, 10, 'Mínimo'),
      }));
      res.status(201).json({ item });
    }));

    api.patch('/grades/:id', this.wrap((req, res) => {
      const row = this.campus.getGradingItem(this.parseId(req.params['id']));
      if (!row) throw new HttpError(404, 'Criterio no encontrado');
      const b = req.body ?? {};
      const patch: Parameters<CampusRepository['updateGradingItem']>[1] = {};
      if ('name' in b) patch.name = this.str(b.name, 120) ?? row.name;
      if ('weight_pct' in b) patch.weight_pct = this.number(b.weight_pct, 0, 100, 'Peso') ?? null;
      if ('min_grade' in b) patch.min_grade = this.number(b.min_grade, 0, 10, 'Mínimo') ?? null;
      if ('parent_id' in b) patch.parent_id = b.parent_id === null || b.parent_id === '' ? null : this.parseId(String(b.parent_id));
      // The score is the student's, not part of the table: setting it does not take the table over
      if ('score' in b) this.campus.setGradeScore(row.course, row.name, this.number(b.score, 0, 10, 'Nota') ?? null);
      const item = Object.keys(patch).length ? this.gradeWrite(() => this.campus.updateGradingItem(row.id, patch)) : row;
      res.json({ item });
    }));

    api.delete('/grades/:id', this.wrap((req, res) => {
      if (!this.campus.deleteGradingItem(this.parseId(req.params['id']))) throw new HttpError(404, 'Criterio no encontrado');
      res.json({ deleted: true });
    }));

    // Command palette (Ctrl+K): places, classes, dates, tasks and a few transcript lines, all in one call
    api.get('/palette', this.wrap((req, res) => {
      const q = this.str(req.query['q'], 120);
      if (!q || q.length < 2) {
        res.json({ classes: [], events: [], tasks: [], hits: [] });
        return;
      }
      const needle = foldWs(q);
      const has = (...texts: (string | null | undefined)[]) => texts.some((t) => t && foldWs(t).includes(needle));
      const today = toIso(localCalendarDate(new Date()));
      res.json({
        classes: this.study.getOverview()
          .filter((r) => has(r.display_title, r.title))
          .slice(0, 6)
          .map((r) => ({ id: r.id, title: r.display_title || r.title, course: r.course, class_number: r.class_number })),
        events: this.campus.listEvents()
          .filter((e) => has(e.title, e.course))
          .sort((a, b) => Number((a.date ?? '9') < today) - Number((b.date ?? '9') < today) || (a.date ?? '9').localeCompare(b.date ?? '9'))
          .slice(0, 5),
        tasks: this.campus.listOpenTasks(200).filter((t) => has(t.text)).slice(0, 5),
        hits: this.search.search(q, { limit: 5 }).hits,
      });
    }));

    // Calendar events
    api.get('/events', this.wrap((req, res) => {
      const from = req.query['from'] ? this.isoOrNull(req.query['from'], 'Fecha') ?? undefined : undefined;
      const to = req.query['to'] ? this.isoOrNull(req.query['to'], 'Fecha') ?? undefined : undefined;
      res.json({
        events: this.campus.listEvents({ course: this.course(req.query['course']), from, to, includeDismissed: req.query['dismissed'] === '1' }),
      });
    }));

    api.post('/events', this.wrap((req, res) => {
      const course = this.str(req.body?.course, 120) ?? '';
      const kind = String(req.body?.kind) as EventKind;
      const title = this.str(req.body?.title, 200);
      if (!EVENT_KINDS.includes(kind) || !title) throw new HttpError(400, 'Evento no válido: indica "kind" y "title"');
      const date = req.body?.date === undefined ? null : this.isoOrNull(req.body.date, 'Fecha');
      const time = req.body?.time === undefined ? null : this.timeOrNull(req.body.time);
      res.json({
        event: this.campus.createEvent(course === NO_COURSE ? '' : course, {
          kind, title, date, time,
          deliverable_id: this.optionalId(req.body?.deliverable_id) ?? null,
          exam_id: this.optionalId(req.body?.exam_id) ?? null,
        }),
      });
    }));

    api.patch('/events/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      if (!this.campus.getEvent(id)) throw new HttpError(404, 'Evento no encontrado');
      const b = req.body ?? {};
      const patch: EventPatch = {};
      if (b.kind !== undefined) {
        if (!EVENT_KINDS.includes(b.kind)) throw new HttpError(400, 'Tipo de evento no válido');
        patch.kind = b.kind;
      }
      if (b.title !== undefined) {
        const title = this.str(b.title, 200);
        if (!title) throw new HttpError(400, 'El título no puede quedar vacío');
        patch.title = title;
      }
      if (b.date !== undefined) patch.date = this.isoOrNull(b.date, 'Fecha');
      if (b.time !== undefined) patch.time = this.timeOrNull(b.time);
      if (typeof b.confirmed === 'boolean') patch.confirmed = b.confirmed;
      if (typeof b.dismissed === 'boolean') patch.dismissed = b.dismissed;
      res.json({ event: this.campus.updateEvent(id, patch) });
    }));

    api.delete('/events/:id', this.wrap((req, res) => {
      if (!this.campus.deleteEvent(this.parseId(req.params['id']))) throw new HttpError(404, 'Evento no encontrado');
      res.json({ deleted: true });
    }));

    // Course page: fixed sheet, grading, deliverables, exams and every session
    api.get('/courses/:course', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const nextDate = (filter: { deliverableId?: number; examId?: number }) =>
        this.campus.listEvents({ ...filter, datedOnly: true }).find((e) => e.kind !== 'session') ?? null;
      res.json({
        course,
        profile: this.campus.getProfile(course) ?? null,
        grading: this.campus.listGradingItems(course),
        deliverables: this.campus.listDeliverables(course).map((d) => ({
          ...d, next: nextDate({ deliverableId: d.id }), mentions: this.campus.listMentions('deliverable', d.id).length,
        })),
        exams: this.campus.listExams(course).map((x) => ({
          ...x, next: nextDate({ examId: x.id }), mentions: this.campus.listMentions('exam', x.id).length,
        })),
        mentions: this.campus.listCourseMentions(course),
        sessions: this.study.getOverview({ course })
          .sort(byClassOrder)
          .map((s) => ({ ...s, summary: this.oneLineSummary(s.id) })),
        proposals: this.campus.listProposals({ status: 'open', course }),
        materials: loadMaterialsIndex(this.dataDir, courseCodeOf(course))?.items.length ?? 0,
      });
    }));

    // The subject's materials on the campus, as the daily agent listed them (data/materials/<CODE>/index.json)
    api.get('/courses/:course/materials', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const code = courseCodeOf(course);
      const index = loadMaterialsIndex(this.dataDir, code);
      if (!index) {
        res.json({ course, courseUrl: null, updatedAt: null, items: [], files: [] });
        return;
      }
      const dir = path.resolve(materialsDir(this.dataDir, code));
      const inside = (rel: string) => { const p = path.resolve(dir, rel); return p.startsWith(dir + path.sep) && fs.existsSync(p); };
      res.json({
        course,
        courseUrl: index.courseUrl,
        updatedAt: index.updatedAt,
        items: index.items,
        // Only files that are really on this machine (inside its materials folder) get a link to open them here
        files: index.files.map((f) => ({ ...f, local: inside(f.file) })),
      });
    }));

    // One stored material, by its place in the index (never a path from the client)
    api.get('/courses/:course/materials/file/:n', this.wrap((req, res) => {
      const code = courseCodeOf(this.courseParam(req));
      const index = loadMaterialsIndex(this.dataDir, code);
      const entry = index?.files[Number(req.params['n'])];
      const dir = path.resolve(materialsDir(this.dataDir, code));
      const file = entry ? path.resolve(dir, entry.file) : '';
      if (!entry || !file.startsWith(dir + path.sep) || !fs.existsSync(file)) throw new HttpError(404, 'Material no encontrado');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(entry.fileName)}`);
      res.sendFile(file);
    }));

    api.put('/courses/:course/profile', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const b = req.body ?? {};
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
      const syllabus = Array.isArray(b.syllabus)
        ? b.syllabus.slice(0, 40).map((s: any, i: number) => ({ n: Number.isInteger(s?.n) ? s.n : i + 1, title: String(s?.title ?? '').trim().slice(0, 200) })).filter((s: any) => s.title)
        : undefined;
      const resources = Array.isArray(b.resources) ? b.resources.slice(0, 30).map((r: unknown) => String(r).trim().slice(0, 200)).filter(Boolean) : undefined;
      res.json({
        profile: this.campus.saveProfile(course, {
          overview_md: text(b.overview_md, 5000), teacher: text(b.teacher, 120), schedule: text(b.schedule, 200),
          pass_rules: text(b.pass_rules, 500), syllabus, resources,
        }),
      });
    }));

    api.post('/courses/:course/profile/lock', this.wrap((req, res) => {
      const course = this.courseParam(req);
      if (typeof req.body?.locked !== 'boolean') throw new HttpError(400, 'Falta "locked"');
      if (!this.campus.getProfile(course)) this.campus.saveProfile(course, {});
      this.campus.setProfileLocked(course, req.body.locked);
      res.json({ profile: this.campus.getProfile(course) });
    }));

    // Theory: sessions by syllabus block; project sessions live under their deliverable instead,
    // and mixed sessions only show their theory ranges
    api.get('/courses/:course/theory', this.wrap((req, res) => {
      const { syllabus, groups } = this.theoryByTopic(this.courseParam(req));
      res.json({
        syllabus,
        groups: groups.map(({ topic, classes }) => ({
          topic,
          classes: classes.map(({ session: s, theory }) => ({
            ...s,
            summary: this.oneLineSummary(s.id),
            theory_sections: theory.map(({ start_ms, end_ms, heading }) => ({ start_ms, end_ms, heading })),
            highlights: this.campus.listAiMarkers(s.id).length,
          })),
        })),
      });
    }));

    // PDF: the page the browser prints reads these two; the download itself is generated by Chromium
    api.get('/recordings/:id/export', this.wrap((req, res) => {
      const rec = this.recording(req);
      const notes = this.study.getNotes(rec.id);
      if (!notes?.markdown.trim()) throw new HttpError(404, 'Esta clase aún no tiene apuntes');
      res.json({
        title: rec.display_title ?? rec.title,
        course: rec.course,
        date: rec.class_date ?? rec.created_at,
        duration_seconds: rec.duration_seconds,
        markdown: stripLeadingTitle(notes.markdown),
      });
    }));

    api.get('/courses/:course/export', this.wrap((req, res) => {
      const course = this.courseParam(req);
      const without: string[] = [];
      const topics = this.theoryByTopic(course).groups
        .map(({ topic, classes }) => ({
          topic: topic || 'Sin tema asignado',
          classes: classes.flatMap(({ session: s, theory }) => {
            const markdown = theoryMarkdown(theory, this.study.getNotes(s.id)?.markdown);
            if (!markdown) { without.push(s.display_title ?? s.title); return []; }
            return [{ title: s.display_title ?? s.title, date: s.class_date ?? s.created_at, markdown }];
          }),
        }))
        .filter((t) => t.classes.length > 0);
      if (topics.length === 0) throw new HttpError(404, 'Esta asignatura aún no tiene apuntes de teoría');
      res.json({ course, topics, without_notes: without });
    }));

    api.get('/recordings/:id/pdf', this.limit('pdf', 6), this.wrap(async (req, res) => {
      const rec = this.recording(req);
      if (!this.study.getNotes(rec.id)?.markdown.trim()) throw new HttpError(404, 'Esta clase aún no tiene apuntes');
      const pdf = await this.pdf.render(`/print.html?kind=class&id=${rec.id}`, rec.display_title ?? rec.title);
      this.sendPdf(res, pdf, rec.display_title ?? rec.title);
    }));

    api.get('/courses/:course/pdf', this.limit('pdf', 6), this.wrap(async (req, res) => {
      const course = this.courseParam(req);
      const pdf = await this.pdf.render(`/print.html?kind=course&course=${encodeURIComponent(course)}`, `${course} · Apuntes de teoría`);
      this.sendPdf(res, pdf, `${course.split(/\s+/)[0]} Apuntes de teoría`);
    }));

    // Deliverables and exams: one entity with everything any class said about it
    const entityDetail = (type: 'deliverable' | 'exam', id: number) => ({
      events: this.campus.listEvents(type === 'deliverable' ? { deliverableId: id } : { examId: id }),
      mentions: this.campus.listMentions(type, id),
      sections: this.campus.listSectionsForEntity(type, id),
      grading: this.campus.listGradingItems(type === 'deliverable' ? this.campus.getDeliverable(id)!.course : this.campus.getExam(id)!.course)
        .filter((g) => (type === 'deliverable' ? g.deliverable_id : g.exam_id) === id),
    });

    api.get('/deliverables/:id', this.wrap((req, res) => {
      const d = this.campus.getDeliverable(this.parseId(req.params['id']));
      if (!d) throw new HttpError(404, 'Trabajo no encontrado');
      const detail = entityDetail('deliverable', d.id);
      const dedicated = [...new Set(detail.sections.filter((s) => s.session_kind === 'project').map((s) => s.recording_id))];
      let checklist: number[] = [];
      try { checklist = JSON.parse(this.study.getSetting(`check:deliverable:${d.id}`) ?? '[]'); } catch { /* reset below */ }
      res.json({ deliverable: d, ...detail, dedicated_sessions: dedicated, checklist: Array.isArray(checklist) ? checklist : [] });
    }));

    // Ticked requirements of a deliverable (ids of its mentions)
    api.put('/deliverables/:id/checklist', this.wrap((req, res) => {
      const d = this.campus.getDeliverable(this.parseId(req.params['id']));
      if (!d) throw new HttpError(404, 'Trabajo no encontrado');
      const done: unknown = req.body?.done;
      if (!Array.isArray(done) || done.length > 500 || !done.every((x) => Number.isInteger(x) && x > 0)) throw new HttpError(400, 'Lista no válida');
      this.study.setSetting(`check:deliverable:${d.id}`, JSON.stringify(done));
      res.json({ checklist: done });
    }));

    api.patch('/deliverables/:id', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      if (!this.campus.getDeliverable(id)) throw new HttpError(404, 'Trabajo no encontrado');
      const b = req.body ?? {};
      if (b.status !== undefined && !['todo', 'doing', 'done'].includes(b.status)) throw new HttpError(400, 'Estado no válido');
      if (b.weight_pct !== undefined && b.weight_pct !== null && !(typeof b.weight_pct === 'number' && b.weight_pct >= 0 && b.weight_pct <= 100)) {
        throw new HttpError(400, 'Peso no válido');
      }
      if (b.title !== undefined && !this.str(b.title, 200)) throw new HttpError(400, 'El título no puede quedar vacío');
      const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
      res.json({
        deliverable: this.campus.updateDeliverable(id, {
          status: b.status, title: text(b.title, 200), description: text(b.description, 3000), format: text(b.format, 200),
          group_size: text(b.group_size, 80), weight_pct: b.weight_pct,
        }),
      });
    }));

    api.get('/exams/:id', this.wrap((req, res) => {
      const x = this.campus.getExam(this.parseId(req.params['id']));
      if (!x) throw new HttpError(404, 'Examen no encontrado');
      res.json({ exam: x, ...entityDetail('exam', x.id) });
    }));

    // Review inbox
    api.get('/proposals', this.wrap((req, res) => {
      const status = ['open', 'accepted', 'rejected'].includes(String(req.query['status'])) ? (req.query['status'] as 'open') : undefined;
      const proposals = this.campus.listProposals({ status, course: this.course(req.query['course']) }).map((p) => {
        const rec = p.recording_id ? this.db.getRecordingById(p.recording_id) : undefined;
        const eventId = /^event:(\d+)\./.exec(p.target)?.[1];
        return {
          ...p,
          recording_title: rec ? rec.display_title ?? rec.title : null,
          event: eventId ? this.campus.getEvent(Number(eventId)) ?? null : null,
        };
      });
      res.json({ proposals });
    }));

    // The proposed date is right but belongs to something else: keep the event and add a new one
    api.post('/proposals/:id/new-event', this.wrap((req, res) => {
      const id = this.parseId(req.params['id']);
      const proposal = this.campus.getProposal(id);
      if (!proposal) throw new HttpError(404, 'Propuesta no encontrada');
      if (proposal.status !== 'open') throw new HttpError(409, 'La propuesta ya está resuelta');
      const title = this.str(req.body?.title, 200);
      if (!title) throw new HttpError(400, 'Falta el título');
      const kind = String(req.body?.kind) as EventKind;
      if (!EVENT_KINDS.includes(kind)) throw new HttpError(400, 'Tipo de evento no válido');
      try {
        res.json({ event: this.campus.addProposalAsEvent(id, { title, kind }) });
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }));

    for (const action of ['accept', 'reject'] as const) {
      api.post(`/proposals/:id/${action}`, this.wrap((req, res) => {
        const id = this.parseId(req.params['id']);
        const proposal = this.campus.getProposal(id);
        if (!proposal) throw new HttpError(404, 'Propuesta no encontrada');
        if (proposal.status !== 'open') throw new HttpError(409, 'La propuesta ya está resuelta');
        try {
          res.json({ proposal: action === 'accept' ? this.campus.acceptProposal(id) : this.campus.rejectProposal(id) });
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }));
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start the dashboard server, bound to localhost only */
  /**
   * Classes that arrived without the AI treatment (recorded by the cloud agent, whose analysis lives in its
   * own throwaway database) are queued, so the local database catches up with what Vercel already shows and
   * the next export from here never shows them poorer. Needs an AI key; costs nothing when all is up to date.
   */
  queueUnprocessed(): number {
    if (!this.config.geminiApiKey && !this.config.deepseekApiKey) return 0;
    const ids = this.study
      .getOverview()
      .filter((row) => row.segment_count > 0)
      .filter((row) => {
        const rec = this.db.getRecordingById(row.id);
        return Boolean(rec && rec.course && !rec.ignored_at && rec.analysis_version !== ANALYSIS_PROMPT_VERSION);
      })
      .map((row) => row.id);
    let queued = ids.length > 0 ? this.queue.enqueue(ids).queued : 0;
    // A class whose notes came out with a hole (a range the model failed to write) gets only the notes step again
    const holes = this.study.listIncompleteNotes().filter((id) => !ids.includes(id) && !this.db.getRecordingById(id)?.ignored_at);
    if (holes.length > 0) queued += this.queue.enqueue(holes, false, ['notes', 'embeddings']).queued;
    // Notes without the current summary (written before it existed, or its call failed): only the summary is redone
    const noSummary = this.study.listWithoutKeyPoints().filter((id) => !ids.includes(id) && !holes.includes(id) && !this.db.getRecordingById(id)?.ignored_at);
    if (noSummary.length > 0) queued += this.queue.enqueue(noSummary, false, ['summary', 'embeddings']).queued;
    if (queued > 0) this.logger.info({ queued, incomplete: holes.length, withoutSummary: noSummary.length }, 'Clases sin procesar con IA puestas en cola');
    return queued;
  }

  async start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, '127.0.0.1', () => {
          this.logger.info({ port: this.port }, `Dashboard running at http://localhost:${this.port}`);
          if (this.config.lmsCalendarUrl) {
            this.syncLmsCalendar().catch(() => {});
            this.lmsTimer = setInterval(() => this.syncLmsCalendar().catch(() => {}), LMS_SYNC_MS);
            this.lmsTimer.unref();
          }
          // Jobs left by the last run continue (without a key each one ends saying so)
          this.queue.resume();
          try {
            // Official date, session and topic of each class, as the daily agent read them on the campus
            const official = this.campus.applyOfficialSessions(loadDailyState(this.dataDir).entries);
            if (official) this.logger.info({ official }, 'official class data from the campus applied');
          } catch (err) {
            this.logger.warn({ err: (err as Error).message }, 'official class data could not be applied');
          }
          this.queueUnprocessed();
          this.indexEmbeddingsInBackground();
          try {
            const purged = purgeTrash(this.dataDir);
            if (purged) this.logger.info({ purged, days: TRASH_DAYS }, 'old files removed from the trash');
          } catch (err) {
            this.logger.warn({ err: (err as Error).message }, 'trash could not be emptied');
          }
          if (this.config.autoBackup) {
            this.autoBackupIfDue();
            this.backupTimer = setInterval(() => this.autoBackupIfDue(), 60 * 60 * 1000);
            this.backupTimer.unref();
          }
          resolve();
        });

        this.server.on('error', (err) => {
          this.logger.error({ err }, 'Dashboard server error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Serves the API on a free local port and nothing else: no AI queue, no campus calendar, no backups, no
   * timers. The static web exporter reads its GET responses from here (see export/static-site.ts), so the
   * friends' web shows exactly what the dashboard computes. Close it with stop(). Returns the base URL.
   */
  listenLocal(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${this.port}`));
        this.server.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Port actually bound (useful when configured with port 0 in tests) */
  getPort(): number {
    return this.port;
  }

  /** Stop the dashboard server */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.lmsTimer) clearInterval(this.lmsTimer);
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.queue.stop();
    this.capture.stop();
    await this.backupRun; // a copy in progress finishes (it is quick) instead of being cut by the database closing
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Dashboard server stopped');
          resolve();
        });
        this.server.closeAllConnections?.();
      } else {
        resolve();
      }
    });
  }

  /** Get the Express app instance (for testing) */
  getApp(): express.Application {
    return this.app;
  }
}
