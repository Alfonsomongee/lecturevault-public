import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NOTES_PROMPT_VERSION } from '../../src/study/notes-sections.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { CampusRepository } from '../../src/database/CampusRepository.js';
import { TranscriptIngestor } from '../../src/library/TranscriptIngestor.js';

const logger = pino({ level: 'silent' });

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

function request(
  port: number,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try { json = JSON.parse(body); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Dashboard API', () => {
  let tmp: string;
  let db: DatabaseManager;
  let server: DashboardServer;
  let port: number;
  let recId: number;

  const origin = () => `http://127.0.0.1:${port}`;
  const get = (url: string, headers: Record<string, string> = {}) => request(port, 'GET', url, { headers });
  const send = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
    request(port, method, url, { body, headers: { Origin: origin(), ...headers } });

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-api-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);

    const dir = path.join(tmp, 'transcripts', 'clase1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clase1.json'), JSON.stringify({
      recordingId: 'clase1', audioDurationSeconds: 100, timestamp: '2026-03-02T10:00:00Z',
      segments: [
        { id: 0, start: 0, end: 10, text: 'Definimos las restricciones en Ansys.', no_speech_prob: 0.01 },
        { id: 1, start: 10, end: 20, text: 'La práctica de CYPE pesa un treinta por ciento.', no_speech_prob: 0.01 },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'clase1.clean.md'), '# Clase\n\n## Evaluación [00:10]\n\nCYPE pesa el 30%.');
    fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'audio', 'clase1.wav'), Buffer.alloc(1000, 7));
    fs.writeFileSync(path.join(tmp, 'secret.wav'), 'top secret');

    new TranscriptIngestor(db, tmp, logger).ingestAll({ course: 'Simulación' });
    recId = db.getRecordingByTranscriptId('clase1')!.id;
    const study = new StudyRepository(db.handle);
    study.replaceAlerts(recId, [{ kind: 'deadline', text: 'Entrega de CYPE', quote: 'q', t_ms: 10_000, due_date: '2026-03-20' }]);
    study.upsertFlashcards(recId, [{ kind: 'basic', front: '¿Peso de CYPE?', back: '30%', t_ms: 10_000 }]);

    server = new DashboardServer(db, { port: 0, dataDir: tmp }, logger);
    await server.start();
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('security', () => {
    it('sets a strict CSP and hardening headers', async () => {
      const res = await get('/api/health');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects foreign Host headers (DNS rebinding)', async () => {
      const res = await get('/api/recordings', { Host: 'evil.example.com' });
      expect(res.status).toBe(403);
    });

    it('rejects cross-site writes and non-JSON writes (CSRF)', async () => {
      const foreign = await send('PATCH', `/api/recordings/${recId}`, { course: 'x' }, { Origin: 'https://evil.example.com' });
      expect(foreign.status).toBe(403);
      const form = await request(port, 'POST', '/api/ingest', {
        headers: { Origin: origin(), 'Content-Type': 'text/plain', 'Content-Length': '2' },
      });
      expect(form.status).toBe(415);
      expect(db.getRecordingById(recId)!.course).toBe('Simulación');
    });

    it('returns clean errors for malformed JSON and bad ids', async () => {
      const bad = await request(port, 'PATCH', `/api/recordings/${recId}`, {
        headers: { Origin: origin(), 'Content-Type': 'application/json' },
        raw: '{"course": ',
      });
      expect(bad.status).toBe(400);
      expect(bad.body).not.toMatch(/at .*\.js|SyntaxError/);
      expect((await get('/api/recordings/abc')).status).toBe(400);
      expect((await get('/api/recordings/999999')).status).toBe(404);
      expect((await get('/api/recordings/' + encodeURIComponent('1; DROP TABLE recordings'))).status).toBe(400);
      const res = await get('/api/nope');
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: 'No encontrado' });
    });

    it('never serves files outside data/audio, even when the transcript id is tampered in the DB', async () => {
      db.handle.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?').run('../secret', recId);
      const res = await get(`/api/recordings/${recId}/audio`);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('top secret');
      db.handle.prepare('UPDATE recordings SET transcript_id = ? WHERE id = ?').run('clase1', recId);
    });
  });

  describe('library', () => {
    it('lists recordings with study progress, courses and stats', async () => {
      const res = await get('/api/recordings');
      expect(res.status).toBe(200);
      expect(res.json.recordings).toHaveLength(1);
      expect(res.json.recordings[0]).toMatchObject({
        course: 'Simulación', segment_count: 2, has_notes: 1, alert_count: 1, flashcard_count: 1, has_audio: true,
      });
      expect(res.json.courses).toEqual([{ course: 'Simulación', count: 1, totalSeconds: 100 }]);
      expect(res.json.stats).toMatchObject({ total: 1, processed: 1, transcribed: 1, flashcards: 1 });
      expect((await get('/api/recordings?course=Otra')).json.recordings).toHaveLength(0);
    });

    it('returns the detail with notes, alerts and flashcards', async () => {
      const { json } = await get(`/api/recordings/${recId}`);
      expect(json.notes.markdown).toContain('Evaluación [00:10]');
      expect(json.alerts[0]).toMatchObject({ kind: 'deadline', due_date: '2026-03-20' });
      expect(json.flashcards[0].front).toBe('¿Peso de CYPE?');
      expect(json.has_audio).toBe(true);
    });

    it('lets the user assign a course', async () => {
      const res = await send('PATCH', `/api/recordings/${recId}`, { course: '  Estructuras  ' });
      expect(res.json.recording.course).toBe('Estructuras');
      expect((await send('PATCH', `/api/recordings/${recId}`, {})).status).toBe(400);
      await send('PATCH', `/api/recordings/${recId}`, { course: 'Simulación' });
    });

    it('serves segments and WebVTT subtitles', async () => {
      const segs = await get(`/api/recordings/${recId}/segments`);
      expect(segs.json.segments[1]).toMatchObject({ start_ms: 10_000, doubtful: false });
      const vtt = await get(`/api/recordings/${recId}/subtitles.vtt`);
      expect(vtt.headers['content-type']).toContain('text/vtt');
      expect(vtt.body.startsWith('WEBVTT')).toBe(true);
      expect(vtt.body).toContain('00:00:10.000 --> 00:00:20.000');
    });

    it('streams audio with Range support so the player can seek', async () => {
      const full = await get(`/api/recordings/${recId}/audio`);
      expect(full.status).toBe(200);
      expect(full.headers['accept-ranges']).toBe('bytes');
      const part = await get(`/api/recordings/${recId}/audio`, { Range: 'bytes=100-199' });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 100-199/1000');
      expect(part.body).toHaveLength(100);
    });
  });

  describe('search and study', () => {
    it('searches with accents, prefixes, typos and filters', async () => {
      const res = await get('/api/search?q=' + encodeURIComponent('restriccion'));
      expect(res.json.hits[0]).toMatchObject({ recordingId: recId, startMs: 0 });
      const typo = await get('/api/search?q=ansis');
      expect(typo.json.corrected).toEqual([{ from: 'ansis', to: 'ansys' }]);
      expect((await get('/api/search?q=')).json.hits).toEqual([]);
      expect((await get('/api/search?q=cype&course=Otra')).json.hits).toEqual([]);
      expect((await get('/api/search?q=%22%20OR%20NEAR(')).status).toBe(200);
    });

    it('answers "ask" with BM25 sources when no AI key is configured', async () => {
      const res = await send('POST', '/api/ask', { question: '¿Qué peso tiene CYPE?' });
      expect(res.status).toBe(200);
      expect(res.json.answer).toBeNull();
      expect(res.json.sources[0].recordingId).toBe(recId);
      expect((await send('POST', '/api/ask', { question: '  ' })).status).toBe(400);
    });

    it('refuses to queue "Generar con IA" without a Gemini key, and the queue starts empty', async () => {
      const res = await send('POST', '/api/jobs', { ids: [recId] });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/GEMINI_API_KEY/);
      expect((await get('/api/jobs')).json).toEqual({ active: [], finished: [], batch: null });
      expect((await send('POST', '/api/jobs/cancel', {})).json).toEqual({ cancelled: 0 });
    });

    it('lists the classes whose notes a regenerate job would rewrite', async () => {
      // the imported .clean.md of this class was not written by the current prompt
      expect((await get('/api/notes/outdated')).json).toEqual({ version: NOTES_PROMPT_VERSION, ids: [recId] });
    });

    it('keeps the target grade per course on the server', async () => {
      const url = `/api/courses/${encodeURIComponent('Simulación')}/grades`;
      expect((await get(url)).json).toMatchObject({ target: 5, targetSaved: false });
      expect((await send('PUT', `${url}/target`, { target: 7.5 })).json).toMatchObject({ target: 7.5, targetSaved: true });
      expect((await get(url)).json.target).toBe(7.5);
      expect((await get(`${url}?target=6`)).json.target).toBe(6); // a what-if never overwrites it
      expect((await get(url)).json.target).toBe(7.5);
      expect((await send('PUT', `${url}/target`, { target: 11 })).status).toBe(400);
      expect((await get('/api/settings')).json.settings).not.toHaveProperty('grade_target:Simulación');
    });

    it('lists dismissed alerts so they can be restored after a reload', async () => {
      const id = (await get('/api/alerts')).json.alerts[0].id;
      await send('PATCH', `/api/alerts/${id}`, { dismissed: true });
      const after = (await get('/api/alerts')).json.alerts.find((a: any) => a.id === id);
      expect(after.dismissed).toBe(1);
      expect((await get(`/api/recordings/${recId}`)).json.alerts.some((a: any) => a.id === id && a.dismissed)).toBe(true);
      expect((await get('/api/recordings')).json.recordings[0].alert_count).toBe(0);
      await send('PATCH', `/api/alerts/${id}`, { dismissed: false });
    });

    it('rejects impossible calendar dates', async () => {
      const id = (await get('/api/alerts')).json.alerts[0].id;
      for (const bad of ['2026-02-31', '2026-13-45', '2026-1-5']) {
        expect((await send('PATCH', `/api/alerts/${id}`, { due_date: bad })).status, bad).toBe(400);
      }
      expect((await send('PATCH', `/api/recordings/${recId}`, { date: '2026-02-30' })).status).toBe(400);
    });

    it('lets the user correct the class date and filter recordings without a course', async () => {
      const ok = await send('PATCH', `/api/recordings/${recId}`, { date: '2026-03-04' });
      expect(new Date(ok.json.recording.created_at).getDate()).toBe(4);
      await send('PATCH', `/api/recordings/${recId}`, { course: '' });
      expect((await get('/api/recordings?course=__none__')).json.recordings).toHaveLength(1);
      expect((await get('/api/search?q=cype&course=__none__')).json.hits.length).toBeGreaterThan(0);
      expect((await get('/api/flashcards?course=__none__')).json.flashcards).toHaveLength(1);
      await send('PATCH', `/api/recordings/${recId}`, { course: 'Simulación' });
    });

    it('exposes the course catalog and moves classes in bulk, resolving short aliases', async () => {
      fs.copyFileSync(path.resolve('courses.example.json'), path.join(tmp, 'courses.json'));
      const meta = (await get('/api/meta')).json;
      expect(meta.catalog).toHaveLength(10);
      expect(meta.catalog[4].label).toBe('05MUIN Sistemas de automatización y control');

      const moved = await send('POST', '/api/recordings/assign', { ids: [recId], course: '05' });
      expect(moved.json).toEqual({ updated: 1, course: '05MUIN Sistemas de automatización y control' });
      expect((await get(`/api/recordings/${recId}`)).json.recording.course).toContain('05MUIN');
      expect((await send('PATCH', `/api/recordings/${recId}`, { course: '6' })).json.recording.course).toContain('06MUIN');

      expect((await send('POST', '/api/recordings/assign', { ids: [], course: '05' })).status).toBe(400);
      expect((await send('POST', '/api/recordings/assign', { ids: ['x'], course: '05' })).status).toBe(400);
      expect((await send('POST', '/api/recordings/assign', { ids: [recId], course: '__none__' })).json.course).toBe('');
      await send('PATCH', `/api/recordings/${recId}`, { course: 'Simulación' });
      fs.rmSync(path.join(tmp, 'courses.json'));
    });

    it('answers 429 with a useful message when the quota endpoints are hammered', async () => {
      let last: Res | undefined;
      for (let i = 0; i < 8; i++) last = await send('POST', '/api/ingest', {});
      expect(last!.status).toBe(429);
      expect(last!.json.error).toMatch(/espera/);
    });

    it('confirms alerts and validates dates', async () => {
      const alertId = (await get('/api/alerts')).json.alerts[0].id;
      const ok = await send('PATCH', `/api/alerts/${alertId}`, { confirmed: true, due_date: '2026-03-21' });
      expect(ok.json.alert).toMatchObject({ confirmed: 1, due_date: '2026-03-21' });
      expect((await send('PATCH', `/api/alerts/${alertId}`, { due_date: '21/03' })).status).toBe(400);
      expect((await send('PATCH', '/api/alerts/9999', { confirmed: true })).status).toBe(404);
    });

    it('exports a calendar with only confirmed alerts when asked', async () => {
      const all = await get('/api/calendar.ics');
      expect(all.headers['content-type']).toContain('text/calendar');
      expect(all.body).toContain('DTSTART;VALUE=DATE:20260321');
      const study = new StudyRepository(db.handle);
      study.replaceAlerts(recId, [{ kind: 'exam', text: 'Sin confirmar', t_ms: 99_000, due_date: '2026-04-01' }]);
      const only = await get('/api/calendar.ics?confirmed=1');
      expect(only.body).toContain('20260321');
      expect(only.body).not.toContain('Sin confirmar');
    });

    it('reviews flashcards and exports Anki files', async () => {
      const card = (await get('/api/flashcards')).json.flashcards[0];
      expect((await get('/api/flashcards?due=1')).json.flashcards).toHaveLength(1);
      const reviewed = await send('POST', `/api/flashcards/${card.id}/review`, { correct: true });
      expect(reviewed.json.flashcard.box).toBe(1);
      expect((await get('/api/flashcards?due=1')).json.flashcards).toHaveLength(0);
      expect((await send('POST', `/api/flashcards/${card.id}/review`, {})).status).toBe(400);

      const anki = await get('/api/export/anki?kind=basic');
      expect(anki.headers['content-disposition']).toContain('lecturevault-anki-basic.txt');
      expect(anki.body).toContain('#notetype:Basic');
      expect(anki.body).toContain('¿Peso de CYPE?');
    });

    it('re-ingests transcripts on demand', async () => {
      // (the previous test exhausted the ingest limiter on purpose; call the ingestor directly)
      const result = new TranscriptIngestor(db, tmp, logger).ingestAll();
      expect(result.scanned).toBe(1);
      expect(result.updatedSegments).toBe(0);
    });
  });

  describe('UI shell', () => {
    it('serves the app and vendored libraries from the local server', async () => {
      expect((await get('/')).status).toBe(200);
      expect((await get('/some/deep/link')).headers['content-type']).toContain('text/html');
      for (const url of ['/vendor/marked.js', '/vendor/purify.js', '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css']) {
        expect((await get(url)).status, url).toBe(200);
      }
    });
  });
});

describe('Dashboard API: editing and persistence', () => {
  let tmp: string;
  let dbPath: string;
  let db: DatabaseManager;
  let server: DashboardServer;
  let port: number;
  let recId: number;
  const origin = () => `http://127.0.0.1:${port}`;
  const get = (url: string) => request(port, 'GET', url);
  const send = (method: string, url: string, body?: unknown) => request(port, method, url, { body: body ?? {}, headers: { Origin: origin() } });

  async function boot() {
    db = new DatabaseManager(dbPath, logger);
    server = new DashboardServer(db, { port: 0, dataDir: tmp }, logger);
    await server.start();
    port = server.getPort();
  }
  async function shutdown() { await server.stop(); db.close(); }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-edit-'));
    dbPath = path.join(tmp, 'lecturevault.db');
    const dir = path.join(tmp, 'transcripts', 'clase1');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'audio', 'clase1.wav'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'clase1.json'), JSON.stringify({
      audioDurationSeconds: 60, timestamp: '2026-03-02T10:00:00Z',
      segments: [{ id: 0, start: 0, end: 10, text: 'Texto de la clase sobre mallado.' }],
    }));
    fs.writeFileSync(path.join(dir, 'clase1.clean.md'), '# Original\n\nTexto original [00:05]');
    await boot();
    new TranscriptIngestor(db, tmp, logger).ingestAll();
    recId = db.getRecordingByTranscriptId('clase1')!.id;
  });
  afterAll(async () => { await shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('edits notes: history kept, file mirrored, search index refreshed, restorable', async () => {
    const res = await send('PUT', `/api/recordings/${recId}/notes`, { markdown: '# Editado\n\nTexto nuevo sobre convergencia [00:05]' });
    expect(res.json.versions).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp, 'transcripts', 'clase1', 'clase1.clean.md'), 'utf8')).toContain('Editado');
    expect((await get('/api/search?q=convergencia')).json.hits.some((h: any) => h.source === 'notes')).toBe(true);
    expect((await get('/api/search?q=original')).json.hits.filter((h: any) => h.source === 'notes')).toHaveLength(0);

    const versionId = res.json.versions[0].id;
    expect((await get(`/api/recordings/${recId}/notes/versions/${versionId}`)).json.markdown).toContain('Original');
    const back = await send('POST', `/api/recordings/${recId}/notes/restore`, { version: versionId });
    expect(back.json.markdown).toContain('Original');
    expect(back.json.versions.length).toBe(2); // the edited text is now history too
    expect((await send('PUT', `/api/recordings/${recId}/notes`, { markdown: 5 })).status).toBe(400);
  });

  it('keeps preferences and playback position in the database across a server restart', async () => {
    await send('PUT', '/api/settings', { theme: 'dark', course: '03MUIN' });
    await send('PUT', `/api/recordings/${recId}/position`, { t: 123.9 });
    expect((await send('PUT', '/api/settings', { evil: 'x' })).status).toBe(400);
    expect((await send('PUT', '/api/settings', { theme: 'pink' })).status).toBe(400);
    expect((await send('PUT', `/api/recordings/${recId}/position`, { t: -4 })).status).toBe(400);

    await shutdown();
    await boot();
    expect((await get('/api/settings')).json.settings).toEqual({ theme: 'dark', course: '03MUIN' });
    expect((await get(`/api/recordings/${recId}`)).json.position).toBe(123);
  });

  it('renames a class, adds and removes markers', async () => {
    // The rename is the campus title (locked against the AI); the original title stays for sync (B5)
    const renamed = (await send('PATCH', `/api/recordings/${recId}`, { title: '  Clase 2 · Mallado  ' })).json.recording;
    expect(renamed).toMatchObject({ display_title: 'Clase 2 · Mallado', title_source: 'user', title: 'clase1' });
    const m = await send('POST', `/api/recordings/${recId}/markers`, { t_ms: 4500, text: 'Repasar esto' });
    expect(m.json.markers).toEqual([{ id: expect.any(Number), t_ms: 4500, text: 'Repasar esto' }]);
    expect((await send('POST', `/api/recordings/${recId}/markers`, { t_ms: 1, text: ' ' })).status).toBe(400);
    const removed = await send('DELETE', `/api/recordings/${recId}/markers/${m.json.markers[0].id}`);
    expect(removed.json.markers).toEqual([]);
  });

  it('manual alerts survive AI regeneration and can be deleted; AI alerts cannot', async () => {
    const created = await send('POST', `/api/recordings/${recId}/alerts`, { kind: 'deadline', text: 'Entregar informe', due_date: '2026-04-10' });
    expect(created.json.alert).toMatchObject({ source: 'manual', confirmed: 1, due_date: '2026-04-10' });
    expect((await send('POST', `/api/recordings/${recId}/alerts`, { kind: 'bogus', text: 'x' })).status).toBe(400);
    expect((await send('POST', `/api/recordings/${recId}/alerts`, { kind: 'exam', text: 'x', due_date: '2026-02-31' })).status).toBe(400);

    const study = new StudyRepository(db.handle);
    study.replaceAlerts(recId, [{ kind: 'exam', text: 'IA', t_ms: 50_000 }]);
    study.replaceAlerts(recId, []);
    expect(study.listAlerts({ recordingId: recId }).map((a) => a.text)).toEqual(['Entregar informe']);
    expect((await send('DELETE', `/api/alerts/${created.json.alert.id}`)).json.deleted).toBe(true);
    study.replaceAlerts(recId, [{ kind: 'exam', text: 'IA', t_ms: 50_000 }]);
    expect((await send('DELETE', `/api/alerts/${study.listAlerts({ recordingId: recId })[0]!.id}`)).status).toBe(400);
  });

  it('flashcards: create, edit keeps the guid, validate cloze, archive AI cards for good', async () => {
    const made = await send('POST', `/api/recordings/${recId}/flashcards`, { front: '¿Qué es el mallado?', back: 'Discretización', tag: 'fem tema' });
    const card = made.json.flashcard;
    expect(card).toMatchObject({ source: 'manual', tag: 'fem_tema' });
    expect((await send('POST', `/api/recordings/${recId}/flashcards`, { front: '¿Qué es el mallado?', back: 'x' })).status).toBe(409);
    expect((await send('POST', `/api/recordings/${recId}/flashcards`, { kind: 'cloze', front: 'Sin hueco' })).status).toBe(400);

    const edited = await send('PATCH', `/api/flashcards/${card.id}`, { back: 'División en elementos' });
    expect(edited.json.flashcard).toMatchObject({ back: 'División en elementos', guid: card.guid });
    expect((await send('PATCH', `/api/flashcards/${card.id}`, { kind: 'cloze' })).status).toBe(400);

    const study = new StudyRepository(db.handle);
    study.upsertFlashcards(recId, [{ kind: 'basic', front: 'Pregunta IA', back: 'Resp' }]);
    const ai = study.listFlashcards({ recordingId: recId }).find((c) => c.front === 'Pregunta IA')!;
    await send('DELETE', `/api/flashcards/${ai.id}`);
    study.upsertFlashcards(recId, [{ kind: 'basic', front: 'Pregunta IA', back: 'Resp' }]); // regeneration
    expect(study.listFlashcards({ recordingId: recId }).some((c) => c.front === 'Pregunta IA')).toBe(false);
    expect((await get('/api/recordings')).json.recordings.find((r: any) => r.id === recId).flashcard_count).toBe(1);
    await send('DELETE', `/api/flashcards/${card.id}`);
    expect(study.getFlashcard(card.id)).toBeUndefined();
  });

  it('lists what still has to be captured, with the exact command', async () => {
    fs.copyFileSync(path.resolve('courses.example.json'), path.join(tmp, 'courses.json'));
    db.upsertRecording({ collabId: 'AbC-123/xyz', title: 'Clase 4 Térmica', createdAt: '2026-10-05T10:00:00', durationSeconds: 3600, playbackUrl: '', course: '08MUIN Ingeniería térmica y de fluidos' });
    const { pending, batch } = (await get('/api/pending')).json;
    expect(pending).toHaveLength(1);
    expect(pending[0].command).toBe('npm run capture:and:transcribe -- --course 08MUIN --date 2026-10-05 --name AbC-123_xyz');
    expect(batch).toContain('batch:transcribe');
    expect(pending.some((p: any) => p.title.includes('Clase 2'))).toBe(false); // captured classes are not pending
  });

  it('ignores a class not worth capturing, sync keeps it ignored, and it can be brought back', async () => {
    const id = db.getRecordingByCollabId('AbC-123/xyz')!.id;
    expect((await send('PATCH', `/api/recordings/${id}`, { ignored: 'yes' })).status).toBe(400);
    await send('PATCH', `/api/recordings/${id}`, { ignored: true });
    db.upsertRecording({ collabId: 'AbC-123/xyz', title: 'Clase 4 Térmica', createdAt: '2026-10-05T10:00:00', durationSeconds: 3600, playbackUrl: '', course: '08MUIN Ingeniería térmica y de fluidos' });
    let res = (await get('/api/pending')).json;
    expect(res.pending).toHaveLength(0);
    expect(res.ignored.map((p: any) => p.id)).toEqual([id]);
    expect((await get('/api/meta')).json.pending).toBe(0);
    await send('PATCH', `/api/recordings/${id}`, { ignored: false });
    res = (await get('/api/pending')).json;
    expect(res.pending.map((p: any) => p.id)).toEqual([id]);
    expect(res.ignored).toEqual([]);
  });

  it('removes a class: Collab2 rows keep their row but lose local data; local ones disappear; files optional', async () => {
    const collab = db.getRecordingByCollabId('AbC-123/xyz')!;
    expect((await send('DELETE', `/api/recordings/${collab.id}`)).json.removed).toBe('local-data');
    expect(db.getRecordingById(collab.id)).toBeDefined();

    const local = db.getRecordingByTranscriptId('clase1')!;
    const removed = (await send('DELETE', `/api/recordings/${local.id}?files=1`)).json;
    expect(removed.removed).toBe('recording');
    expect(db.getRecordingById(local.id)).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'transcripts', 'clase1'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'audio', 'clase1.wav'))).toBe(false);
    // ...but not lost: they wait in the trash with their layout
    expect(removed.trash).toMatch(/^trash[\\/]\d{8}-\d{6}-clase1$/);
    expect(fs.existsSync(path.join(tmp, removed.trash, 'audio', 'clase1.wav'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, removed.trash, 'transcripts', 'clase1'))).toBe(true);
    expect((await send('DELETE', '/api/recordings/999999')).status).toBe(404);
  });

  it('creates a consistent backup, edits the catalog and reports system state', async () => {
    const backup = await send('POST', '/api/backup');
    expect(backup.json.bytes).toBeGreaterThan(0);
    const copy = new DatabaseManager(backup.json.file, logger);
    expect(copy.getAllRecordings().length).toBe(db.getAllRecordings().length);
    copy.close();
    const sys = (await get('/api/system')).json;
    expect(sys.backups).toHaveLength(1);
    expect(sys.ai).toBe(false);

    const saved = await send('PUT', '/api/catalog', { courses: [{ code: 'X1', name: 'Física' }] });
    expect(saved.json.courses).toEqual([{ code: 'X1', name: 'Física' }]);
    expect((await get('/api/meta')).json.catalog[0].label).toBe('X1 Física');
    expect((await send('PUT', '/api/catalog', { courses: [{ code: 'A', name: 'a' }, { code: 'a', name: 'b' }] })).status).toBe(400);
    expect((await send('PUT', '/api/catalog', { courses: [{ code: '', name: 'b' }] })).status).toBe(400);
  });
});

describe('Dashboard API: campus', () => {
  const COURSE = '02MUIN Ingeniería mecánica';
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;
  let server: DashboardServer;
  let port: number;
  let theoryId: number;
  let projectId: number;
  let presentationId: number;
  const origin = () => `http://127.0.0.1:${port}`;
  const get = (url: string) => request(port, 'GET', url);
  const send = (method: string, url: string, body?: unknown) => request(port, method, url, { body: body ?? {}, headers: { Origin: origin() } });
  const c = encodeURIComponent(COURSE);

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-campus-api-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);
    campus = new CampusRepository(db.handle);
    const add = (id: string, date: string) => {
      db.upsertRecording({ collabId: id, title: id, createdAt: `${date}T16:00:00.000Z`, durationSeconds: 7200, playbackUrl: '', course: COURSE });
      return db.getRecordingByCollabId(id)!.id;
    };
    presentationId = add('s01', '2026-10-05');
    theoryId = add('s02', '2026-10-12');
    projectId = add('s03', '2026-10-19');
    campus.renumberClasses(COURSE);

    const parte1 = campus.upsertDeliverable(COURSE, { key: 'proyecto-parte-1', title: 'Proyecto parte 1' });
    const examen = campus.upsertExam(COURSE, { key: 'final-ordinaria', title: 'Examen final (1.ª convocatoria)' });
    campus.applyAiProfile(COURSE, { teacher: 'Prof. García', syllabus: [{ n: 1, title: 'Mecanismos' }, { n: 2, title: 'Dinámica' }] }, { recording_id: presentationId });

    // s01: presentation only; s02: theory of Tema 2; s03: a project session about parte 1
    campus.setSessionAnalysis(presentationId, { session_kind: 'presentation', analysis_version: '1' });
    campus.replaceNoteSections(presentationId, [{ destination: 'course_info', heading: 'Presentación', markdown: '', start_ms: 0, end_ms: 7_200_000 }]);
    campus.setSessionAnalysis(theoryId, { session_kind: 'theory', topic: 'Tema 2. Dinámica', analysis_version: '1' });
    campus.replaceNoteSections(theoryId, [{ destination: 'theory', heading: 'Ecuaciones de Lagrange', markdown: '', start_ms: 0, end_ms: 7_200_000 }]);
    campus.setSessionAnalysis(projectId, { session_kind: 'project', analysis_version: '1' });
    campus.replaceNoteSections(projectId, [{ destination: 'deliverable', entity_id: parte1.id, heading: 'Dudas de la parte 1', markdown: '', start_ms: 0, end_ms: 7_200_000 }]);
    campus.replaceMentions(projectId, [{ entity_type: 'deliverable', entity_id: parte1.id, kind: 'format', text: 'Formato IEEE', t_ms: 60_000 }]);
    campus.replaceAiMarkers(theoryId, [{ t_ms: 600_000, text: 'Lagrange', why: 'Entra en el examen' }]);

    campus.replaceAiEvents(presentationId, COURSE, [
      { kind: 'deadline', title: 'Entrega parte 1', date: '2026-10-30', deliverable_id: parte1.id, t_ms: 1_800_000, confidence: 'medium' },
      { kind: 'deadline', title: 'Foro 1', date: '2026-10-20', t_ms: 1_900_000, confidence: 'medium' },
      { kind: 'exam', title: 'Examen 1.ª', date: '2027-01-18', exam_id: examen.id, t_ms: 1_920_000, confidence: 'high' },
      { kind: 'lab', title: 'Práctica grupo D', date: null, t_ms: 2_409_000, confidence: 'low' },
    ]);
    const lab = campus.listEvents({ course: COURSE }).find((e) => e.kind === 'lab')!;
    campus.createProposal({ course: COURSE, target: `event:${lab.id}.date`, proposed_value: '2026-11-20', recording_id: presentationId, t_ms: 2_409_000, quote: 'el día de noviembre' });

    server = new DashboardServer(db, { port: 0, dataDir: tmp }, logger);
    await server.start();
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('home: overdue, upcoming, things to confirm and a card per course', async () => {
    const home = (await get('/api/home?today=2026-10-27&days=14')).json;
    expect(home.overdue.map((e: any) => e.title)).toEqual(['Foro 1']);
    expect(home.upcoming.map((e: any) => e.title)).toEqual(['Entrega parte 1']);
    expect(home.to_confirm.map((e: any) => e.title)).toEqual(expect.arrayContaining(['Práctica grupo D', 'Entrega parte 1']));
    expect(home.proposals).toBe(1);
    expect(home.courses).toEqual([expect.objectContaining({ course: COURSE, classes: 3, deliverables_open: 1, proposals: 1 })]);
    expect(home.courses[0].next.title).toBe('Entrega parte 1');
    expect((await get('/api/meta')).json.proposals).toBe(1);
  });

  it('a finished deliverable is no longer overdue', async () => {
    const parte1 = campus.findDeliverable(COURSE, 'proyecto-parte-1')!;
    expect((await send('PATCH', `/api/deliverables/${parte1.id}`, { status: 'done' })).json.deliverable).toMatchObject({ status: 'done', source: 'ai' });
    expect((await get('/api/home?today=2026-11-02')).json.overdue.map((e: any) => e.title)).toEqual(['Foro 1']);
    expect((await send('PATCH', `/api/deliverables/${parte1.id}`, { status: 'later' })).status).toBe(400);
    await send('PATCH', `/api/deliverables/${parte1.id}`, { status: 'todo' });
  });

  it('PDF content: a class without its title, and the theory of the course by topic', async () => {
    // nothing written yet: nothing to print, and no browser is started to find out
    for (const url of [`/api/recordings/${theoryId}/export`, `/api/recordings/${theoryId}/pdf`, `/api/courses/${c}/export`]) {
      expect((await get(url)).status).toBe(404);
    }

    const study = new StudyRepository(db.handle);
    study.saveNotes(theoryId, '# Clase 2. Dinámica\n\n## Resumen\nLagrange.\n\n## Ecuaciones de Lagrange [00:10]\n- $L = T - V$', 'test', '3');
    campus.setSectionNotes(theoryId, [{ ord: 0, gist: 'Lagrange', markdown: '### Ecuaciones [00:10]\n- $L = T - V$' }]);

    const one = (await get(`/api/recordings/${theoryId}/export`)).json;
    expect(one.course).toBe(COURSE);
    expect(one.markdown.startsWith('## Resumen')).toBe(true);
    expect(one.markdown).not.toContain('# Clase 2');

    const all = (await get(`/api/courses/${c}/export`)).json;
    expect(all.topics).toHaveLength(1); // the presentation and the project session are not theory
    expect(all.topics[0].topic).toMatch(/^Tema 2/);
    expect(all.topics[0].classes[0].markdown).toBe('### Ecuaciones [00:10]\n- $L = T - V$');
    expect(all.without_notes).toEqual([]);
  });

  it('course page: sheet, entities with their next date and every session in class order', async () => {
    const page = (await get(`/api/courses/${c}`)).json;
    expect(page.profile).toMatchObject({ teacher: 'Prof. García', locked: 0 });
    expect(page.deliverables[0]).toMatchObject({ key: 'proyecto-parte-1', mentions: 1 });
    expect(page.deliverables[0].next.date).toBe('2026-10-30');
    expect(page.exams[0].next.date).toBe('2027-01-18');
    expect(page.sessions.map((s: any) => s.class_number)).toEqual([1, 2, 3]);
    expect(page.proposals).toHaveLength(1);
    expect((await get('/api/courses/No%20existe')).status).toBe(404);
  });

  it('theory groups by syllabus block and leaves out presentation and project sessions', async () => {
    const theory = (await get(`/api/courses/${c}/theory`)).json;
    expect(theory.groups).toEqual([
      { topic: 'Tema 2. Dinámica', classes: [expect.objectContaining({ id: theoryId, highlights: 1, theory_sections: [expect.objectContaining({ heading: 'Ecuaciones de Lagrange' })] })] },
    ]);
  });

  it('deliverable and exam detail gather mentions, sessions and dates', async () => {
    const parte1 = campus.findDeliverable(COURSE, 'proyecto-parte-1')!;
    const detail = (await get(`/api/deliverables/${parte1.id}`)).json;
    expect(detail.mentions.map((m: any) => [m.text, m.class_number])).toEqual([['Formato IEEE', 3]]);
    expect(detail.dedicated_sessions).toEqual([projectId]);
    expect(detail.events.map((e: any) => e.date)).toEqual(['2026-10-30']);
    const exam = (await get(`/api/exams/${campus.findExam(COURSE, 'final-ordinaria')!.id}`)).json;
    expect(exam.events[0].title).toBe('Examen 1.ª');
    expect((await get('/api/deliverables/999')).status).toBe(404);

    // The checklist of requirements is user state in the database
    const mentionId = detail.mentions[0].id;
    expect((await send('PUT', `/api/deliverables/${parte1.id}/checklist`, { done: [mentionId] })).json.checklist).toEqual([mentionId]);
    expect((await get(`/api/deliverables/${parte1.id}`)).json.checklist).toEqual([mentionId]);
    expect((await send('PUT', `/api/deliverables/${parte1.id}/checklist`, { done: ['x'] })).status).toBe(400);
  });

  it('profile: user edits, lock and unlock', async () => {
    const saved = await send('PUT', `/api/courses/${c}/profile`, { schedule: '18:00–20:00', syllabus: [{ n: 1, title: 'Mecanismos' }, { title: '  ' }] });
    expect(saved.json.profile).toMatchObject({ schedule: '18:00–20:00', syllabus: [{ n: 1, title: 'Mecanismos' }] });
    expect((await send('POST', `/api/courses/${c}/profile/lock`, { locked: true })).json.profile.locked).toBe(1);
    expect((await send('POST', `/api/courses/${c}/profile/lock`, {})).status).toBe(400);
  });

  it('events: create, edit, confirm, dismiss and validate input', async () => {
    const created = (await send('POST', '/api/events', { course: COURSE, kind: 'other', title: 'Tutoría', date: '2026-11-05', time: '18:00' })).json.event;
    expect(created).toMatchObject({ source: 'user', confirmed: 1, time: '18:00' });
    expect((await send('POST', '/api/events', { course: COURSE, kind: 'party', title: 'x' })).status).toBe(400);
    expect((await send('POST', '/api/events', { course: COURSE, kind: 'other', title: 'x', date: '5/11' })).status).toBe(400);

    const ai = campus.listEvents({ course: COURSE }).find((e) => e.title === 'Foro 1')!;
    expect((await send('PATCH', `/api/events/${ai.id}`, { date: '2026-10-21' })).json.event).toMatchObject({ date: '2026-10-21', source: 'user' });
    expect((await send('PATCH', `/api/events/${ai.id}`, { time: '25:00' })).status).toBe(400);
    expect((await get(`/api/events?course=${c}&from=2026-11-01&to=2026-11-30`)).json.events.map((e: any) => e.title)).toEqual(['Tutoría', 'Práctica grupo D']);

    await send('DELETE', `/api/events/${created.id}`);
    expect(campus.getEvent(created.id)).toBeUndefined();
  });

  it('review inbox: accepting a date fills the event; a resolved proposal cannot be resolved again', async () => {
    const [p] = (await get('/api/proposals?status=open')).json.proposals;
    expect(p).toMatchObject({ proposed_value: '2026-11-20', recording_title: 's01' });
    expect(p.event.title).toBe('Práctica grupo D');
    const accepted = await send('POST', `/api/proposals/${p.id}/accept`);
    expect(accepted.json.proposal.status).toBe('accepted');
    expect(campus.getEvent(p.event.id)).toMatchObject({ date: '2026-11-20', confirmed: 1 });
    expect((await send('POST', `/api/proposals/${p.id}/reject`)).status).toBe(409);
  });

  it('class page carries ranges, key moments and mentions; class number edits keep the title prefix', async () => {
    const page = (await get(`/api/recordings/${theoryId}`)).json;
    expect(page.campus.highlights).toEqual([expect.objectContaining({ text: 'Lagrange', why: 'Entra en el examen' })]);
    expect(page.campus.sections[0]).toMatchObject({ destination: 'theory', heading: 'Ecuaciones de Lagrange' });
    expect(page.markers).toEqual([]); // AI key moments are not the student's bookmarks

    campus.setDisplayTitle(theoryId, 'Clase 2. Ecuaciones de Lagrange', 'ai');
    const rec = (await send('PATCH', `/api/recordings/${theoryId}`, { class_number: 5 })).json.recording;
    expect(rec).toMatchObject({ class_number: 5, display_title: 'Clase 5. Ecuaciones de Lagrange' });
    expect((await send('PATCH', `/api/recordings/${theoryId}`, { class_number: 0 })).status).toBe(400);
  });

  it('the calendar feed reads the campus events', async () => {
    const ics = await get(`/api/calendar.ics?course=${c}`);
    expect(ics.body).toContain('UID:event-');
    expect(ics.body).toContain('SUMMARY:Examen: Examen 1.ª');
  });
});
