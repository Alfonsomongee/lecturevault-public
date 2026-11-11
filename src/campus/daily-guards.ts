/**
 * Small pure guards for the daily agent: they turn two situations that used to end in a cryptic crash
 * or an endless wait into clear, testable outcomes.
 */

/** Exit code for "try again later" (EX_TEMPFAIL): the profile was busy, nothing was lost. */
export const EXIT_PROFILE_BUSY = 75;

export class ProfileBusyError extends Error {
  constructor(detail?: string) {
    super(
      'El perfil del navegador está en uso: hay otra ventana de Chromium abierta con él (por ejemplo una captura ' +
        'lanzada desde el panel o un «npm run sync»). Espera a que termine, o ciérrala, y vuelve a intentarlo.' +
        (detail ? ` (${detail})` : '')
    );
    this.name = 'ProfileBusyError';
  }
}

/**
 * Chromium hands a second launch over to the first one that owns the profile and exits at once, which
 * Playwright reports as a closed browser. Recognise that, so the caller can say what really happened.
 */
export function isProfileBusyFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}\n${(err as { log?: string[] }).log?.join('\n') ?? ''}` : String(err);
  return (
    /sesi[oó]n de navegador existente/i.test(text) ||
    /opening in (an )?existing browser session/i.test(text) ||
    /ProcessSingleton|profile (is )?(already )?in use/i.test(text) ||
    /Target page, context or browser has been closed/i.test(text)
  );
}

/** True when running inside GitHub Actions (or any CI that sets CI=true). */
export function isCiRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['GITHUB_ACTIONS'] === 'true' || env['CI'] === 'true' || env['LECTUREVAULT_CI'] === '1';
}

export interface PlaybackSample {
  /** Seconds of the recording played so far */
  currentTime: number;
  /** The player answered with a media element at all */
  hasMedia: boolean;
}

export interface WatchdogLimits {
  /** Give up when the playback position has not moved for this long (wall-clock seconds) */
  stallSeconds: number;
  /** Give up when the player does not answer for this long */
  silenceSeconds: number;
  /** Give up when the whole capture takes longer than this */
  maxSeconds: number;
}

export type WatchdogVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Feed it one sample per second. It never waits forever: a frozen video, a closed tab or a player that
 * stopped answering all end in a verdict instead of an endless loop.
 */
export class PlaybackWatchdog {
  private elapsed = 0;
  private lastPosition = -1;
  private lastMoveAt = 0;
  private lastSeenAt = 0;

  constructor(private readonly limits: WatchdogLimits) {}

  /** `dt` is the wall-clock seconds since the previous sample. */
  sample(sample: PlaybackSample | null, dt = 1): WatchdogVerdict {
    this.elapsed += dt;
    if (this.elapsed > this.limits.maxSeconds) {
      return { ok: false, reason: `la captura superó el límite de ${Math.round(this.limits.maxSeconds / 60)} min` };
    }
    if (!sample || !sample.hasMedia) {
      if (this.elapsed - this.lastSeenAt > this.limits.silenceSeconds) {
        return { ok: false, reason: `el reproductor dejó de responder durante ${this.limits.silenceSeconds} s (¿se cerró la pestaña?)` };
      }
      return { ok: true };
    }
    this.lastSeenAt = this.elapsed;
    if (sample.currentTime > this.lastPosition + 0.05) {
      this.lastPosition = sample.currentTime;
      this.lastMoveAt = this.elapsed;
    } else if (this.elapsed - this.lastMoveAt > this.limits.stallSeconds) {
      return { ok: false, reason: `el vídeo no avanza desde hace ${this.limits.stallSeconds} s (posición ${Math.round(sample.currentTime)} s)` };
    }
    return { ok: true };
  }
}

/** Generous but finite limits for a recording of `durationSeconds` captured at `speed`. */
export function watchdogLimitsFor(durationSeconds: number, speed: number): WatchdogLimits {
  const expected = durationSeconds > 0 ? durationSeconds / Math.max(speed, 0.25) : 3 * 3600;
  return {
    stallSeconds: 180,
    silenceSeconds: 90,
    maxSeconds: Math.ceil(expected * 1.5) + 15 * 60,
  };
}

/**
 * Wall-clock minutes a class needs from "press play" to "pushed": the recording itself (duration / speed), the
 * CPU transcription and the notes (measured: ~0.35 x duration on the free runner) and some slack.
 */
export function estimateClassMinutes(durationSeconds: number, speed: number): number {
  const minutes = (durationSeconds > 0 ? durationSeconds : 2 * 3600) / 60;
  return Math.ceil(minutes / Math.max(speed, 0.25) + minutes * 0.35 + 5);
}

/**
 * Time budget of one run. A class that cannot finish inside it is left for the next night instead of being
 * started and cut halfway (which wasted the whole recording: the job timeout killed it before it was saved).
 */
export class RunBudget {
  constructor(
    private readonly totalMinutes: number,
    private readonly now: () => number = Date.now,
    private readonly startedAt: number = now()
  ) {}

  remainingMinutes(): number {
    return this.totalMinutes - (this.now() - this.startedAt) / 60000;
  }

  /** `ok` when a class of this length fits in what is left; otherwise says how much it needs. */
  check(durationSeconds: number, speed: number): { ok: true } | { ok: false; needed: number; remaining: number } {
    const needed = estimateClassMinutes(durationSeconds, speed);
    const remaining = Math.floor(this.remainingMinutes());
    return needed <= remaining ? { ok: true } : { ok: false, needed, remaining };
  }
}

/** Minutes of budget from `DAILY_BUDGET_MINUTES`; `null` (no limit) when unset or invalid, e.g. on the student's PC. */
export function budgetMinutesFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env['DAILY_BUDGET_MINUTES']);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Exit code for a finished run: 0 when nothing failed, 1 otherwise. */
export function exitCodeFor(summaries: { failed: unknown[] }[]): number {
  return summaries.some((s) => s.failed.length > 0) ? 1 : 0;
}

/** The most recent item by `createdAt` (ISO strings). Used by `--latest` to test the cloud with a single class. */
export function pickLatest<T extends { meta: { createdAt: string } }>(items: T[]): T[] {
  if (items.length <= 1) return items;
  return [items.reduce((best, it) => (it.meta.createdAt > best.meta.createdAt ? it : best))];
}
