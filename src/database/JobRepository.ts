import type Database from 'better-sqlite3';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRow {
  id: number;
  recording_id: number;
  force: number;
  /** Comma-separated pipeline steps, or null for all of them */
  steps: string | null;
  /** Times the worker took this job (a normal run is 1; more means it was cut by a restart) */
  attempts: number;
  status: JobStatus;
  report_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** A job as the UI sees it: with the class title and the parsed report. */
export interface JobView extends Omit<JobRow, 'report_json'> {
  title: string;
  course: string;
  report: unknown;
}

/** A job cut this many times (restarts, crashes, out of memory) is given up instead of queued again */
export const MAX_JOB_ATTEMPTS = 3;

/**
 * The "Generar con IA" queue (ai_jobs). A class has at most one queued or running job (unique partial
 * index), so asking twice never processes it twice.
 */
export class JobRepository {
  constructor(private readonly db: Database.Database) {}

  /** Queue classes in order; the ones already waiting or running are left as they are. */
  enqueue(recordingIds: number[], force = false, steps?: string[]): { queued: JobRow[]; already: number[] } {
    const insert = this.db.prepare('INSERT OR IGNORE INTO ai_jobs (recording_id, force, steps) VALUES (?, ?, ?)');
    const queued: JobRow[] = [];
    const already: number[] = [];
    this.db.transaction(() => {
      for (const id of recordingIds) {
        const { changes, lastInsertRowid } = insert.run(id, force ? 1 : 0, steps?.length ? steps.join(',') : null);
        if (changes) queued.push(this.get(Number(lastInsertRowid))!);
        else already.push(id);
      }
    })();
    return { queued, already };
  }

  get(id: number): JobRow | undefined {
    return this.db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  /** Oldest queued job, marked as running in the same statement so two pumps never take it. */
  claimNext(): JobRow | undefined {
    return this.db
      .prepare(
        `UPDATE ai_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
         WHERE id = (SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
         RETURNING *`
      )
      .get() as JobRow | undefined;
  }

  finish(id: number, outcome: { report?: unknown; error?: string }): void {
    this.db
      .prepare(
        `UPDATE ai_jobs SET status = ?, report_json = ?, error = ?, finished_at = datetime('now')
         WHERE id = ? AND status = 'running'`
      )
      .run(outcome.error ? 'failed' : 'done', outcome.report === undefined ? null : JSON.stringify(outcome.report), outcome.error ?? null, id);
  }

  /** Cancel what has not started; the running job always finishes. */
  cancelQueued(id?: number): number {
    const where = id === undefined ? '' : ' AND id = ?';
    const stmt = this.db.prepare(`UPDATE ai_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE status = 'queued'${where}`);
    return (id === undefined ? stmt.run() : stmt.run(id)).changes;
  }

  /**
   * A job left running by a stopped server goes back to the queue, unless it has already been cut
   * `maxAttempts` times: then it fails with an explanation, so a class that takes the server down
   * does not take it down on every start.
   */
  requeueRunning(maxAttempts = MAX_JOB_ATTEMPTS): { requeued: number; abandoned: number } {
    return this.db.transaction(() => {
      const abandoned = this.db
        .prepare(
          `UPDATE ai_jobs SET status = 'failed', finished_at = datetime('now'),
                  error = 'Se interrumpió ' || attempts || ' veces seguidas (¿el servidor se cerró o se quedó sin memoria?). Vuelve a lanzarla desde la clase.'
           WHERE status = 'running' AND attempts >= ?`
        )
        .run(maxAttempts).changes;
      const requeued = this.db.prepare("UPDATE ai_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes;
      return { requeued, abandoned };
    })();
  }

  /** Queued and running jobs in queue order, plus the ones that finished since `sinceId`. */
  list(sinceId = 0, recentLimit = 30): { active: JobView[]; finished: JobView[] } {
    const view = (rows: (JobRow & { title: string; course: string })[]): JobView[] =>
      rows.map(({ report_json, ...r }) => ({ ...r, report: report_json ? JSON.parse(report_json) : null }));
    const select = `SELECT j.*, COALESCE(r.display_title, r.title) AS title, r.course FROM ai_jobs j JOIN recordings r ON r.id = j.recording_id`;
    return {
      active: view(this.db.prepare(`${select} WHERE j.status IN ('queued','running') ORDER BY j.id`).all() as never),
      finished: view(
        this.db
          .prepare(`${select} WHERE j.status IN ('done','failed','cancelled') AND j.id >= ? ORDER BY j.id DESC LIMIT ?`)
          .all(sinceId, recentLimit) as never
      ),
    };
  }

  /** Lowest id still waiting or running: where the current batch started when nothing older is pending. */
  firstActiveId(): number | null {
    return (this.db.prepare("SELECT min(id) AS id FROM ai_jobs WHERE status IN ('queued','running')").get() as { id: number | null }).id;
  }

  /** How many jobs of a batch (id ≥ start) exist and how many already finished; cancelled ones do not count. */
  progress(startId: number): { done: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total, sum(status IN ('done','failed')) AS done
         FROM ai_jobs WHERE id >= ? AND status != 'cancelled'`
      )
      .get(startId) as { total: number; done: number | null };
    return { done: row.done ?? 0, total: row.total };
  }
}
