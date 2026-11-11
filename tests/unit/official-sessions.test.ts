import { describe, expect, it } from 'vitest';
import { madridDay, officialTopicLabel, parseOfficialTitle, planOfficialUpdates, type OfficialRow } from '../../src/campus/official-sessions.js';
import { withOfficial, emptyDailyState, type DailyStateEntry } from '../../src/campus/daily-state.js';
import { findSyllabusBlock } from '../../src/campus/analysis.js';

// Titles exactly as the VIU campus listed them on 2026-11-07 (run 42328400545)
describe('parseOfficialTitle', () => {
  it('reads session, part and topic from the campus titles', () => {
    expect(parseOfficialTitle('SESION 1: Turoria Inicial / VC Tema 1: Marco Jurídico de la Empresa./recording_1')).toEqual({
      session: 1, part: 1, topicNumber: 1, topicName: 'Marco Jurídico de la Empresa',
    });
    expect(parseOfficialTitle('Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales/recording_1')).toEqual({
      session: 3, part: 1, topicNumber: 2, topicName: 'Contabilidad Financiera',
    });
    expect(parseOfficialTitle('Sesión 01. Tutoría Colectiva. Presentación y Hoja de Ruta de la Asignatura. Tema 2 : Análisis cinemático. Mecanismos/recording_1')).toEqual({
      session: 1, part: 1, topicNumber: 2, topicName: 'Análisis cinemático',
    });
    expect(parseOfficialTitle('Sesión 03. Tema 2,3. Análisis Dinámico y Determinación de Cargas en Uniones./recording_1')).toEqual({
      session: 3, part: 1, topicNumber: 2, topicName: 'Análisis Dinámico y Determinación de Cargas en Uniones',
    });
    expect(parseOfficialTitle('Sesión 02. Tema 2. Cuantificación del Movimiento: Velocidades y Aceleraciones./recording_1')).toEqual({
      session: 2, part: 1, topicNumber: 2, topicName: 'Cuantificación del Movimiento: Velocidades y Aceleraciones',
    });
  });

  it('leaves the topic empty when the campus does not give one', () => {
    expect(parseOfficialTitle('Sesión 4: 04MUIN/recording_2')).toEqual({ session: 4, part: 2, topicNumber: null, topicName: null });
    expect(parseOfficialTitle('Tutoría de dudas')).toEqual({ session: null, part: null, topicNumber: null, topicName: null });
  });
});

describe('officialTopicLabel', () => {
  const syllabus = [
    { n: 1, title: 'Marco jurídico' },
    { n: 2, title: 'Contabilidad financiera' },
  ];
  it('uses the syllabus name of the block the campus names', () => {
    expect(officialTopicLabel({ topicNumber: 2, topicName: 'Contabilidad Financiera' }, syllabus)).toBe('Tema 2. Contabilidad financiera');
  });
  it('keeps the campus name when the syllabus has no such block', () => {
    expect(officialTopicLabel({ topicNumber: 5, topicName: 'Ingeniería de procesos' }, syllabus)).toBe('Tema 5. Ingeniería de procesos');
    expect(officialTopicLabel({ topicNumber: 3, topicName: null }, [])).toBe('Tema 3');
  });
  it("keeps the campus' own name when it contradicts the syllabus block of that number", () => {
    // 02MUIN: the sessions call structural analysis "Tema 1" while the guide's block 1 is machine design concepts
    const guide = [{ n: 1, title: 'Conceptos de diseño de máquinas y mecanismos iniciales' }];
    expect(officialTopicLabel({ topicNumber: 1, topicName: 'Análisis Estructural: De Cargas Externas a Esfuerzos Internos' }, guide))
      .toBe('Tema 1. Análisis Estructural: De Cargas Externas a Esfuerzos Internos');
  });
  it('gives nothing without a topic number', () => {
    expect(officialTopicLabel({ topicNumber: null, topicName: null }, syllabus)).toBeNull();
  });
});

describe('madridDay', () => {
  it('is the calendar day in Madrid, not in UTC', () => {
    expect(madridDay('2026-11-04T16:00:00.000Z')).toBe('2026-11-04');
    expect(madridDay('2026-11-04T23:30:00.000Z')).toBe('2026-11-05'); // 00:30 in Madrid
    expect(madridDay('no es fecha')).toBeNull();
  });
});

describe('planOfficialUpdates', () => {
  const row = (over: Partial<OfficialRow>): OfficialRow => ({
    id: 1, collab_id: 'local:sesion03_01MUIN', transcript_id: 'sesion03_01MUIN', course: '01MUIN X',
    class_date: null, official_title: null, session_number: null, session_part: null, official_topic: null, ...over,
  });
  const entry = (over: Partial<DailyStateEntry>): DailyStateEntry => ({
    collabId: 'local:sesion03_01MUIN', course: '01MUIN X', title: 'sesion03 01MUIN', createdAt: '2026-11-03T09:40:03Z',
    durationSeconds: 6600, transcriptId: 'sesion03_01MUIN', handledAt: '2026-11-06T07:41:07Z',
    official: { title: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales/recording_1', createdAt: '2026-11-02T16:00:00Z', durationSeconds: 6600 },
    ...over,
  });

  it('fills the official date, session, part and topic of a class', () => {
    const plan = planOfficialUpdates([row({})], [entry({})], new Map([['01MUIN X', [{ n: 2, title: 'Contabilidad financiera' }]]]));
    expect(plan).toEqual([
      {
        id: 1, classDate: '2026-11-02', sessionNumber: 3, sessionPart: 1,
        officialTitle: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales',
        officialTopic: 'Tema 2. Contabilidad financiera',
      },
    ]);
  });

  it('matches by transcript folder when the ids differ', () => {
    const plan = planOfficialUpdates([row({ collab_id: 'abc123' })], [entry({})], new Map());
    expect(plan).toHaveLength(1);
  });

  it('does nothing when everything is already applied, or there is no official data', () => {
    const done = row({
      class_date: '2026-11-02', session_number: 3, session_part: 1,
      official_title: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales',
      official_topic: 'Tema 2. Contabilidad financiera',
    });
    expect(planOfficialUpdates([done], [entry({})], new Map([['01MUIN X', [{ n: 2, title: 'Contabilidad financiera' }]]]))).toEqual([]);
    expect(planOfficialUpdates([row({})], [entry({ official: undefined })], new Map())).toEqual([]);
  });

  it('never touches a class of another subject', () => {
    expect(planOfficialUpdates([row({ course: '02MUIN Y' })], [entry({})], new Map())).toEqual([]);
  });
});

describe('withOfficial', () => {
  const rec = { collabId: 'hash-1', title: 'Sesión 4: 04MUIN/recording_2', createdAt: '2026-11-05T16:00:00Z', durationSeconds: 3120 };

  it('adds the campus listing to the entry of the matched class', () => {
    const state = { version: 1 as const, entries: [{ collabId: 'local:x', course: 'C', title: 'x', createdAt: '2026-11-06T00:00:00Z', durationSeconds: 3120, transcriptId: 'x', handledAt: 'h' }] };
    const out = withOfficial(state, { collab_id: 'local:x', transcript_id: 'x', course: 'C', title: 'x', created_at: '2026-11-06T00:00:00Z', duration_seconds: 3120 }, rec, 'now');
    expect(out.changed).toBe(true);
    expect(out.state.entries[0]!.official).toEqual({ title: rec.title, createdAt: rec.createdAt, durationSeconds: 3120 });
    // The same listing again changes nothing (no commit every night)
    expect(withOfficial(out.state, { collab_id: 'local:x', transcript_id: 'x', course: 'C', title: 'x', created_at: '', duration_seconds: 0 }, rec, 'now').changed).toBe(false);
  });

  it('creates the entry when only the database knew the class', () => {
    const out = withOfficial(emptyDailyState(), { collab_id: 'local:y', transcript_id: 'y', course: 'C', title: 'y', created_at: '2026-11-06T00:00:00Z', duration_seconds: 10 }, rec, 'now');
    expect(out.state.entries).toHaveLength(1);
    expect(out.state.entries[0]).toMatchObject({ collabId: 'local:y', transcriptId: 'y', course: 'C', official: { title: rec.title } });
  });

  it('ignores a match without course or transcript', () => {
    expect(withOfficial(emptyDailyState(), { collab_id: 'z', transcript_id: null, course: 'C', title: 'z', created_at: '', duration_seconds: 0 }, rec, 'now').changed).toBe(false);
  });
});

describe('findSyllabusBlock', () => {
  // 04MUIN: the presentation listed only the digital-logic blocks; "Tema 2.2" of the teacher is instrumentation
  const syllabus = [
    { n: 1, title: 'Introducción a la lógica booleana' },
    { n: 2, title: 'Lógica combinacional' },
  ];
  it('does not force a topic with its own name into the block that only shares the number', () => {
    expect(findSyllabusBlock('Tema 2.2. Instrumentación en la industria', syllabus)).toBeUndefined();
  });
  it('still matches by number when the topic has no name, or by name', () => {
    expect(findSyllabusBlock('Tema 2', syllabus)?.n).toBe(2);
    expect(findSyllabusBlock('Tema 2: lógica combinacional y mapas de Karnaugh', syllabus)?.n).toBe(2);
    expect(findSyllabusBlock('Lógica combinacional', syllabus)?.n).toBe(2);
  });
});
