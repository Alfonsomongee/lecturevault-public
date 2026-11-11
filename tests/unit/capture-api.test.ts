import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { PROGRESS_PREFIX } from '../../src/capture/progress.js';
import type { LiveCaptureOptions } from '../../src/capture/CaptureRunner.js';

const logger = pino({ level: 'silent' });

interface Res { status: number; json: any }

function request(port: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          Origin: `http://127.0.0.1:${port}`,
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json: any;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PRELUDE = `const P=${JSON.stringify(PROGRESS_PREFIX)};const ev=(o)=>process.stdout.write('\\n'+P+JSON.stringify(o)+'\\n');const ids=process.argv.slice(1).map(Number);`;
const WORKS = `for (const id of ids) { ev({type:'stage',id,stage:'recording'}); ev({type:'progress',id,percent:50,position:5,duration:10}); ev({type:'stage',id,stage:'done'}); }`;
// A live capture ("+"): waits for ENTER on stdin to start recording and again to stop
// (the real process takes seconds to find the player after the first ENTER, so "recording" comes late here too)
const LIVE = `ev({type:'stage',id:0,stage:'waiting'}); let n=0; process.stdin.on('data',()=>{n++; if(n===1) setTimeout(()=>ev({type:'stage',id:0,stage:'recording'}), 400); else {ev({type:'stage',id:0,stage:'done'}); process.exit(0);}});`;
const HANGS = `ev({type:'stage',id:ids[0],stage:'recording'}); setInterval(()=>{}, 1000);`;

describe('Grabar y transcribir (API)', () => {
  let tmp: string;
  let db: DatabaseManager;
  let server: DashboardServer;
  let port: number;
  let script = WORKS;
  const launched: number[][] = [];
  const liveLaunched: LiveCaptureOptions[] = [];
  const ids: Record<string, number> = {};

  const get = (url: string) => request(port, 'GET', url);
  const post = (url: string, body: unknown = {}, headers?: Record<string, string>) => request(port, 'POST', url, body, headers);
  const finished = async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await get('/api/capture')).json;
      if (!s.running) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the capture never ended');
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-capture-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);
    const collab = (name: string, createdAt: string) => {
      db.upsertRecording({ collabId: name, title: `Clase ${name}`, createdAt, durationSeconds: 3600, playbackUrl: `https://collab.example/${name}` });
      return db.getRecordingByCollabId(name)!.id;
    };
    ids['old'] = collab('old', '2026-03-01T10:00:00Z');
    ids['new'] = collab('new', '2026-03-08T10:00:00Z');
    ids['ignored'] = collab('ignored', '2026-03-05T10:00:00Z');
    db.setIgnored(ids['ignored']!, true);
    ids['done'] = collab('done', '2026-02-20T10:00:00Z');
    db.setTranscriptId(ids['done']!, 'done-transcript');
    ids['local'] = db.createLocalRecording({ transcriptId: 'solo-local', title: 'Local', createdAt: '2026-03-02T10:00:00Z', durationSeconds: 60 }).id;
    db.createLocalRecording({ transcriptId: 'con-asignatura', title: 'Con asignatura', createdAt: '2026-03-03T10:00:00Z', durationSeconds: 60, course: '01MUIN Mecánica' });

    server = new DashboardServer(db, {
      port: 0,
      dataDir: tmp,
      liveCaptureCommand: (options) => {
        liveLaunched.push(options);
        return { cmd: process.execPath, args: ['-e', PRELUDE + LIVE], cwd: process.cwd() };
      },
      captureCommand: (wanted) => {
        launched.push(wanted);
        return { cmd: process.execPath, args: ['-e', PRELUDE + script, ...wanted.map(String)], cwd: process.cwd() };
      },
    }, logger);
    await server.start();
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('starts idle and says nothing blocks it', async () => {
    expect((await get('/api/capture')).json).toMatchObject({ running: false, items: [], problem: null });
  });

  it('only captures classes that are pending', async () => {
    expect((await post('/api/capture', {})).status).toBe(400);
    expect((await post('/api/capture', { ids: [] })).status).toBe(400);
    for (const key of ['done', 'local', 'ignored']) {
      const res = await post('/api/capture', { ids: [ids[key]] });
      expect(res.status, key).toBe(400);
      expect(res.json.error).toContain('no está pendiente');
    }
    expect((await post('/api/capture', { ids: [999999] })).status).toBe(400);
    expect((await post('/api/capture', { ids: ['1; rm -rf /'] })).status).toBe(400);
    expect(launched).toEqual([]); // nothing was ever started
  });

  it('refuses writes from other sites', async () => {
    const res = await post('/api/capture', { ids: [ids['old']] }, { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    expect(launched).toEqual([]);
  });

  it('captures the chosen classes, in the order asked, and reports each one', async () => {
    const started = await post('/api/capture', { ids: [ids['new'], ids['old']] });
    expect(started.status).toBe(202);
    expect(started.json.items.map((i: any) => i.id)).toEqual([ids['new'], ids['old']]);

    const status = await finished();
    expect(launched[0]).toEqual([ids['new'], ids['old']]);
    expect(status.items.map((i: any) => i.state)).toEqual(['done', 'done']);
    expect(status).toMatchObject({ exitCode: 0, error: null, cancelled: false });
  });

  it('captures every pending class, oldest first, with "all"', async () => {
    await post('/api/capture', { all: true });
    await finished();
    expect(launched[1]).toEqual([ids['old'], ids['new']]);
  });

  it('runs one capture at a time and can cancel it', async () => {
    script = HANGS;
    expect((await post('/api/capture', { ids: [ids['old']] })).status).toBe(202);
    expect((await post('/api/capture', { ids: [ids['new']] })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 600));
    expect((await get('/api/capture')).json.items[0].state).toBe('recording');

    const cancelled = await post('/api/capture/cancel');
    expect(cancelled.json.stopped).toBe(true);
    const status = await finished();
    expect(status).toMatchObject({ running: false, cancelled: true });
    expect(status.items[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('Cancelada') });
    // the class is still pending: it can be tried again
    expect(db.getPendingCaptures().map((r) => r.id)).toContain(ids['old']);
    expect((await post('/api/capture/cancel')).json.stopped).toBe(false);
  });

  it('forgets the last run when its notice is closed', async () => {
    expect((await get('/api/capture')).json.items.length).toBeGreaterThan(0);
    const cleared = await post('/api/capture/dismiss');
    expect(cleared.json).toMatchObject({ running: false, items: [], log: [] });
  });

  describe('"+": a class chosen in the campus', () => {
    const until = async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await condition()) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new Error('the condition never held');
    };
    const state = async () => (await get('/api/capture')).json.items[0]?.state;

    it('checks everything the browser sends before anything opens', async () => {
      for (const [body, why] of [
        [{}, 'no course'],
        [{ course: '' }, 'empty course'],
        [{ course: 'Alquimia avanzada' }, 'unknown course'],
        [{ course: ['01MUIN Mecánica'] }, 'course that is not text'],
        [{ course: '01MUIN Mecánica', date: '12/10/2026' }, 'date in another format'],
        [{ course: '01MUIN Mecánica', date: '2026-02-31' }, 'impossible date'],
        [{ course: '01MUIN Mecánica', date: '2999-01-01' }, 'future date'],
        [{ course: '01MUIN Mecánica', speed: 3 }, 'speed that is not offered'],
        [{ course: '01MUIN Mecánica', speed: 4 }, '4x garbles the audio'],
        [{ course: '01MUIN Mecánica', speed: '2; rm -rf /' }, 'speed with text'],
      ] as const) {
        expect((await post('/api/capture/live', body)).status, why).toBe(400);
      }
      expect((await post('/api/capture/live', { course: '01MUIN Mecánica' }, { Origin: 'https://evil.example.com' })).status).toBe(403);
      expect(liveLaunched).toEqual([]); // nothing was ever started
    });

    it('starts with the chosen subject, waits for the student, and records only after "Empezar"', async () => {
      const started = await post('/api/capture/live', { course: '01MUIN Mecánica', date: '2026-10-12', speed: 1 });
      expect(started.status).toBe(202);
      expect(started.json).toMatchObject({ running: true, live: true });
      expect(started.json.items).toMatchObject([{ id: 0, title: 'Clase nueva · 01MUIN' }]);
      expect(liveLaunched).toEqual([{ course: '01MUIN Mecánica', date: '2026-10-12', speed: 1 }]);

      await until(async () => (await state()) === 'waiting');
      // one capture at a time, whatever kind
      expect((await post('/api/capture/live', { course: '01MUIN Mecánica' })).status).toBe(409);
      expect((await post('/api/capture', { ids: [ids['old']] })).status).toBe(409);

      expect((await post('/api/capture/enter')).status).toBe(200); // Empezar a grabar
      expect((await post('/api/capture/enter')).status).toBe(409); // a double click does not stop it at once
      await until(async () => (await state()) === 'recording');

      expect((await post('/api/capture/enter')).status).toBe(200); // Parar y guardar
      const status = await finished();
      expect(status).toMatchObject({ live: true, exitCode: 0, error: null, items: [{ state: 'done' }] });
    });

    it('defaults to 2x with no date, accepts a subject by its catalog code, and refuses ENTER when idle', async () => {
      expect((await post('/api/capture/enter')).status).toBe(409);
      expect((await post('/api/capture/live', { course: '01MUIN Mecánica' })).status).toBe(202);
      expect(liveLaunched.at(-1)).toEqual({ course: '01MUIN Mecánica', speed: 2 });
      await until(async () => (await state()) === 'waiting');
      expect((await post('/api/capture/cancel')).json.stopped).toBe(true);
      await finished();
      await post('/api/capture/dismiss');
    });
  });
});
