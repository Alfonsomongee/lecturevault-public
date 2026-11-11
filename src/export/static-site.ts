/**
 * The friends' web (`docs/`, deployed by Vercel): read-only classes, summaries, notes, transcripts, theory,
 * deliverables, exams, the exam question bank (practice runs in the browser), glossary and the calendar of dates
 * on a static host — no home dashboard, global flashcards or notes grades.
 *
 * How it stays maintainable: nothing here renders HTML templates. The dashboard's own server answers its GET
 * endpoints from a copy of the database without anything private, and each answer is saved as a JSON file.
 * The browser runs the shared views (`public/app`) in read-only mode (`<html data-mode="static">`), and
 * `public/app/static-api.js` reads those files where the dashboard would call the server.
 *
 * Private things never leave the student's machine: the copy loses grades, markers, notes history, the AI
 * queue, settings (deliverable checklists, preferences), the review inbox, done marks and embeddings, and
 * only classes with a transcript are published.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino, { type Logger } from 'pino';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { DashboardServer } from '../dashboard/DashboardServer.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import { buildSearchIndex } from './static-search.js';
import { buildIcs } from '../study/exporters.js';
import type { EventRow } from '../database/CampusRepository.js';

export const STATIC_DATA_VERSION = 1;

/** Tables emptied in the published copy, and personal marks reset (see the file comment). */
const PRIVATE_SQL = [
  'DELETE FROM grade_scores',
  'DELETE FROM markers',
  'DELETE FROM notes_versions',
  'DELETE FROM ai_jobs',
  'DELETE FROM settings',
  'DELETE FROM proposals',
  'DELETE FROM exam_attempts',
  'DELETE FROM exam_questions WHERE dismissed = 1',
  'UPDATE exam_questions SET starred = 0',
  "UPDATE deliverables SET status = 'todo'",
  'UPDATE tasks SET done = 0',
  'UPDATE flashcards SET box = 0, reps = 0, due_at = created_at',
  'UPDATE chunks SET embedding = NULL, embedding_model = NULL',
];

/** Everything the exporter writes in the output folder (the rest, like docs/*.md, is left alone). */
export const SITE_ENTRIES = [
  'app', 'css', 'vendor', 'data', 'static-api', 'audio', 'index.html', 'print.html', 'calendar.ics', '_redirects', '.nojekyll', 'sw.js',
  'manifest.webmanifest', 'icon.svg',
];

export interface StaticSiteOptions {
  dataDir: string;
  outDir: string;
  logger?: Logger;
  /** Timestamp recorded in manifest.json. Default: now. */
  now?: Date;
}

export interface StaticSiteResult {
  classes: number;
  courses: number;
  files: number;
  bytes: number;
}

export interface StaticManifest {
  v: number;
  exportedAt: string;
  /** Course label → file key */
  courses: Record<string, string>;
  /** Classes published (with a transcript) */
  recordings: number[];
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** A copy of the live database with nothing private in it. Returns its path. */
export function privateFreeCopy(live: Database.Database, dir: string): string {
  const file = path.join(dir, 'web.db');
  live.prepare('VACUUM INTO ?').run(file);
  const copy = new Database(file);
  try {
    for (const sql of PRIVATE_SQL) {
      try {
        copy.exec(sql);
      } catch {
        /* an older schema may lack the table */
      }
    }
  } finally {
    copy.close();
  }
  return file;
}

/**
 * The calendar events that go on the web: those the classes or the university gave, not dismissed (the API
 * already leaves those out) and not the student's own loose entries (manual events with no subject). A class
 * that is not published keeps its event but loses the link, the minute and the quote of that class.
 */
export function sharedEvents(events: EventRow[], publishedIds: Set<number>): EventRow[] {
  return events
    .filter((e) => !e.dismissed && !(e.source === 'user' && !e.course))
    .map((e) => (e.recording_id !== null && !publishedIds.has(e.recording_id)
      ? { ...e, recording_id: null, recording_title: null, t_ms: 0, quote: '' }
      : e));
}

/**
 * The app's HTML page, marked read-only, installable (manifest) and kept out of search engines: it is for
 * classmates, and the classes are the teachers' work. Paths stay absolute: the site is served from the domain root.
 */
function staticPage(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/<html([^>]*)>/i, (_m, attrs: string) => `<html${attrs} data-mode="static">`)
    .replace(
      /<\/title>/i,
      [
        '</title>',
        '  <meta name="robots" content="noindex, nofollow">',
        '  <meta name="theme-color" content="#37352f">',
        '  <link rel="manifest" href="/manifest.webmanifest">',
        '  <link rel="apple-touch-icon" href="/icon.svg">',
      ].join('\n')
    )
    .replace(
      '<a class="workspace" href="#/">LectureVault</a>',
      '<a class="workspace" href="#/">LectureVault <span class="static-badge">Apuntes</span></a>'
    );
}

export async function buildStaticSite(live: DatabaseManager, options: StaticSiteOptions): Promise<StaticSiteResult> {
  const outDir = path.resolve(options.outDir);
  const logger = options.logger ?? pino({ level: 'silent' });
  const silent = pino({ level: 'silent' });
  const now = options.now ?? new Date();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-web-'));

  let db: DatabaseManager | null = null;
  let server: DashboardServer | null = null;
  // Written to a fresh folder first and moved into place at the end: a failed export never leaves half a site
  const stage = path.join(tmp, 'site');
  let files = 0;
  let bytes = 0;
  const write = (rel: string, body: string) => {
    const file = path.join(stage, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    files++;
    bytes += Buffer.byteLength(body);
  };
  const writeJson = (key: string, value: unknown) => write(path.join('data', `${key}.json`), JSON.stringify(value));

  try {
    db = new DatabaseManager(privateFreeCopy(live.handle, tmp), silent, { backupDir: path.join(tmp, 'backups') });
    server = new DashboardServer(db, { port: 0, dataDir: options.dataDir, backupDir: path.join(tmp, 'backups') }, silent);
    const base = await server.listenLocal();
    const get = async (url: string): Promise<Response> => {
      const res = await fetch(base + url);
      if (!res.ok) throw new Error(`${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res;
    };
    const json = async <T = any>(url: string): Promise<T> => (await get(url)).json() as Promise<T>;
    const optionalJson = async <T = any>(url: string): Promise<T | null> => {
      const res = await fetch(base + url);
      return res.ok ? ((await res.json()) as T) : null;
    };

    // ── classes: only those with a transcript ──
    const library = await json<{ recordings: { id: number; segment_count: number; course: string | null }[] }>('/api/recordings');
    const published = library.recordings.filter((r) => r.segment_count > 0);
    const ids = published.map((r) => r.id);

    const meta = await json<{ courses: { course: string; count: number }[]; catalog: { label: string }[]; stats: Record<string, unknown> }>('/api/meta');
    const countBy = new Map<string, number>();
    for (const r of published) countBy.set(r.course ?? '', (countBy.get(r.course ?? '') ?? 0) + 1);
    meta.courses = [...countBy.entries()].map(([course, count]) => ({ course, count }));
    const stats = { ...meta.stats, total: published.length, transcribed: published.length };
    writeJson('meta', { ...meta, stats, pending: 0, proposals: 0, ai: false });
    // The audio stays on the student's machine: the web has no player (its minutes open the transcript)
    writeJson('recordings', { ...library, recordings: published.map((r) => ({ ...r, has_audio: false })), stats, courses: meta.courses, ai: false });

    for (const id of ids) {
      writeJson(`rec/${id}`, { ...(await json<Record<string, unknown>>(`/api/recordings/${id}`)), has_audio: false, ai: false });
      writeJson(`seg/${id}`, await json(`/api/recordings/${id}/segments`));
      const exported = await optionalJson(`/api/recordings/${id}/export`);
      if (exported) writeJson(`export/${id}`, exported);
      for (const kind of ['basic', 'cloze']) {
        const res = await fetch(`${base}/api/export/anki?kind=${kind}&recording=${id}`);
        if (res.ok) write(path.join('data', 'anki', `${id}-${kind}.txt`), await res.text());
      }
    }

    // ── courses (the catalog ones and any other with published classes) ──
    const labels = [...new Set([...meta.catalog.map((c) => c.label), ...meta.courses.map((c) => c.course).filter(Boolean)])];
    const courseKeys: Record<string, string> = {};
    labels.forEach((label, i) => (courseKeys[label] = `c${i + 1}`));
    for (const label of labels) {
      const key = courseKeys[label]!;
      const enc = encodeURIComponent(label);
      const detail = await json<{ deliverables: { id: number }[]; exams: { id: number }[]; sessions: { segment_count: number }[] }>(`/api/courses/${enc}`);
      writeJson(`course/${key}`, {
        ...detail,
        sessions: detail.sessions.filter((s) => s.segment_count > 0),
        proposals: [],
        materials: 0,
      });
      writeJson(`theory/${key}`, await json(`/api/courses/${enc}/theory`));
      writeJson(`questions/${key}`, await json(`/api/courses/${enc}/questions`));
      const exported = await optionalJson(`/api/courses/${enc}/export`);
      if (exported) writeJson(`course-export/${key}`, exported);
      for (const d of detail.deliverables) writeJson(`deliverable/${d.id}`, await json(`/api/deliverables/${d.id}`));
      for (const x of detail.exams) writeJson(`exam/${x.id}`, await json(`/api/exams/${x.id}`));
    }

    writeJson('exam-bank', await json('/api/exam-bank'));

    // ── calendar: what the classes and the university say, never the student's own entries ──
    const { events } = await json<{ events: EventRow[] }>('/api/events');
    const shared = sharedEvents(events, new Set(ids));
    writeJson('events', { events: shared });
    write(
      'calendar.ics',
      buildIcs(
        shared.filter((e) => e.date).map((e) => ({ ...e, text: e.title, due_date: e.date, uid: `event-${e.id}` })) as unknown as Parameters<typeof buildIcs>[0],
        { now }
      )
    );

    writeJson('search', buildSearchIndex(db.handle, ids));
    const manifest: StaticManifest = {
      v: STATIC_DATA_VERSION,
      exportedAt: now.toISOString(),
      courses: courseKeys,
      recordings: ids,
    };
    writeJson('manifest', manifest);

    // ── the app itself ──
    copyDir(path.join(PROJECT_ROOT, 'public'), stage);
    write('index.html', staticPage(path.join(PROJECT_ROOT, 'public', 'index.html')));
    write('print.html', staticPage(path.join(PROJECT_ROOT, 'public', 'print.html')));
    copyDir(path.join(PROJECT_ROOT, 'node_modules/katex/dist'), path.join(stage, 'vendor/katex'));
    fs.copyFileSync(path.join(PROJECT_ROOT, 'node_modules/marked/lib/marked.umd.js'), path.join(stage, 'vendor/marked.js'));
    fs.copyFileSync(path.join(PROJECT_ROOT, 'node_modules/dompurify/dist/purify.min.js'), path.join(stage, 'vendor/purify.js'));
    write('.nojekyll', '');

    // ── swap into place ──
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of SITE_ENTRIES) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
    for (const entry of fs.readdirSync(stage)) fs.renameSync(path.join(stage, entry), path.join(outDir, entry));

    logger.info({ classes: ids.length, courses: labels.length, files, bytes }, 'static web written');
    return { classes: ids.length, courses: labels.length, files, bytes };
  } finally {
    await server?.stop().catch(() => undefined);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
