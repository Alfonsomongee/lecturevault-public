import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { JobRepository } from '../../src/database/JobRepository.js';
import { AiQueue, type JobProcessor } from '../../src/study/AiQueue.js';

describe('background AI queue', () => {
  let tmp: string;
  let db: DatabaseManager;
  let ids: number[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-queue-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), pino({ level: 'silent' }));
    ids = ['a', 'b', 'c'].map((n) => db.createLocalRecording({ transcriptId: `t_${n}`, title: `Clase ${n}`, createdAt: '2026-10-01T10:00:00Z', durationSeconds: 60, course: '01MUIN Test' }).id);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A processor the test releases by hand, to look at the queue while a job runs. */
  function gated() {
    const calls: { id: number; force: boolean }[] = [];
    let release: (() => void) | null = null;
    const processor: JobProcessor = (id, { force }) => {
      calls.push({ id, force });
      return new Promise((resolve) => { release = () => resolve({ title: `Hecha ${id}`, errors: [] }); });
    };
    return { calls, processor, next: async () => { while (!release) await new Promise((r) => setTimeout(r, 1)); const r = release; release = null; r(); } };
  }

  it('runs classes one at a time in order, and never queues the same class twice', async () => {
    const g = gated();
    const queue = new AiQueue(db.handle, g.processor);
    expect(queue.enqueue([ids[0]!, ids[1]!])).toEqual({ queued: 2, already: [] });
    expect(queue.enqueue([ids[1]!, ids[2]!], true)).toEqual({ queued: 1, already: [ids[1]] });

    const s = queue.status();
    expect(s.active.map((j) => [j.recording_id, j.status])).toEqual([[ids[0], 'running'], [ids[1], 'queued'], [ids[2], 'queued']]);
    expect(s.active[0]!.title).toBe('Clase a');
    expect(s.batch).toEqual({ done: 0, total: 3 });

    await g.next();
    await g.next();
    await g.next();
    await queue.idle();
    expect(g.calls).toEqual([{ id: ids[0], force: false }, { id: ids[1], force: false }, { id: ids[2], force: true }]);
    const done = queue.status();
    expect(done.active).toEqual([]);
    expect(done.batch).toBeNull();
    expect(done.finished.map((j) => j.status)).toEqual(['done', 'done', 'done']);
    expect(done.finished[0]!.report).toEqual({ title: `Hecha ${ids[2]}`, errors: [] });
  });

  it('passes the steps a job was queued with to the processor, and none when it runs everything', async () => {
    const calls: { id: number; steps?: string[] }[] = [];
    const queue = new AiQueue(db.handle, async (id, { steps }) => { calls.push({ id, steps }); return {}; });
    queue.enqueue([ids[0]!], false, ['notes', 'embeddings']);
    await queue.idle();
    queue.enqueue([ids[1]!]);
    await queue.idle();
    expect(calls).toEqual([{ id: ids[0], steps: ['notes', 'embeddings'] }, { id: ids[1], steps: undefined }]);
  });

  it('a failing class does not stop the rest, and its error is kept', async () => {
    const queue = new AiQueue(db.handle, async (id) => {
      if (id === ids[0]) throw new Error('Gemini no responde');
      return { errors: [] };
    });
    queue.enqueue(ids);
    await queue.idle();
    const { finished } = queue.status();
    expect(finished.map((j) => [j.recording_id, j.status, j.error])).toEqual([
      [ids[2], 'done', null], [ids[1], 'done', null], [ids[0], 'failed', 'Gemini no responde'],
    ]);
    // Finished, so it can be queued again
    expect(queue.enqueue([ids[0]!]).queued).toBe(1);
    await queue.idle();
  });

  it('cancels what waits but lets the running class finish', async () => {
    const g = gated();
    const queue = new AiQueue(db.handle, g.processor);
    queue.enqueue(ids);
    expect(queue.cancel()).toBe(2);
    expect(queue.status().batch).toEqual({ done: 0, total: 1 });
    await g.next();
    await queue.idle();
    expect(g.calls.map((c) => c.id)).toEqual([ids[0]]);
    expect(queue.status().finished.map((j) => j.status).sort()).toEqual(['cancelled', 'cancelled', 'done']);
  });

  it('a job cut by a restart runs again on the next start', async () => {
    const jobs = new JobRepository(db.handle);
    jobs.enqueue([ids[0]!, ids[1]!]);
    expect(jobs.claimNext()!.recording_id).toBe(ids[0]); // the server died while this one ran

    const seen: number[] = [];
    const queue = new AiQueue(db.handle, async (id) => { seen.push(id); return { errors: [] }; });
    queue.resume();
    await queue.idle();
    expect(seen).toEqual([ids[0], ids[1]]);
  });

  it('gives up on a job that was cut three times, with a reason, and still runs the rest', async () => {
    const jobs = new JobRepository(db.handle);
    jobs.enqueue([ids[0]!, ids[1]!]);
    for (let start = 1; start <= 2; start++) {
      expect(jobs.claimNext()!.attempts).toBe(start); // each start takes the first job and the server dies on it
      expect(jobs.requeueRunning()).toEqual({ requeued: 1, abandoned: 0 });
    }
    expect(jobs.claimNext()!.attempts).toBe(3);

    const seen: number[] = [];
    const queue = new AiQueue(db.handle, async (id) => { seen.push(id); return { errors: [] }; });
    queue.resume();
    await queue.idle();

    expect(seen).toEqual([ids[1]]); // the one that keeps dying is not run again
    const failed = queue.status().finished.find((j) => j.recording_id === ids[0])!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(failed.error).toContain('3 veces');
    expect(queue.enqueue([ids[0]!]).queued).toBe(1); // and the student can ask for it again
    await queue.idle();
  });

  it('a broken database stops the worker without an unhandled rejection', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'error' }, { write: (s: string) => { lines.push(s); } });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const queue = new AiQueue(db.handle, async () => { db.handle.exec('DROP TABLE ai_jobs'); return {}; }, logger);
      queue.enqueue(ids);
      await queue.idle();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(lines.join('')).toContain('AI queue worker stopped');
  });

  it('after stop() a finishing job writes nothing, so the next start runs it again', async () => {
    const g = gated();
    const queue = new AiQueue(db.handle, g.processor);
    queue.enqueue([ids[0]!]);
    queue.stop();
    await g.next();
    await queue.idle();
    expect(new JobRepository(db.handle).list().active.map((j) => j.status)).toEqual(['running']);
  });
});
