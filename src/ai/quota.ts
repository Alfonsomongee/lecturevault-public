/**
 * Living within Gemini's free quota (pure, testable).
 *
 * The free tier limits requests per minute and per day. A 429 for the per-minute limit says how long to wait
 * (RetryInfo.retryDelay); the client used to retry after 1.5, 3 and 6 s, gave up long before that, and fell
 * back to DeepSeek, which is paid. Now it waits what Gemini asks, gives up at once on the daily limit (no wait
 * helps), and paces requests so the per-minute limit is rarely hit at all.
 */

export type QuotaWait = { kind: 'minute'; ms: number } | { kind: 'day' };

const DEFAULT_MINUTE_WAIT_MS = 60_000;

/** What a failed response means for the quota: wait `ms` (per-minute limit), stop (daily limit), or null (not quota). */
export function quotaWait(status: number, body: string, retryAfter?: string | null): QuotaWait | null {
  if (status !== 429) return null;
  let details: { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] = [];
  try {
    const parsed = JSON.parse(body) as { error?: { details?: typeof details } };
    details = Array.isArray(parsed?.error?.details) ? parsed.error!.details! : [];
  } catch {
    /* not JSON: fall back to the header */
  }
  const daily = details.some((d) => d.violations?.some((v) => /PerDay/i.test(v.quotaId ?? '')));
  if (daily) return { kind: 'day' };
  const delay = details.find((d) => /RetryInfo$/.test(d['@type'] ?? ''))?.retryDelay;
  const seconds = delay ? Number.parseFloat(delay) : retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
  return { kind: 'minute', ms: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_MINUTE_WAIT_MS };
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** At most `perMinute` requests in any 60 s window (0 = no limit), and a pause the server can ask for. */
export class RateGate {
  private readonly stamps: number[] = [];
  private resumeAt = 0;

  constructor(private readonly perMinute: number, private readonly clock: Clock = realClock) {}

  /** Waits until a request may go out, then counts it. */
  async take(): Promise<void> {
    const pause = this.resumeAt - this.clock.now();
    if (pause > 0) await this.clock.sleep(pause);
    if (this.perMinute <= 0) return;
    for (;;) {
      const now = this.clock.now();
      while (this.stamps.length && now - this.stamps[0]! >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await this.clock.sleep(60_000 - (now - this.stamps[0]!));
    }
  }

  /** No request before `ms` from now (a 429 said so). */
  pause(ms: number): void {
    this.resumeAt = Math.max(this.resumeAt, this.clock.now() + ms);
  }
}
