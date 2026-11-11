import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveToTrash, purgeTrash, trashDir, TRASH_DAYS } from '../../src/utils/trash.js';

describe('trash', () => {
  let data: string;

  const write = (rel: string, content = 'x') => {
    const file = path.join(data, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-trash-')); });
  afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

  it('moves files and folders keeping their layout, so putting them back is a move', () => {
    const audio = write('audio/clase1.wav', 'RIFF');
    write('transcripts/clase1/clase1.json', '{}');

    const folder = moveToTrash(data, 'clase1', [
      { from: audio, to: 'audio/clase1.wav' },
      { from: path.join(data, 'transcripts', 'clase1'), to: 'transcripts/clase1' },
    ], new Date('2026-11-04T09:15:00Z'))!;

    expect(path.basename(folder)).toBe('20261104-091500-clase1');
    expect(fs.readFileSync(path.join(folder, 'audio', 'clase1.wav'), 'utf8')).toBe('RIFF');
    expect(fs.existsSync(path.join(folder, 'transcripts', 'clase1', 'clase1.json'))).toBe(true);
    expect(fs.existsSync(audio)).toBe(false);
    expect(fs.existsSync(path.join(data, 'transcripts', 'clase1'))).toBe(false);
  });

  it('does nothing, and creates nothing, when there is nothing to move', () => {
    expect(moveToTrash(data, 'clase1', [{ from: path.join(data, 'audio', 'no-existe.wav'), to: 'audio/no-existe.wav' }])).toBeNull();
    expect(fs.existsSync(trashDir(data))).toBe(false);
  });

  it('refuses a destination that would leave the trash folder', () => {
    const file = write('audio/clase1.wav');
    expect(() => moveToTrash(data, 'clase1', [{ from: file, to: '../../fuera.wav' }])).toThrow(/no válido/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps the label harmless in the folder name', () => {
    const file = write('audio/a.wav');
    const folder = moveToTrash(data, '../../etc/pass wd', [{ from: file, to: 'audio/a.wav' }])!;
    expect(path.dirname(folder)).toBe(trashDir(data));
  });

  it('empties only the folders it made, and only after TRASH_DAYS', () => {
    const day = 24 * 60 * 60 * 1000;
    const made = new Date('2026-11-04T09:15:00Z');
    const old = moveToTrash(data, 'vieja', [{ from: write('audio/v.wav'), to: 'audio/v.wav' }], made)!;
    const recent = moveToTrash(data, 'reciente', [{ from: write('audio/r.wav'), to: 'audio/r.wav' }], made)!;
    const mine = path.join(trashDir(data), 'algo-que-puse-yo');
    fs.mkdirSync(mine);

    fs.utimesSync(old, new Date(made.getTime() - (TRASH_DAYS + 1) * day), new Date(made.getTime() - (TRASH_DAYS + 1) * day));
    fs.utimesSync(mine, new Date(0), new Date(0)); // ancient, but not ours

    expect(purgeTrash(data, made)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(mine)).toBe(true);
    expect(purgeTrash(path.join(data, 'sin-papelera'), made)).toBe(0);
  });
});
