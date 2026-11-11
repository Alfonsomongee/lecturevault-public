import type { Logger } from 'pino';
import { JobRepository, type JobView } from '../database/JobRepository.js';
import type Database from 'better-sqlite3';

/** Runs one class through the pipeline; returns its report (what the UI shows when it ends). */
export type JobProcessor = (recordingId: number, options: { force: boolean; steps?: string[] }) => Promise<unknown>;

export interface QueueStatus {
  active: JobView[];
  /** Jobs that ended since `since` (newest first), so the UI can say how each one went */
  finished: JobView[];
  /** Progress of the current run: from the first job queued while the queue was empty */
  batch: { done: number; total: number } | null;
}

/**
 * Background "Generar con IA": jobs live in SQLite (they survive a restart) and one worker in the
 * server process takes them one at a time, so the UI never waits on a Gemini call and can be left.
 */
export class AiQueue {
  private readonly jobs: JobRepository;
  private running: Promise<void> | null = null;
  private stopped = false;
  private batchStart: number | null = null;

  constructor(
    db: Database.Database,
    private readonly processor: JobProcessor,
    private readonly logger?: Logger
  ) {
    this.jobs = new JobRepository(db);
  }

  /** On start: a job cut by a restart is queued again and the worker picks up where it was. */
  resume(): void {
    const { requeued, abandoned } = this.jobs.requeueRunning();
    if (requeued) this.logger?.info({ requeued }, 'AI jobs requeued after restart');
    if (abandoned) this.logger?.warn({ abandoned }, 'AI jobs given up: they were cut too many times');
    this.batchStart = this.jobs.firstActiveId();
    this.pump();
  }

  /** `steps` limits the run to some pipeline steps (null = all of them) */
  enqueue(recordingIds: number[], force = false, steps?: string[]): { queued: number; already: number[] } {
    const wasIdle = this.jobs.firstActiveId() === null;
    const { queued, already } = this.jobs.enqueue(recordingIds, force, steps);
    if (wasIdle && queued.length) this.batchStart = queued[0]!.id;
    this.pump();
    return { queued: queued.length, already };
  }

  cancel(id?: number): number {
    return this.jobs.cancelQueued(id);
  }

  status(since = 0): QueueStatus {
    const { active, finished } = this.jobs.list(since);
    return { active, finished, batch: active.length && this.batchStart !== null ? this.jobs.progress(this.batchStart) : null };
  }

  /** Resolves when the worker has nothing left to do (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Stop taking new jobs without waiting for a Gemini call (Ctrl+C must not hang): a job cut here stays
   * 'running' and resume() queues it again on the next start.
   */
  stop(): void {
    this.stopped = true;
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    // An unexpected failure (a closed or broken database) must never become an unhandled rejection:
    // that would take the whole server down. The worker stops; the next enqueue starts it again.
    this.running = this.work()
      .catch((err) => { this.logger?.error({ err: (err as Error).message }, 'AI queue worker stopped'); })
      .finally(() => { this.running = null; });
  }

  private async work(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const job = this.jobs.claimNext();
      if (!job) return;
      let outcome: { report?: unknown; error?: string };
      try {
        outcome = { report: await this.processor(job.recording_id, { force: job.force === 1, ...(job.steps ? { steps: job.steps.split(',') } : {}) }) };
      } catch (err) {
        outcome = { error: (err as Error).message || 'Error desconocido' };
        this.logger?.warn({ err: outcome.error, recordingId: job.recording_id }, 'AI job failed');
      }
      if (this.stopped) return; // the database may be closed already: resume() requeues it
      try {
        this.jobs.finish(job.id, outcome);
      } catch (err) {
        // Could not record the result: leave it 'running' (resume() deals with it) and keep serving the rest
        this.logger?.error({ err: (err as Error).message, recordingId: job.recording_id }, 'AI job result could not be saved');
      }
    }
  }
}
