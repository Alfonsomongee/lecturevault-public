import { describe, it, expect } from 'vitest';
import { CaptureRunner, CaptureBusyError, type CaptureStatus } from '../../src/capture/CaptureRunner.js';
import { parseProgressLine, progressLine, PROGRESS_PREFIX, LIVE_CAPTURE_ID } from '../../src/capture/progress.js';

describe('progress lines', () => {
  it('round-trips a stage and a progress event', () => {
    expect(parseProgressLine(progressLine({ type: 'stage', id: 7, stage: 'recording' }))).toEqual({ type: 'stage', id: 7, stage: 'recording' });
    expect(parseProgressLine(progressLine({ type: 'progress', id: 7, percent: 40, position: 12, duration: 30 })))
      .toEqual({ type: 'progress', id: 7, percent: 40, position: 12, duration: 30 });
  });

  it('finds the event after a half-drawn terminal progress bar', () => {
    const line = `  [██░░░░] 12% | 01:00 / 05:00   ${progressLine({ type: 'stage', id: 3, stage: 'transcribing' })}`;
    expect(parseProgressLine(line)).toEqual({ type: 'stage', id: 3, stage: 'transcribing' });
  });

  it('knows the stage a live capture waits in', () => {
    expect(parseProgressLine(progressLine({ type: 'stage', id: LIVE_CAPTURE_ID, stage: 'waiting' }))).toEqual({ type: 'stage', id: 0, stage: 'waiting' });
  });

  it('ignores ordinary output and anything malformed', () => {
    expect(parseProgressLine('🚀 Transcribiendo con faster-whisper')).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}{not json`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}${JSON.stringify({ type: 'stage', id: 1, stage: 'hacking' })}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}${JSON.stringify({ type: 'stage', id: '1', stage: 'done' })}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}${JSON.stringify({ type: 'progress', id: 1, percent: 'a', position: 0, duration: 0 })}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}null`)).toBeNull();
  });

  it('keeps percent inside 0-100 and caps the error text', () => {
    expect(parseProgressLine(progressLine({ type: 'progress', id: 1, percent: 250, position: 1, duration: 2 }))).toMatchObject({ percent: 100 });
    const long = parseProgressLine(progressLine({ type: 'stage', id: 1, stage: 'failed', error: 'x'.repeat(2000) }));
    expect(long && long.type === 'stage' && long.error?.length).toBe(500);
  });
});

const PRELUDE = `const P=${JSON.stringify(PROGRESS_PREFIX)};const ev=(o)=>process.stdout.write('\\n'+P+JSON.stringify(o)+'\\n');`;

/** A runner whose "capture" is a small node script, and a promise for the moment it ends. */
function fake(script: string) {
  let resolve!: (s: CaptureStatus) => void;
  const done = new Promise<CaptureStatus>((r) => { resolve = r; });
  const runner = new CaptureRunner({
    command: () => ({ cmd: process.execPath, args: ['-e', PRELUDE + script], cwd: process.cwd() }),
    onFinish: resolve,
  });
  return { runner, done };
}

const items = [{ id: 1, title: 'Clase 1' }, { id: 2, title: 'Clase 2' }];

describe('CaptureRunner', () => {
  it('follows the process through its progress lines', async () => {
    const { runner, done } = fake(`
      console.log('\\u001b[32mINFO\\u001b[0m \\u{1F680} abriendo el navegador, PROGRESS=' + process.env.LECTUREVAULT_PROGRESS);
      ev({type:'stage',id:1,stage:'opening'});
      process.stdout.write('\\r[███░░░] 45% | 00:10 / 00:20');
      ev({type:'progress',id:1,percent:45.4,position:10,duration:20});
      ev({type:'stage',id:999,stage:'done'});
      ev({type:'stage',id:1,stage:'done'});
      ev({type:'stage',id:2,stage:'done'});
    `);
    runner.start(items);
    expect(runner.running).toBe(true);
    const status = await done;

    expect(status).toMatchObject({ running: false, exitCode: 0, cancelled: false, error: null });
    expect(status.items.map((i) => i.state)).toEqual(['done', 'done']);
    expect(status.items[0]).toMatchObject({ percent: 100, position: 10, duration: 20 });
    // plain text only: no colours, emojis, progress bar or machine lines; and the child was told to report
    expect(status.log).toEqual(['INFO abriendo el navegador, PROGRESS=1']);
    expect(runner.running).toBe(false);
  });

  it("marks a class that failed with the process's own explanation", async () => {
    const { runner, done } = fake(`
      ev({type:'stage',id:1,stage:'failed',error:'No se detectó elemento de audio/vídeo'});
      ev({type:'stage',id:2,stage:'done'});
    `);
    runner.start(items);
    const status = await done;
    expect(status.items[0]).toMatchObject({ state: 'failed', error: 'No se detectó elemento de audio/vídeo' });
    expect(status.items[1]!.state).toBe('done');
    expect(status.error).toBeNull();
  });

  it('fails what was left when the process dies, saying what it printed last', async () => {
    const { runner, done } = fake(`
      ev({type:'stage',id:1,stage:'done'});
      console.log('Python virtual environment not found');
      process.exit(3);
    `);
    runner.start(items);
    const status = await done;
    expect(status.exitCode).toBe(3);
    expect(status.items[0]!.state).toBe('done');
    expect(status.items[1]).toMatchObject({ state: 'failed' });
    expect(status.items[1]!.error).toContain('Python virtual environment not found');
    expect(status.error).toContain('código 3');
  });

  it('runs one capture at a time', async () => {
    const { runner, done } = fake(`setTimeout(()=>{}, 300);`);
    runner.start(items);
    expect(() => runner.start(items)).toThrow(CaptureBusyError);
    await done;
    expect(() => runner.start(items)).not.toThrow();
    runner.cancel();
  });

  it('cancels the process and leaves the classes pending', async () => {
    const { runner, done } = fake(`ev({type:'stage',id:1,stage:'recording'}); setInterval(()=>{}, 1000);`);
    runner.start(items);
    await new Promise((r) => setTimeout(r, 700));
    expect(runner.status().items[0]!.state).toBe('recording');

    expect(runner.cancel()).toBe(true);
    const status = await done;
    expect(status).toMatchObject({ running: false, cancelled: true, exitCode: null });
    expect(status.items.every((i) => i.state === 'failed' && i.error!.startsWith('Cancelada'))).toBe(true);
    expect(runner.cancel()).toBe(false);
  });

  it('forgets a finished run when asked, but never one in progress', async () => {
    const { runner, done } = fake(`setTimeout(()=>{}, 300);`);
    runner.start(items);
    expect(runner.clear()).toBe(false);
    expect(runner.status().items).toHaveLength(2);
    await done;
    expect(runner.clear()).toBe(true);
    expect(runner.status()).toMatchObject({ running: false, items: [], log: [], finishedAt: null });
  });

  it('reports a command that cannot start', async () => {
    let resolve!: (s: CaptureStatus) => void;
    const done = new Promise<CaptureStatus>((r) => { resolve = r; });
    const runner = new CaptureRunner({
      command: () => ({ cmd: 'definitely-not-a-program-lv', args: [], cwd: process.cwd() }),
      onFinish: resolve,
    });
    runner.start(items);
    const status = await done;
    expect(status.error).toContain('No se pudo arrancar');
    expect(status.items.every((i) => i.state === 'failed')).toBe(true);
  });

  it('keeps only the last lines of output', async () => {
    const { runner, done } = fake(`for (let i = 0; i < 300; i++) console.log('linea ' + i);`);
    runner.start(items);
    const status = await done;
    expect(status.log.length).toBe(120);
    expect(status.log[119]).toBe('linea 299');
  });
});

describe('live capture (the "+" button)', () => {
  const STEPS = `let n=0; ev({type:'stage',id:0,stage:'waiting'}); process.stdin.on('data',()=>{n++; if(n===1) ev({type:'stage',id:0,stage:'recording'}); else {ev({type:'stage',id:0,stage:'done'}); process.exit(0);}});`;

  function live(script: string) {
    let resolve!: (s: CaptureStatus) => void;
    const done = new Promise<CaptureStatus>((r) => { resolve = r; });
    const runner = new CaptureRunner({
      command: () => { throw new Error('a live capture runs its own command, not the batch one'); },
      onFinish: resolve,
    });
    return { runner, done, command: { cmd: process.execPath, args: ['-e', PRELUDE + script], cwd: process.cwd() } };
  }
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('the condition never held');
  };

  it('takes ENTER to start and again to stop, and never twice in a row', async () => {
    const { runner, done, command } = live(STEPS);
    runner.start([{ id: LIVE_CAPTURE_ID, title: 'Clase nueva · 01MUIN' }], command);
    expect(runner.status().live).toBe(true);
    expect(runner.enter()).toBe(false); // it is not waiting yet

    await until(() => runner.status().items[0]!.state === 'waiting');
    expect(runner.enter()).toBe(true); // "Empezar a grabar"
    // a double click would start and stop at once: the second press waits until the process moved on
    expect(runner.enter()).toBe(false);

    await until(() => runner.status().items[0]!.state === 'recording');
    expect(runner.enter()).toBe(true); // "Parar y guardar"
    expect(runner.enter()).toBe(false);

    const status = await done;
    expect(status).toMatchObject({ live: true, exitCode: 0, error: null });
    expect(status.items[0]!.state).toBe('done');
    expect(runner.enter()).toBe(false); // nothing left running
  });

  it('refuses ENTER when nothing runs, and for a batch capture, which has no keyboard', async () => {
    const idle = new CaptureRunner({ command: () => ({ cmd: process.execPath, args: ['-e', ''], cwd: process.cwd() }) });
    expect(idle.enter()).toBe(false);

    const { runner, done } = fake(`setTimeout(()=>{}, 300);`);
    runner.start(items);
    expect(runner.status().live).toBe(false);
    expect(runner.enter()).toBe(false);
    await done;
  });

  it('cancelling a live capture ends it like any other', async () => {
    const { runner, done, command } = live(STEPS);
    runner.start([{ id: LIVE_CAPTURE_ID, title: 'Clase nueva' }], command);
    await until(() => runner.status().items[0]!.state === 'waiting');
    expect(runner.cancel()).toBe(true);
    const status = await done;
    expect(status).toMatchObject({ cancelled: true, live: true });
    expect(status.items[0]!.error).toContain('Cancelada');
  });
});
