import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { seedDemo } from '../../src/demo/seed.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { buildStaticSite, sharedEvents, type StaticManifest } from '../../src/export/static-site.js';
import { exportStaticWebFromDb, publishedClassCount } from '../../src/cli/export-web.js';
import { mergeSegments } from '../../src/export/static-search.js';
import { materialsDir } from '../../src/campus/materials-sync.js';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';

const logger = pino({ level: 'silent' });

describe('static web (the friends\' read-only site)', () => {
  let tmp: string;
  let out: string;
  let db: DatabaseManager;
  let dataDir: string;
  let manifest: StaticManifest;
  let markersBefore = 0;
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-static-'));
    const seeded = seedDemo(path.join(tmp, 'demo'), logger);
    dataDir = seeded.dataDir;
    db = new DatabaseManager(seeded.dbPath, logger);
    // Things only the student may see, which must never reach the published files
    const study = new StudyRepository(db.handle);
    const first = db.getAllRecordings().find((r) => r.transcript_id)!;
    db.handle.prepare('INSERT INTO markers (recording_id, t_ms, text) VALUES (?, ?, ?)').run(first.id, 1000, 'MARCA PRIVADA');
    study.setSetting('pos:' + first.id, '321');
    db.handle.prepare("UPDATE deliverables SET status = 'done'").run();
    const card = study.listFlashcards({ recordingId: first.id })[0];
    if (card) study.reviewFlashcard(card.id, true);
    // Calendar entries that stay private: one the student dismissed and a loose manual one without subject
    const addEvent = db.handle.prepare("INSERT INTO events (course, kind, title, date, source, dismissed) VALUES (?, 'other', ?, '2026-12-01', ?, ?)");
    addEvent.run('Simulación FEM', 'EVENTO DESCARTADO', 'ai', 1);
    addEvent.run('', 'EVENTO PERSONAL', 'user', 0);

    markersBefore = (db.handle.prepare('SELECT COUNT(*) AS n FROM markers').get() as { n: number }).n;
    // What the daily agent leaves for a subject: its campus index and one stored file
    const matDir = materialsDir(dataDir, 'Simulación');
    fs.mkdirSync(path.join(matDir, 'Tema 1'), { recursive: true });
    fs.writeFileSync(path.join(matDir, 'Tema 1', 'mallado.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(matDir, 'index.json'), JSON.stringify({
      version: 1, course: 'Simulación FEM', courseId: '_9_1', courseUrl: 'https://campus.example/ultra/courses/_9_1/outline', updatedAt: '2026-11-07T00:00:00Z',
      items: [{ id: 'f', title: 'Tema 1', path: [], kind: 'folder', modified: null, url: null }, { id: 'p', title: 'Mallado', path: ['Tema 1'], kind: 'file', modified: null, url: null }],
      files: [{ contentId: 'p', attachmentId: 'a', fileName: 'mallado.pdf', mimeType: 'application/pdf', title: 'Mallado', path: ['Tema 1'], modified: null, file: 'Tema 1/mallado.pdf', bytes: 8, sha256: 'abc' }],
    }));
    out = path.join(tmp, 'site');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'notas.md'), 'documentación que no es de la web');
    await buildStaticSite(db, { dataDir, outDir: out, now: new Date('2026-11-07T10:00:00') });
    manifest = read('data/manifest.json');
  }, 60_000);

  afterAll(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is the dashboard app in read-only mode, with its libraries', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/<html[^>]*data-mode="static"/);
    expect(html).toContain('static-badge');
    expect(fs.readFileSync(path.join(out, 'print.html'), 'utf8')).toMatch(/<html[^>]*data-mode="static"/);
    for (const f of ['app/main.js', 'app/static-api.js', 'app/views/recording.js', 'vendor/marked.js', 'vendor/purify.js', 'vendor/katex/katex.min.js']) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    // The rest of the folder (docs/*.md) is left alone
    expect(fs.readFileSync(path.join(out, 'notas.md'), 'utf8')).toBe('documentación que no es de la web');
  });

  it('saves classes, subjects, search and the calendar (no home or global study backlog)', () => {
    const published = db.getAllRecordings().filter((r) => r.transcript_id);
    expect(manifest.recordings.length).toBe(published.length);
    for (const id of manifest.recordings) {
      expect(read(`data/rec/${id}.json`).recording.id).toBe(id);
      expect(read(`data/rec/${id}.json`).has_audio).toBe(false);
      expect(Array.isArray(read(`data/seg/${id}.json`).segments)).toBe(true);
    }
    for (const key of Object.values(manifest.courses)) {
      const course = read(`data/course/${key}.json`);
      expect(course.sessions.every((s: { segment_count: number }) => s.segment_count > 0)).toBe(true);
      expect(course.proposals).toEqual([]);
      expect(course.materials).toBe(0);
      expect(read(`data/theory/${key}.json`).groups).toBeDefined();
    }
    const libs = read('data/recordings.json');
    expect(libs.recordings.every((r: { segment_count: number }) => r.segment_count > 0)).toBe(true);
    expect(libs.courses).toEqual(read('data/meta.json').courses);
    for (const omitted of ['data/flashcards.json', 'data/home', 'data/workload', 'data/materials']) {
      expect(fs.existsSync(path.join(out, omitted)), omitted).toBe(false);
    }
    const search = read('data/search.json');
    expect(search.recs.length).toBe(manifest.recordings.length);
    expect(search.docs.length).toBeGreaterThan(0);
  });

  it('publishes the calendar of dates, without what the student dismissed or wrote for himself', () => {
    const { events } = read('data/events.json') as { events: { title: string; date: string | null; recording_id: number | null }[] };
    expect(events.length).toBeGreaterThan(0);
    const titles = events.map((e) => e.title);
    expect(titles).not.toContain('EVENTO DESCARTADO');
    expect(titles).not.toContain('EVENTO PERSONAL');
    // Every link points to a class that is published
    for (const e of events) if (e.recording_id !== null) expect(manifest.recordings).toContain(e.recording_id);
    const ics = fs.readFileSync(path.join(out, 'calendar.ics'), 'utf8');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).not.toContain('EVENTO DESCARTADO');
    expect(ics).not.toContain('EVENTO PERSONAL');
  });

  it('keeps the event of an unpublished class but not its link, minute or quote', () => {
    const base = { id: 1, course: 'A', kind: 'exam', title: 'Examen', date: '2026-12-10', time: null, deliverable_id: null, exam_id: null, t_ms: 5000, quote: 'dicho en clase', date_text: '', confidence: 'high', confirmed: 1, dismissed: 0, source: 'ai', created_at: '' } as const;
    const shared = sharedEvents([{ ...base, recording_id: 9, recording_title: 'Clase 9' }, { ...base, id: 2, recording_id: 3, recording_title: 'Clase 3' }], new Set([3]));
    expect(shared[0]).toMatchObject({ recording_id: null, t_ms: 0, quote: '' });
    expect(shared[1]).toMatchObject({ recording_id: 3, quote: 'dicho en clase' });
  });

  it('publishes nothing private', () => {
    const all = fs.readdirSync(path.join(out, 'data'), { recursive: true }).map(String)
      .filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(out, 'data', f), 'utf8'))
      .join('\n');
    expect(all).not.toContain('MARCA PRIVADA');
    for (const id of manifest.recordings) {
      const rec = read(`data/rec/${id}.json`);
      expect(rec.markers).toEqual([]);
      expect(rec.position).toBe(0);
      expect(rec.versions).toEqual([]);
      // Review progress is the student's: published cards carry reset box/reps
      expect(rec.flashcards.every((c: { box: number; reps: number }) => c.box === 0 && c.reps === 0)).toBe(true);
    }
    expect(read('data/meta.json')).toMatchObject({ pending: 0, proposals: 0, ai: false });
    for (const key of Object.values(manifest.courses)) {
      for (const d of read(`data/course/${key}.json`).deliverables) expect(d.status).toBe('todo');
    }
    // The live database is untouched
    expect((db.handle.prepare('SELECT COUNT(*) AS n FROM markers').get() as { n: number }).n).toBe(markersBefore);
  });

  it('refuses to replace a published web with a database that lost most of its classes', async () => {
    expect(publishedClassCount(out)).toBe(manifest.recordings.length);
    const emptyDb = new DatabaseManager(path.join(tmp, 'empty.db'), logger);
    try {
      await expect(exportStaticWebFromDb(emptyDb, { dataDir, outDir: out, quiet: true })).rejects.toThrow(/no se sobrescribe/);
      expect(publishedClassCount(out)).toBe(manifest.recordings.length);
    } finally {
      emptyDb.close();
    }
  });
});

describe('mergeSegments', () => {
  const seg = (start: number, text: string, rid = 1) => ({ recording_id: rid, start_ms: start, end_ms: start + 2000, text });
  it('joins consecutive segments of a class into windows', () => {
    const out = mergeSegments([seg(0, 'uno'), seg(2000, 'dos'), seg(4000, 'tres')], 320);
    expect(out).toEqual([{ recording_id: 1, start_ms: 0, text: 'uno dos tres' }]);
  });
  it('starts a new window after a long pause, a full window or another class', () => {
    expect(mergeSegments([seg(0, 'a'), seg(60_000, 'b')]).map((w) => w.text)).toEqual(['a', 'b']);
    expect(mergeSegments([seg(0, 'x'.repeat(400)), seg(2000, 'y')]).map((w) => w.text.length)).toEqual([400, 1]);
    expect(mergeSegments([seg(0, 'a', 1), seg(2000, 'b', 2)]).map((w) => w.recording_id)).toEqual([1, 2]);
  });
});

describe('campus materials in the dashboard and omitted on the friends web', () => {
  it('lists and serves indexed files locally while omitting them from the static export', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-mat-web-'));
    const seeded = seedDemo(path.join(tmp, 'demo'), logger);
    const db = new DatabaseManager(seeded.dbPath, logger);
    const matDir = materialsDir(seeded.dataDir, 'Simulación');
    fs.mkdirSync(matDir, { recursive: true });
    fs.writeFileSync(path.join(matDir, 'mallado.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(seeded.dataDir, 'secreto.txt'), 'no');
    fs.writeFileSync(path.join(matDir, 'index.json'), JSON.stringify({
      version: 1, course: 'Simulación FEM', courseId: '_9_1', courseUrl: 'https://campus.example/ultra/courses/_9_1/outline', updatedAt: '2026-11-07T00:00:00Z',
      items: [{ id: 'p', title: 'Mallado', path: [], kind: 'file', modified: null, url: null }],
      files: [
        { contentId: 'p', attachmentId: 'a', fileName: 'mallado.pdf', mimeType: 'application/pdf', title: 'Mallado', path: [], modified: null, file: 'mallado.pdf', bytes: 8, sha256: 'abc' },
        { contentId: 'x', attachmentId: 'b', fileName: 'x.txt', mimeType: 'text/plain', title: 'Fuera', path: [], modified: null, file: '../secreto.txt', bytes: 2, sha256: 'def' },
      ],
    }));
    const server = new DashboardServer(db, { port: 0, dataDir: seeded.dataDir }, logger);
    try {
      const base = await server.listenLocal();
      const course = encodeURIComponent('Simulación FEM');
      expect((await (await fetch(`${base}/api/courses/${course}`)).json()).materials).toBe(1);
      const list = await (await fetch(`${base}/api/courses/${course}/materials`)).json();
      expect(list.files.map((f: { local: boolean }) => f.local)).toEqual([true, false]);
      expect(await (await fetch(`${base}/api/courses/${course}/materials/file/0`)).text()).toBe('%PDF-1.4');
      // An index entry pointing outside the folder is never served, nor an index that does not exist
      expect((await fetch(`${base}/api/courses/${course}/materials/file/1`)).status).toBe(404);
      expect((await fetch(`${base}/api/courses/${course}/materials/file/7`)).status).toBe(404);
    } finally {
      await server.stop();
    }
    const out = path.join(tmp, 'site');
    await buildStaticSite(db, { dataDir: seeded.dataDir, outDir: out });
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'data', 'manifest.json'), 'utf8'));
    const courseDetail = JSON.parse(fs.readFileSync(path.join(out, 'data', 'course', `${manifest.courses['Simulación FEM']}.json`), 'utf8'));
    expect(courseDetail.materials).toBe(0);
    expect(fs.existsSync(path.join(out, 'data', 'materials'))).toBe(false);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  it('does not exclude docs/data or frontend assets in .vercelignore', () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    expect(vercelConfig.outputDirectory).toBe('docs');

    const rules = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    // Unanchored directory rules (like `data/`) match subdirectories at any depth, including `docs/data/`
    for (const dir of ['data', 'app', 'css', 'vendor']) {
      expect(rules).not.toContain(dir);
      expect(rules).not.toContain(`${dir}/`);
      expect(rules).not.toContain(`docs/${dir}`);
      expect(rules).not.toContain(`docs/${dir}/`);
    }
    expect(rules).toContain('/data/');
  });
});
