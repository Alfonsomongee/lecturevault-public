import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PlaybackWatchdog,
  exitCodeFor,
  isCiRun,
  isProfileBusyFailure,
  pickLatest,
  watchdogLimitsFor,
} from '../../src/campus/daily-guards.js';
import {
  emptyDailyState,
  loadDailyState,
  mergeKnownRows,
  recordHandledRow,
  rowsFromState,
  saveDailyState,
  seedFromRows,
  withEntry,
} from '../../src/campus/daily-state.js';
import { findExistingTranscribedMatch } from '../../src/campus/daily-matcher.js';
import type { RecordingMetadata, RecordingRow } from '../../src/types.js';

const COURSE = '04MUIN Tecnología electrónica e instrumentación';

function candidate(partial: Partial<RecordingMetadata>): RecordingMetadata {
  return {
    collabId: 'hash-1',
    title: 'Sesión 4. Tema 2: Análisis de los Estados Financieros',
    createdAt: '2026-11-04T20:01:00.000Z',
    durationSeconds: 3849,
    playbackUrl: '',
    course: COURSE,
    ...partial,
  } as RecordingMetadata;
}

describe('isProfileBusyFailure', () => {
  it('recognises the Spanish and English Chromium hand-over messages', () => {
    expect(isProfileBusyFailure(new Error('Se está abriendo en una sesión de navegador existente.'))).toBe(true);
    expect(isProfileBusyFailure(new Error('Opening in existing browser session.'))).toBe(true);
    expect(isProfileBusyFailure(new Error('browserType.launchPersistentContext: Target page, context or browser has been closed'))).toBe(true);
  });

  it('reads the Playwright call log too', () => {
    const err = Object.assign(new Error('launch failed'), { log: ['[pid=1][out] Opening in existing browser session.'] });
    expect(isProfileBusyFailure(err)).toBe(true);
  });

  it('does not blame the profile for unrelated failures', () => {
    expect(isProfileBusyFailure(new Error('Executable doesn\'t exist at /usr/bin/chrome'))).toBe(false);
  });
});

describe('isCiRun', () => {
  it('detects GitHub Actions and the explicit flag', () => {
    expect(isCiRun({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiRun({ CI: 'true' })).toBe(true);
    expect(isCiRun({ LECTUREVAULT_CI: '1' })).toBe(true);
    expect(isCiRun({})).toBe(false);
  });
});

describe('PlaybackWatchdog', () => {
  const limits = { stallSeconds: 10, silenceSeconds: 5, maxSeconds: 100 };

  it('lets a moving video run', () => {
    const w = new PlaybackWatchdog(limits);
    for (let t = 1; t <= 50; t++) expect(w.sample({ currentTime: t * 2, hasMedia: true }).ok).toBe(true);
  });

  it('gives up on a video frozen mid-way (the old loop waited for ever)', () => {
    const w = new PlaybackWatchdog(limits);
    for (let t = 1; t <= 5; t++) w.sample({ currentTime: t, hasMedia: true });
    let verdict = w.sample({ currentTime: 5, hasMedia: true });
    for (let i = 0; i < 20 && verdict.ok; i++) verdict = w.sample({ currentTime: 5, hasMedia: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/no avanza/);
  });

  it('gives up when the player stops answering (tab closed)', () => {
    const w = new PlaybackWatchdog(limits);
    w.sample({ currentTime: 1, hasMedia: true });
    let verdict = w.sample(null);
    for (let i = 0; i < 10 && verdict.ok; i++) verdict = w.sample(null);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/dejó de responder/);
  });

  it('enforces an overall limit even if the video keeps moving', () => {
    const w = new PlaybackWatchdog({ ...limits, maxSeconds: 20 });
    let verdict = w.sample({ currentTime: 1, hasMedia: true });
    for (let t = 2; t <= 30 && verdict.ok; t++) verdict = w.sample({ currentTime: t, hasMedia: true });
    expect(verdict.ok).toBe(false);
  });

  it('sizes the limit from the recording duration and the capture speed', () => {
    // 64 min at 2x is ~32 min of capture; the limit is 1.5x that plus 15 min of slack
    expect(watchdogLimitsFor(3849, 2).maxSeconds).toBe(Math.ceil((3849 / 2) * 1.5) + 900);
    // Unknown duration: assume 3 h at most
    expect(watchdogLimitsFor(0, 2).maxSeconds).toBeGreaterThan(3 * 3600);
  });
});

describe('exitCodeFor', () => {
  it('is red only when a class failed', () => {
    expect(exitCodeFor([{ failed: [] }, { failed: [] }])).toBe(0);
    expect(exitCodeFor([{ failed: [] }, { failed: [{}] }])).toBe(1);
  });
});

describe('daily state file', () => {
  it('round-trips and survives a missing or damaged file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-daily-'));
    try {
      expect(loadDailyState(dir)).toEqual(emptyDailyState());
      fs.writeFileSync(path.join(dir, 'daily-state.json'), '{ not json', 'utf8');
      expect(loadDailyState(dir)).toEqual(emptyDailyState());

      const state = withEntry(emptyDailyState(), {
        collabId: 'hash-1',
        course: COURSE,
        title: 'Sesión 4',
        createdAt: '2026-11-04T20:01:00.000Z',
        durationSeconds: 3849,
        transcriptId: 'sesion04',
        handledAt: '2026-11-05T00:10:00.000Z',
      });
      saveDailyState(dir, state);
      expect(loadDailyState(dir).entries).toHaveLength(1);
      expect(loadDailyState(dir).entries[0]!.transcriptId).toBe('sesion04');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('withEntry replaces the same class instead of repeating it', () => {
    const entry = {
      collabId: 'x', course: COURSE, title: 'a', createdAt: '', durationSeconds: 0, transcriptId: null, handledAt: '',
    };
    const state = withEntry(withEntry(emptyDailyState(), entry), { ...entry, title: 'b' });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.title).toBe('b');
  });

  it('a class kept only in the state file is recognised, so a cloud run does not record it again', () => {
    const state = withEntry(emptyDailyState(), {
      collabId: 'old-hash',
      course: COURSE,
      title: 'Class_Collaborate_Sesi_n_4_Tema_2_An_lisis_de_los_Estados_Financieros_Tipos_de_a',
      createdAt: '2026-11-04T20:01:00.000Z',
      durationSeconds: 3849,
      transcriptId: 'Class_Collaborate_Sesi_n_4_Tema_2_An_lisis_de_los_Estados_Financieros_Tipos_de_a',
      handledAt: '2026-11-05T00:10:00.000Z',
    });
    const known = mergeKnownRows([], state);
    expect(findExistingTranscribedMatch(candidate({ collabId: 'a-different-hash' }), COURSE, known)).toBeDefined();
    // another course is not confused with it
    expect(findExistingTranscribedMatch(candidate({ collabId: 'z' }), '01MUIN Gestión', known)).toBeUndefined();
    // and a genuinely new session is still new
    expect(
      findExistingTranscribedMatch(
        candidate({ collabId: 'n', title: 'Sesión 5. Tema 3: Otra cosa distinta', createdAt: '2026-11-11T20:01:00.000Z', durationSeconds: 5000 }),
        COURSE,
        known
      )
    ).toBeUndefined();
  });

  it('seeds from database rows that are transcribed or ignored, once', () => {
    const rows = [
      { collab_id: 'local:a', course: COURSE, title: 'A', created_at: '2026-11-01T10:00:00.000Z', duration_seconds: 10, transcript_id: 'a', ignored_at: null },
      { collab_id: 'b', course: COURSE, title: 'B', created_at: '2026-11-02T10:00:00.000Z', duration_seconds: 10, transcript_id: null, ignored_at: '2026-11-03' },
      { collab_id: 'c', course: COURSE, title: 'C (pendiente)', created_at: '2026-11-03T10:00:00.000Z', duration_seconds: 10, transcript_id: null, ignored_at: null },
      { collab_id: 'd', course: '', title: 'D sin asignatura', created_at: '2026-11-04T10:00:00.000Z', duration_seconds: 10, transcript_id: 'd', ignored_at: null },
    ] as unknown as RecordingRow[];
    const once = seedFromRows(emptyDailyState(), rows);
    expect(once.entries.map((e) => e.collabId).sort()).toEqual(['b', 'local:a']);
    expect(seedFromRows(once, rows).entries).toHaveLength(2);
    expect(rowsFromState(once).every((r) => r.status === 'processed')).toBe(true);
  });

  it('mergeKnownRows lets the database win over the file for the same class', () => {
    const db = [{ collab_id: 'same', title: 'from db', course: COURSE }] as unknown as RecordingRow[];
    const state = withEntry(emptyDailyState(), {
      collabId: 'same', course: COURSE, title: 'from file', createdAt: '', durationSeconds: 0, transcriptId: null, handledAt: '',
    });
    const merged = mergeKnownRows(db, state);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe('from db');
  });

  it('recordHandledRow remembers a class however it was recorded, once, and ignores rows without a subject', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-daily-'));
    try {
      const row = {
        collab_id: 'local:sesion04_04MUIN', course: COURSE, title: 'sesion04 04MUIN',
        created_at: '2026-11-05T10:00:00.000Z', duration_seconds: 3849, transcript_id: 'sesion04_04MUIN', ignored_at: null,
      } as unknown as RecordingRow;
      expect(recordHandledRow(dir, row)).toBe(true);
      expect(recordHandledRow(dir, row)).toBe(false); // already there: file untouched
      expect(loadDailyState(dir).entries.map((e) => e.transcriptId)).toEqual(['sesion04_04MUIN']);
      expect(recordHandledRow(dir, { ...row, collab_id: 'x', course: '' } as RecordingRow)).toBe(false);
      expect(recordHandledRow(dir, { ...row, collab_id: 'y', transcript_id: null } as RecordingRow)).toBe(false);
      expect(loadDailyState(dir).entries).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pickLatest', () => {
  it('keeps only the newest class, whatever the order', () => {
    const items = [
      { meta: { createdAt: '2026-10-27T19:00:00.000Z' } },
      { meta: { createdAt: '2026-11-05T20:04:00.000Z' } },
      { meta: { createdAt: '2026-11-03T19:00:00.000Z' } },
    ];
    expect(pickLatest(items)).toEqual([items[1]]);
    expect(pickLatest([])).toEqual([]);
    expect(pickLatest([items[0]!])).toEqual([items[0]]);
  });
});
