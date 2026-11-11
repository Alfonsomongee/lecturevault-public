import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { DashboardServer } from '../../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';

const logger = pino({ level: 'silent' });

function post(port: number, url: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: `http://127.0.0.1:${port}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('POST /api/ask', () => {
  let tmp: string;
  let db: DatabaseManager;
  let server: DashboardServer;
  let release!: () => void;
  let embedCalls = 0;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-ask-'));
    db = new DatabaseManager(path.join(tmp, 't.db'), logger);

    // Gemini: answering is instant, but embedding hangs until the test lets it go
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).includes('batchEmbedContents')) {
        embedCalls++;
        await gate;
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ embeddings: body.requests.map(() => ({ values: [3, 4] })) }) };
      }
      const answer = { found: false, answer: '', citations: [] };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }) };
    }));

    server = new DashboardServer(db, { port: 0, dataDir: tmp, geminiApiKey: 'AIza-test' }, logger);
    await server.start();

    // A class whose notes were never embedded (ingested without AI), added once the server is up
    const id = db.createLocalRecording({ transcriptId: 'cype', title: 'Clase de CYPE', createdAt: '2026-03-01T10:00:00Z', durationSeconds: 60 }).id;
    new StudyRepository(db.handle).replaceChunks(id, 'notes', [{ source: 'notes', start_ms: 0, end_ms: 1000, text: 'La práctica de CYPE pesa el treinta por ciento' }]);
  });

  afterAll(async () => {
    release();
    await new Promise((r) => setTimeout(r, 50)); // let the background indexing finish before the database goes
    await server.stop();
    db.close();
    vi.unstubAllGlobals();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers without waiting for the embeddings that are missing, and indexes them in the background', async () => {
    const res = await post(server.getPort(), '/api/ask', { question: '¿Qué peso tiene la práctica de CYPE?' });

    expect(res.status).toBe(200);
    expect(res.json.sources.length).toBeGreaterThan(0);
    expect(res.json.mode).toBe('lexical'); // no vectors yet: it used the text search
    expect(embedCalls).toBe(1); // the indexing did start, it is just not in the way
    expect(new StudyRepository(db.handle).countChunksMissingEmbedding('gemini-embedding-001:768')).toBe(1);
  });
});
