/**
 * "Grabar y transcribir" from the dashboard: runs `batch-transcribe` as a child process (the very same
 * flow as the terminal) and follows it through the progress lines it prints (see ./progress.ts).
 *
 * One run at a time: a capture drives a real browser window and the GPU, and the browser profile can be
 * open in only one process. The child does everything (capture, Whisper, notes, upload to git), so its
 * result is in the database when it ends; this class only keeps what the UI shows while it runs.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { Logger } from 'pino';
import { parseProgressLine, type CaptureStage, type ProgressEvent } from './progress.js';

export interface CaptureCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** What the student chose in the "+" dialog; the server has already checked every field */
export interface LiveCaptureOptions {
  /** Canonical course label */
  course: string;
  /** YYYY-MM-DD of the class, when the student said it */
  date?: string;
  /** Playback speed while recording: 1 or 2 (4x garbles the audio) */
  speed: number;
}

export type ItemState = 'queued' | CaptureStage;

export interface CaptureItem {
  id: number;
  title: string;
  state: ItemState;
  /** Playback progress while recording, 0-100 */
  percent: number | null;
  position: number | null;
  duration: number | null;
  error: string | null;
}

export interface CaptureStatus {
  running: boolean;
  /** A class chosen by the student in the campus ("+"), not from the pending list: it waits for their go-ahead */
  live: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Exit code of the process once it ended; null while it runs or when it was cancelled */
  exitCode: number | null;
  cancelled: boolean;
  items: CaptureItem[];
  /** The last lines the process printed, without colours or progress bars */
  log: string[];
  /** Why the run failed as a whole, when no single class explains it */
  error: string | null;
}

export class CaptureBusyError extends Error {
  constructor() {
    super('Ya hay una captura en marcha: espera a que termine o cancélala.');
  }
}

export interface CaptureRunnerOptions {
  /** The command that captures these recordings (a test seam: the dashboard passes the real one) */
  command: (ids: number[]) => CaptureCommand;
  logger?: Logger;
  onFinish?: (status: CaptureStatus) => void;
}

const MAX_LOG_LINES = 120;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FF}\u{2B50}\u{FE0F}]/gu;

/** End a process and the browser it opened. Windows has no signals to send, so the tree is killed. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // the child leads its own group (detached)
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/** The command that runs this same program again with other arguments: tsx in development, node once built. */
export function selfCommand(args: string[], cwd: string): CaptureCommand {
  return { cmd: process.execPath, args: [...process.execArgv, process.argv[1]!, ...args], cwd };
}

function emptyStatus(): CaptureStatus {
  return { running: false, live: false, startedAt: null, finishedAt: null, exitCode: null, cancelled: false, items: [], log: [], error: null };
}

export class CaptureRunner {
  private state: CaptureStatus = emptyStatus();
  private child: ReturnType<typeof spawn> | null = null;
  /** The stage the live capture was in when ENTER was last pressed */
  private enteredIn: ItemState | null = null;
  private readonly logger?: Logger;

  constructor(private readonly options: CaptureRunnerOptions) {
    this.logger = options.logger?.child({ component: 'capture-runner' });
  }

  get running(): boolean {
    return this.state.running;
  }

  status(): CaptureStatus {
    return { ...this.state, items: this.state.items.map((i) => ({ ...i })), log: [...this.state.log] };
  }

  /**
   * Start capturing these recordings, in this order. With `live`, run that command instead: a class the
   * student picks in the campus. It is interactive, so the process gets a stdin: `enter()` is the ENTER key
   * the terminal flow asks for ("start recording", later "stop and save").
   */
  start(items: { id: number; title: string }[], live?: CaptureCommand): void {
    if (this.state.running) throw new CaptureBusyError();
    this.enteredIn = null;
    this.state = {
      ...emptyStatus(),
      running: true,
      live: !!live,
      startedAt: new Date().toISOString(),
      items: items.map((i) => ({ id: i.id, title: i.title, state: 'queued', percent: null, position: null, duration: null, error: null })),
    };

    let child: ReturnType<typeof spawn>;
    try {
      const command = live ?? this.options.command(items.map((i) => i.id));
      child = spawn(command.cmd, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...command.env, LECTUREVAULT_PROGRESS: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
        stdio: [live ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      this.finish(null, `No se pudo arrancar la captura: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    this.logger?.info({ ids: items.map((i) => i.id) }, 'capture started');

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      let rest = '';
      stream.on('data', (chunk: string) => {
        const parts = (rest + chunk).split(/\r\n|\r|\n/);
        rest = parts.pop() ?? '';
        for (const line of parts) this.line(line);
      });
      stream.on('end', () => { if (rest) this.line(rest); rest = ''; });
    }
    child.on('error', (err) => this.finish(null, `No se pudo arrancar la captura: ${err.message}`));
    child.on('close', (code) => this.finish(code));
    // A write to a process that already left must not take the server down
    child.stdin?.on('error', () => {});
  }

  /**
   * Press ENTER in a live capture: it starts the recording while the process waits for the student, and stops
   * it while it records. False when nothing is waiting for it (no run, not a live one, another stage), and also
   * when the last ENTER has not made the process move on yet: the same key means "start" and "stop", so a double
   * click would start and stop at once.
   */
  enter(): boolean {
    const stdin = this.child?.stdin;
    const item = this.state.items[0];
    if (!this.state.running || !this.state.live || !item || !stdin || stdin.destroyed || !stdin.writable) return false;
    if (item.state !== 'waiting' && item.state !== 'recording') return false;
    if (this.enteredIn === item.state) return false;
    this.enteredIn = item.state;
    stdin.write('\n');
    return true;
  }

  /** Stop the run now (the class being recorded is lost and stays pending). */
  cancel(): boolean {
    if (!this.state.running || !this.child?.pid) return false;
    this.state.cancelled = true;
    killTree(this.child.pid);
    return true;
  }

  /** Forget the result of the last run (the student closed its notice). Never while one is running. */
  clear(): boolean {
    if (this.state.running) return false;
    this.state = emptyStatus();
    return true;
  }

  /** Server shutdown: leave no browser behind. */
  stop(): void {
    this.cancel();
  }

  private line(raw: string): void {
    const event = parseProgressLine(raw);
    if (event) {
      this.apply(event);
      return;
    }
    // No colours and no emojis: the interface does not use them, and the terminal output is full of them
    const text = raw.replace(ANSI, '').replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
    if (!text || /[█░]/.test(text)) return; // the terminal progress bar: the events carry it
    this.state.log.push(text.slice(0, 300));
    if (this.state.log.length > MAX_LOG_LINES) this.state.log.shift();
  }

  private apply(event: ProgressEvent): void {
    const item = this.state.items.find((i) => i.id === event.id); // output is not trusted: only known classes
    if (!item) return;
    if (event.type === 'progress') {
      item.percent = Math.round(event.percent);
      item.position = event.position;
      item.duration = event.duration;
      return;
    }
    item.state = event.stage;
    if (event.stage === 'failed') item.error = event.error ?? 'No se pudo procesar esta clase';
    if (event.stage === 'converting' || event.stage === 'done') item.percent = 100;
  }

  private finish(code: number | null, error?: string): void {
    if (!this.state.running) return;
    const { cancelled } = this.state;
    this.child = null;
    this.state.running = false;
    this.state.finishedAt = new Date().toISOString();
    this.state.exitCode = cancelled ? null : code;

    const lastLine = this.state.log[this.state.log.length - 1];
    for (const item of this.state.items) {
      if (item.state === 'done' || item.state === 'failed') continue;
      item.state = 'failed';
      item.error = cancelled
        ? 'Cancelada: la clase sigue pendiente'
        : code === 0 ? 'No se procesó' : `El proceso terminó antes de acabar esta clase${lastLine ? `: ${lastLine}` : ''}`;
    }
    if (error) this.state.error = error;
    else if (!cancelled && code !== 0) this.state.error = `La captura terminó con un error (código ${code})${lastLine ? `: ${lastLine}` : ''}`;

    this.logger?.info({ code, cancelled, done: this.state.items.filter((i) => i.state === 'done').length }, 'capture finished');
    try {
      this.options.onFinish?.(this.status());
    } catch (err) {
      this.logger?.warn({ err }, 'capture onFinish failed');
    }
  }
}
