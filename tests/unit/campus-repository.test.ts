import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../src/database/migrations.js';
import { CampusRepository } from '../../src/database/CampusRepository.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';

const logger = pino({ level: 'silent' });

describe('campus data (migration v4)', () => {
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-campus-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
    campus = new CampusRepository(db.handle);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function addRecording(collabId: string, createdAt: string, course = '02MUIN', title = collabId) {
    db.upsertRecording({ collabId, title, createdAt, durationSeconds: 3600, playbackUrl: '', course });
    return db.getRecordingByCollabId(collabId)!;
  }

  describe('migration from a v3 database with data', () => {
    function buildV3(file: string) {
      const legacy = new Database(file);
      legacy.pragma('foreign_keys = ON');
      for (const m of MIGRATIONS.filter((m) => m.version <= 3)) m.up(legacy);
      legacy.pragma('user_version = 3');
      legacy.exec(`
        INSERT INTO recordings (id, collab_id, title, created_at, course) VALUES
          (1, 'collab-1', 'Sesión 01', '2026-10-05T16:00:00.000Z', '02MUIN'),
          (2, 'local:Sesi_n_02', 'Sesi n 02', '2026-10-26T21:03:58Z', '02MUIN');
        INSERT INTO alerts (recording_id, kind, text, quote, t_ms, due_date, date_text, confidence, confirmed, dismissed, source) VALUES
          (1, 'deadline', 'Entrega parte 1', 'el 18 de octubre a las 23 59', 1803000, '2026-10-18', 'el 18 de octubre', 'high', 1, 0, 'ai'),
          (1, 'exam', 'Examen 1.ª convocatoria', 'para el 18 de enero', 1928000, '2027-01-18', 'el 18 de enero', 'medium', 0, 1, 'ai'),
          (1, 'deadline', 'hasta el 9 de encierne', 'hasta el 9 de encierne', 2635000, NULL, '', 'low', 0, 0, 'ai'),
          (2, 'warning', 'Activa las credenciales', '', 3413000, NULL, '', 'high', 0, 0, 'ai'),
          (2, 'exam', 'Examen manual', '', 0, '2027-03-10', '', 'high', 1, 0, 'user');
        INSERT INTO markers (recording_id, t_ms, text) VALUES (1, 60000, 'mi marca');
      `);
      legacy.close();
    }

    it('keeps every row, copies dated exam/deadline alerts to events and fills class_date for Collab2', () => {
      const file = path.join(tmp, 'v3.db');
      buildV3(file);
      const upgraded = new DatabaseManager(file, logger);
      try {
        expect(upgraded.handle.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
        const repo = new CampusRepository(upgraded.handle);

        // Alerts untouched: the current views still read them
        expect(new StudyRepository(upgraded.handle).listAlerts({ includeDismissed: true })).toHaveLength(5);

        const events = repo.listEvents({ includeDismissed: true });
        expect(events.map((e) => [e.kind, e.title, e.date, e.course, e.confirmed, e.dismissed, e.source])).toEqual([
          ['deadline', 'Entrega parte 1', '2026-10-18', '02MUIN', 1, 0, 'ai'],
          ['exam', 'Examen 1.ª convocatoria', '2027-01-18', '02MUIN', 0, 1, 'ai'],
          ['exam', 'Examen manual', '2027-03-10', '02MUIN', 1, 0, 'user'],
        ]);
        expect(events[0]).toMatchObject({ recording_id: 1, t_ms: 1803000, quote: 'el 18 de octubre a las 23 59', date_text: 'el 18 de octubre', confidence: 'high' });

        // Collab2 knows the class day; the local import only knows when Whisper ran
        expect(upgraded.getRecordingById(1)!).toMatchObject({ class_date: '2026-10-05', title_source: 'sync', display_title: null, topic: '' });
        expect(upgraded.getRecordingById(2)!.class_date).toBeNull();

        const marker = upgraded.handle.prepare('SELECT source, why FROM markers').get();
        expect(marker).toEqual({ source: 'user', why: '' });
      } finally {
        upgraded.close();
      }
    });
  });

  describe('sync never overwrites campus state', () => {
    it('keeps display_title, title_source, class_number and a corrected class_date', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z', '02MUIN', 'Sesión 01 – Presentación');
      expect(rec.class_date).toBe('2026-10-05');

      campus.setDisplayTitle(rec.id, 'Clase 1. Evaluación y fundamentos de mecanismos', 'user');
      campus.renumberClasses('02MUIN');
      db.setCreatedAt(rec.id, new Date('2026-10-06T10:00:00').toISOString());

      db.upsertRecording({ collabId: 'c1', title: 'Sesión 01 (renombrada en Collab2)', createdAt: '2026-10-05T16:00:00.000Z', durationSeconds: 3600, playbackUrl: '' });
      const after = db.getRecordingById(rec.id)!;
      expect(after.title).toBe('Sesión 01 (renombrada en Collab2)');
      expect(after.display_title).toBe('Clase 1. Evaluación y fundamentos de mecanismos');
      expect(after.title_source).toBe('user');
      expect(after.class_number).toBe(1);
      expect(after.class_date).toBe('2026-10-06');
    });

    it('confirms the class date of a local import when the user corrects it', () => {
      const local = db.createLocalRecording({ transcriptId: 'Sesi_n_01', title: 'Sesi n 01', createdAt: '2026-10-26T21:03:58Z', durationSeconds: 60 });
      expect(local.class_date).toBeNull();
      db.setCreatedAt(local.id, new Date('2026-10-05T10:00:00').toISOString());
      expect(db.getRecordingById(local.id)!.class_date).toBe('2026-10-05');
    });
  });

  describe('class titles and numbering', () => {
    it('numbers classes by class day within the course and keeps AI title prefixes in step', () => {
      const late = addRecording('late', '2026-10-19T16:00:00.000Z');
      const early = addRecording('early', '2026-10-05T16:00:00.000Z');
      addRecording('other', '2026-10-01T16:00:00.000Z', 'Otra');
      campus.setDisplayTitle(late.id, 'Clase 1. Análisis cinemático de mecanismos', 'ai');

      expect(campus.renumberClasses('02MUIN')).toBe(2);
      expect(db.getRecordingById(early.id)!.class_number).toBe(1);
      expect(db.getRecordingById(late.id)!).toMatchObject({ class_number: 2, display_title: 'Clase 2. Análisis cinemático de mecanismos' });
      expect(campus.renumberClasses('')).toBe(0);
    });

    it('gives the parts of one campus session the same class number', () => {
      // 04MUIN on the campus: Sesión 1 (2 parts), Sesión 2, Sesión 4 (2 parts)
      const s1a = addRecording('s1a', '2026-10-27T16:00:00.000Z', '04MUIN');
      const s1b = addRecording('s1b', '2026-10-27T17:00:00.000Z', '04MUIN');
      const s2 = addRecording('s2', '2026-10-29T16:00:00.000Z', '04MUIN');
      const s4a = addRecording('s4a', '2026-11-05T16:00:00.000Z', '04MUIN');
      const s4b = addRecording('s4b', '2026-11-05T17:00:00.000Z', '04MUIN');
      const set = db.handle.prepare('UPDATE recordings SET session_number = ?, session_part = ? WHERE id = ?');
      set.run(1, 1, s1a.id); set.run(1, 2, s1b.id); set.run(2, 1, s2.id); set.run(4, 1, s4a.id); set.run(4, 2, s4b.id);
      campus.setDisplayTitle(s4b.id, 'Clase 9. Instrumentación en la industria', 'ai');

      campus.renumberClasses('04MUIN');
      const n = (id: number) => db.getRecordingById(id)!.class_number;
      expect([n(s1a.id), n(s1b.id), n(s2.id), n(s4a.id), n(s4b.id)]).toEqual([1, 1, 2, 3, 3]);
      expect(db.getRecordingById(s4b.id)!.display_title).toBe('Clase 3. Instrumentación en la industria');
    });

    it('applies what the campus says about each class and keeps it over the AI topic and a guessed date', () => {
      const rec = addRecording('local:sesion03_01MUIN', '2026-11-03T09:40:03Z', '01MUIN X');
      db.linkTranscript(rec.id, 'sesion03_01MUIN');
      campus.setSessionAnalysis(rec.id, { session_kind: 'theory', topic: 'Tema 1. Marco jurídico', analysis_version: '3' });
      const entries = [{
        collabId: 'local:sesion03_01MUIN', course: '01MUIN X', title: 'sesion03 01MUIN', createdAt: '2026-11-03T09:40:03Z',
        durationSeconds: 3600, transcriptId: 'sesion03_01MUIN', handledAt: 'h',
        official: { title: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales/recording_1', createdAt: '2026-11-02T16:00:00Z', durationSeconds: 3600 },
      }];

      expect(campus.applyOfficialSessions(entries)).toBe(1);
      expect(db.getRecordingById(rec.id)).toMatchObject({
        class_date: '2026-11-02', session_number: 3, session_part: 1, class_number: 1,
        official_topic: 'Tema 2. Contabilidad Financiera', topic: 'Tema 2. Contabilidad Financiera',
        official_title: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales',
      });
      // Applying it again changes nothing, and a later analysis does not undo the campus topic
      expect(campus.applyOfficialSessions(entries)).toBe(0);
      campus.setSessionAnalysis(rec.id, { session_kind: 'theory', topic: 'Tema 1. Marco jurídico', analysis_version: '4' });
      expect(db.getRecordingById(rec.id)!.topic).toBe('Tema 2. Contabilidad Financiera');

      // A date the student set by hand stays
      db.setCreatedAt(rec.id, new Date('2026-11-01T10:00:00').toISOString(), 'user');
      campus.applyOfficialSessions(entries);
      expect(db.getRecordingById(rec.id)!.class_date).toBe('2026-11-01');
    });

    it('never lets the AI overwrite a title the user wrote', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z');
      campus.setDisplayTitle(rec.id, 'Clase 1. Mi título', 'user');
      expect(campus.setDisplayTitle(rec.id, 'Clase 1. Título de la IA', 'ai')).toBe(false);
      expect(db.getRecordingById(rec.id)!.display_title).toBe('Clase 1. Mi título');
    });
  });

  describe('course profile: lock and proposals', () => {
    const info = { teacher: 'Prof. García', schedule: '18:00–20:00', syllabus: [{ n: 1, title: 'Conceptos de diseño' }], pass_rules: '' };

    it('creates the profile from the first presentation and fills it while unlocked', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z');
      expect(campus.applyAiProfile('02MUIN', info, { recording_id: rec.id })).toEqual({ action: 'created', proposals: 0 });
      expect(campus.getProfile('02MUIN')).toMatchObject({ teacher: 'Prof. García', syllabus: [{ n: 1, title: 'Conceptos de diseño' }], resources: [], locked: 0, source_recording_id: rec.id });

      expect(campus.applyAiProfile('02MUIN', { schedule: '18:00–20:00, 3 sesiones', teacher: '' }).action).toBe('updated');
      expect(campus.getProfile('02MUIN')).toMatchObject({ schedule: '18:00–20:00, 3 sesiones', teacher: 'Prof. García' });
    });

    it('turns AI changes to a locked profile into proposals, once, and applies them only when accepted', () => {
      const rec = addRecording('c4', '2026-10-26T16:00:00.000Z');
      campus.applyAiProfile('02MUIN', info);
      campus.setProfileLocked('02MUIN', true);

      const change = { schedule: '17:00–19:00', teacher: 'Prof. García' };
      const evidence = { recording_id: rec.id, t_ms: 754000, quote: 'a partir de ahora empezamos a las cinco' };
      expect(campus.applyAiProfile('02MUIN', change, evidence)).toEqual({ action: 'proposed', proposals: 1 });
      expect(campus.applyAiProfile('02MUIN', change, evidence)).toEqual({ action: 'proposed', proposals: 0 });
      expect(campus.getProfile('02MUIN')!.schedule).toBe('18:00–20:00');

      const [proposal] = campus.listProposals({ status: 'open', course: '02MUIN' });
      expect(proposal).toMatchObject({ target: 'profile.schedule', current_value: '18:00–20:00', proposed_value: '17:00–19:00', recording_id: rec.id, t_ms: 754000 });

      campus.acceptProposal(proposal!.id);
      expect(campus.getProfile('02MUIN')).toMatchObject({ schedule: '17:00–19:00', locked: 1 });
      expect(() => campus.acceptProposal(proposal!.id)).toThrow('ya está resuelta');
    });

    it('does not ask again about a change the user rejected', () => {
      campus.applyAiProfile('02MUIN', info);
      campus.setProfileLocked('02MUIN', true);
      campus.applyAiProfile('02MUIN', { teacher: 'Otro profesor' });
      const [p] = campus.listProposals({ status: 'open' });
      campus.rejectProposal(p!.id);
      expect(campus.applyAiProfile('02MUIN', { teacher: 'Otro profesor' }).proposals).toBe(0);
      expect(campus.getProfile('02MUIN')!.teacher).toBe('Prof. García');
    });

    it('lets the user edit a locked profile directly', () => {
      campus.applyAiProfile('02MUIN', info);
      campus.setProfileLocked('02MUIN', true);
      campus.saveProfile('02MUIN', { pass_rules: '≥5 en portafolio y ≥5 en examen' });
      expect(campus.getProfile('02MUIN')).toMatchObject({ pass_rules: '≥5 en portafolio y ≥5 en examen', locked: 1 });
    });
  });

  describe('grading', () => {
    const table = [
      { name: 'Proyecto', weight_pct: 50 },
      { name: 'Foro 1', weight_pct: 10, parent: 'Proyecto' },
      { name: 'Examen final', weight_pct: 50, min_grade: 5 },
    ];

    it('nests items by parent name and only proposes over a table the student edited', () => {
      expect(campus.replaceAiGradingItems('02MUIN', table)).toBe(3);
      expect(campus.replaceAiGradingItems('02MUIN', table)).toBe(3); // untouched: rewritten
      campus.addGradingItem('02MUIN', { name: 'Asistencia', weight_pct: 0 });
      expect(campus.replaceAiGradingItems('02MUIN', table)).toBe(0);

      const rows = campus.listGradingItems('02MUIN');
      expect(rows.map((r) => r.name).sort()).toEqual(['Asistencia', 'Examen final', 'Foro 1', 'Proyecto']);
      const proyecto = rows.find((r) => r.name === 'Proyecto')!;
      expect(rows.find((r) => r.name === 'Foro 1')!.parent_id).toBe(proyecto.id);
      expect(campus.listProposals({ status: 'open' }).map((p) => p.target)).toEqual(['profile.grading']);
    });

    it('keeps scores across renames and regeneration, and rejects nesting loops', () => {
      campus.replaceAiGradingItems('02MUIN', table);
      campus.setGradeScore('02MUIN', 'examen  FINAL', 7.5);
      campus.replaceAiGradingItems('02MUIN', table);
      const exam = campus.listGradesWithScores('02MUIN').find((g) => g.name === 'Examen final')!;
      expect(exam.score).toBe(7.5);

      campus.updateGradingItem(exam.id, { name: 'Examen' });
      expect(campus.listGradesWithScores('02MUIN').find((g) => g.id === exam.id)!.score).toBe(7.5);
      expect(campus.getGradingItem(exam.id)!.source).toBe('user');

      const proyecto = campus.listGradingItems('02MUIN').find((g) => g.name === 'Proyecto')!;
      const foro = campus.listGradingItems('02MUIN').find((g) => g.name === 'Foro 1')!;
      expect(() => campus.updateGradingItem(proyecto.id, { parent_id: foro.id })).toThrow(/sí mismo/);
      expect(() => campus.addGradingItem('01MUIN', { name: 'X', parent_id: proyecto.id })).toThrow(/asignatura/);

      campus.setGradeScore('02MUIN', 'Examen', null);
      expect(campus.listGradesWithScores('02MUIN').find((g) => g.id === exam.id)!.score).toBeNull();
      expect(campus.deleteGradingItem(proyecto.id)).toBe(true);
      expect(campus.listGradingItems('02MUIN').map((g) => g.name)).toEqual(['Examen']);
    });

    it('proposes a new table instead of replacing it when the profile is locked', () => {
      campus.applyAiProfile('02MUIN', { teacher: 'Prof. García' });
      campus.replaceAiGradingItems('02MUIN', table);
      campus.setProfileLocked('02MUIN', true);

      expect(campus.replaceAiGradingItems('02MUIN', table)).toBe(0);
      expect(campus.listProposals({ status: 'open' })).toHaveLength(0);

      const changed = [{ name: 'Proyecto', weight_pct: 40 }, { name: 'Examen final', weight_pct: 60 }];
      campus.replaceAiGradingItems('02MUIN', changed);
      expect(campus.listGradingItems('02MUIN')).toHaveLength(3);
      const [p] = campus.listProposals({ status: 'open' });
      expect(p!.target).toBe('profile.grading');

      campus.acceptProposal(p!.id);
      expect(campus.listGradingItems('02MUIN').map((r) => [r.name, r.weight_pct])).toEqual([['Proyecto', 40], ['Examen final', 60]]);
    });
  });

  describe('deliverables and exams', () => {
    it('upserts by key, enriches AI rows and never overwrites what the user edited', () => {
      const d = campus.upsertDeliverable('02MUIN', { key: 'proyecto-parte-1', title: 'Proyecto parte 1' });
      const again = campus.upsertDeliverable('02MUIN', { key: 'proyecto-parte-1', title: 'Proyecto parte 1: análisis dinámico', format: 'Artículo IEEE', group_size: '' });
      expect(again).toMatchObject({ id: d.id, title: 'Proyecto parte 1: análisis dinámico', format: 'Artículo IEEE', source: 'ai' });

      campus.updateDeliverable(d.id, { status: 'doing' });
      expect(campus.getDeliverable(d.id)).toMatchObject({ status: 'doing', source: 'ai' });

      campus.updateDeliverable(d.id, { title: 'Mi proyecto' });
      campus.upsertDeliverable('02MUIN', { key: 'proyecto-parte-1', title: 'Otro título' });
      expect(campus.getDeliverable(d.id)).toMatchObject({ title: 'Mi proyecto', source: 'user', status: 'doing' });
      expect(campus.listDeliverables('02MUIN')).toHaveLength(1);
      expect(campus.listDeliverables('Otra')).toHaveLength(0);
    });

    it('keeps ordinary and extraordinary exams apart and cleans up on delete', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z');
      const ord = campus.upsertExam('02MUIN', { key: 'final-ordinaria', title: 'Examen final (1.ª convocatoria)', format: '20 test + 2 desarrollo' });
      campus.upsertExam('02MUIN', { key: 'final-extraordinaria', title: 'Examen final (2.ª convocatoria)' });
      expect(campus.listExams('02MUIN')).toHaveLength(2);

      campus.createEvent('02MUIN', { kind: 'exam', title: 'Examen 1.ª', date: '2027-01-18', exam_id: ord.id });
      campus.replaceMentions(rec.id, [{ entity_type: 'exam', entity_id: ord.id, kind: 'format', text: '20 preguntas tipo test', t_ms: 1925000 }]);
      expect(campus.deleteExam(ord.id)).toBe(true);
      expect(campus.listEvents()).toHaveLength(0);
      expect(campus.listMentions('exam', ord.id, { includeDismissed: true })).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('regenerating keeps confirmed, dismissed and edited events and does not duplicate them', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z');
      const found = [
        { kind: 'deadline' as const, title: 'Entrega parte 1', date: '2026-10-18', time: '23:59', t_ms: 1803000, quote: 'el 18 de octubre a las 23 59' },
        { kind: 'exam' as const, title: 'Examen 1.ª', date: '2027-01-18', t_ms: 1928000 },
        { kind: 'deadline' as const, title: 'Entrega parte 2', date: '2026-12-17', t_ms: 1900000 },
        { kind: 'other' as const, title: 'Práctica grupo D', date: null, t_ms: 2409000, confidence: 'low' as const },
      ];
      expect(campus.replaceAiEvents(rec.id, '02MUIN', found).filter((id) => id !== null)).toHaveLength(4);

      const [entrega1, entrega2, examen, practica] = campus.listEvents({ recordingId: rec.id });
      expect([entrega1!.title, entrega2!.title, examen!.title, practica!.title]).toEqual(['Entrega parte 1', 'Entrega parte 2', 'Examen 1.ª', 'Práctica grupo D']);
      campus.updateEvent(entrega1!.id, { confirmed: true });
      campus.deleteEvent(examen!.id); // AI event → dismissed
      campus.updateEvent(practica!.id, { date: '2026-11-20' }); // user fills the missing day

      // The model places things a few seconds off on every run
      const regenerated = found.map((e) => ({ ...e, t_ms: e.t_ms + 5000 }));
      expect(campus.replaceAiEvents(rec.id, '02MUIN', regenerated)).toEqual([null, null, expect.any(Number), null]);

      const all = campus.listEvents({ recordingId: rec.id, includeDismissed: true });
      expect(all.map((e) => [e.title, e.date, e.confirmed, e.dismissed, e.source])).toEqual([
        ['Entrega parte 1', '2026-10-18', 1, 0, 'ai'],
        ['Práctica grupo D', '2026-11-20', 0, 0, 'user'],
        ['Entrega parte 2', '2026-12-17', 0, 0, 'ai'],
        ['Examen 1.ª', '2027-01-18', 0, 1, 'ai'],
      ]);
      expect(campus.listEvents({ recordingId: rec.id })).toHaveLength(3);
    });

    it('filters by course and range, keeping undated events last', () => {
      campus.createEvent('02MUIN', { kind: 'deadline', title: 'Dentro', date: '2026-11-02' });
      campus.createEvent('02MUIN', { kind: 'deadline', title: 'Fuera', date: '2027-02-01' });
      campus.createEvent('02MUIN', { kind: 'other', title: 'Sin fecha' });
      campus.createEvent('Otra', { kind: 'exam', title: 'Otra asignatura', date: '2026-11-03' });

      const range = campus.listEvents({ course: '02MUIN', from: '2026-11-01', to: '2026-11-14' });
      expect(range.map((e) => e.title)).toEqual(['Dentro', 'Sin fecha']);
      expect(range[0]).toMatchObject({ source: 'user', confirmed: 1 });
      expect(campus.listEvents({ from: '2026-11-01', to: '2026-11-14' })).toHaveLength(3);
    });

    it('applies an accepted date-change proposal to the event and confirms it', () => {
      const e = campus.createEvent('02MUIN', { kind: 'exam', title: 'Examen 1.ª', date: '2027-01-18' }, 'ai');
      const id = campus.createProposal({ course: '02MUIN', target: `event:${e.id}.date`, current_value: '2027-01-18', proposed_value: '2027-01-25' })!;
      campus.acceptProposal(id);
      expect(campus.getEvent(e.id)).toMatchObject({ date: '2027-01-25', confirmed: 1, source: 'user' });
    });

    it('refuses to accept a proposal it does not know how to apply', () => {
      const id = campus.createProposal({ course: '02MUIN', target: 'deliverable:new', proposed_value: '{}' })!;
      expect(() => campus.acceptProposal(id)).toThrow('No se puede aplicar');
      expect(campus.getProposal(id)!.status).toBe('open');
    });
  });

  describe('mentions, note sections and key moments', () => {
    it('replaces mentions per recording, keeps dismissed ones and lists them in class order', () => {
      const c1 = addRecording('c1', '2026-10-05T16:00:00.000Z');
      const c3 = addRecording('c3', '2026-10-19T16:00:00.000Z');
      campus.renumberClasses('02MUIN');
      const d = campus.upsertDeliverable('02MUIN', { key: 'proyecto-parte-1', title: 'Proyecto parte 1' });

      campus.replaceMentions(c3.id, [{ entity_type: 'deliverable', entity_id: d.id, kind: 'format', text: 'Formato IEEE', t_ms: 760000 }]);
      campus.replaceMentions(c1.id, [
        { entity_type: 'deliverable', entity_id: d.id, kind: 'requirement', text: 'Hasta 5 personas', t_ms: 600000 },
        { entity_type: 'deliverable', entity_id: d.id, kind: 'tip', text: 'Usad Ansys', t_ms: 900000 },
      ]);
      const listed = campus.listMentions('deliverable', d.id);
      expect(listed.map((m) => [m.class_number, m.text])).toEqual([[1, 'Hasta 5 personas'], [1, 'Usad Ansys'], [2, 'Formato IEEE']]);

      campus.setMentionDismissed(listed[1]!.id, true);
      campus.replaceMentions(c1.id, [
        { entity_type: 'deliverable', entity_id: d.id, kind: 'requirement', text: 'Hasta 5 personas', t_ms: 602000 },
        { entity_type: 'deliverable', entity_id: d.id, kind: 'tip', text: 'Usad Ansys', t_ms: 905000 },
      ]);
      expect(campus.listMentions('deliverable', d.id).map((m) => m.text)).toEqual(['Hasta 5 personas', 'Formato IEEE']);
      expect(campus.listMentions('deliverable', d.id, { includeDismissed: true })).toHaveLength(3);
    });

    it('stores note sections in order and replaces only the AI key moments', () => {
      const rec = addRecording('c1', '2026-10-05T16:00:00.000Z');
      campus.replaceNoteSections(rec.id, [
        { destination: 'course_info', heading: 'Presentación', markdown: '…', start_ms: 0, end_ms: 4620000 },
        { destination: 'theory', heading: 'Máquina y mecanismo', markdown: '…', start_ms: 4620000, end_ms: 6900000 },
      ]);
      expect(campus.listNoteSections(rec.id).map((s) => [s.ord, s.destination])).toEqual([[0, 'course_info'], [1, 'theory']]);

      new StudyRepository(db.handle).addMarker(rec.id, 1000, 'mi marca');
      campus.replaceAiMarkers(rec.id, [{ t_ms: 5178000, text: 'Definición de mecanismo', why: 'Entra en el examen' }]);
      campus.replaceAiMarkers(rec.id, [{ t_ms: 5940000, text: 'Pares cinemáticos' }]);
      const markers = db.handle.prepare('SELECT text, source FROM markers WHERE recording_id = ? ORDER BY t_ms').all(rec.id);
      expect(markers).toEqual([{ text: 'mi marca', source: 'user' }, { text: 'Pares cinemáticos', source: 'ai' }]);
    });
  });
});

describe('campus maintenance and review decisions', () => {
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;
  const add = (id: string, course = '01') => {
    db.upsertRecording({ collabId: id, title: id, createdAt: '2026-10-12T16:00:00.000Z', durationSeconds: 3600, playbackUrl: '', course });
    return db.getRecordingByCollabId(id)!.id;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-maint-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
    campus = new CampusRepository(db.handle);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adding a proposed date as a new event keeps the current one and is not asked again', () => {
    const rec = add('s1');
    const final = campus.createEvent('01', { kind: 'exam', title: 'Examen final', date: '2027-01-07' }, 'ai');
    const p = campus.createProposal({ course: '01', target: `event:${final.id}.date`, current_value: '2027-01-07', proposed_value: '2026-11-02', recording_id: rec, t_ms: 6255000, quote: 'el primer examencito' })!;

    const added = campus.addProposalAsEvent(p, { title: 'Primer examencito', kind: 'exam' });

    expect(added).toMatchObject({ title: 'Primer examencito', date: '2026-11-02', confirmed: 1, source: 'user', recording_id: rec, t_ms: 6255000, exam_id: null });
    expect(campus.getEvent(final.id)!.date).toBe('2027-01-07');
    expect(campus.getProposal(p)!.status).toBe('rejected');
    expect(campus.createProposal({ course: '01', target: `event:${final.id}.date`, proposed_value: '2026-11-02' })).toBeNull();
  });

  it('a milestone stays under its deliverable', () => {
    const d = campus.upsertDeliverable('01', { key: 'p1', title: 'Proyecto parte 1' });
    const entrega = campus.createEvent('01', { kind: 'deadline', title: 'Entrega', date: '2026-11-18', deliverable_id: d.id });
    const p = campus.createProposal({ course: '01', target: `event:${entrega.id}.date`, proposed_value: '2026-11-13' })!;
    expect(campus.addProposalAsEvent(p, { title: 'Presentar mecanismo', kind: 'deadline' }).deliverable_id).toBe(d.id);
    expect(campus.getEvent(entrega.id)!.date).toBe('2026-11-18');
  });

  it('only a date change can become an event', () => {
    const p = campus.createProposal({ course: '01', target: 'profile.teacher', proposed_value: 'Ana' })!;
    expect(() => campus.addProposalAsEvent(p, { title: 'x', kind: 'other' })).toThrow(/fecha/);
  });

  it('while unlocked, a later class only fills gaps of the sheet', () => {
    const first = add('s1');
    const second = add('s2');
    campus.applyAiProfile('01', { schedule: 'Lunes 18:00', syllabus: [{ n: 1, title: 'Marco jurídico' }] }, { recording_id: first });
    campus.applyAiProfile('01', { schedule: 'Martes 10:00', pass_rules: 'Un 5' }, { recording_id: second });
    expect(campus.getProfile('01')).toMatchObject({ schedule: 'Lunes 18:00', pass_rules: 'Un 5' });
    campus.applyAiProfile('01', { schedule: 'Lunes 19:00' }, { recording_id: first });
    expect(campus.getProfile('01')!.schedule).toBe('Lunes 19:00');
  });

  it('renames a course everywhere, the saved filter included', () => {
    const rec = add('s1');
    campus.saveProfile('01', { teacher: 'Ana' });
    const d = campus.upsertDeliverable('01', { key: 'a', title: 'Actividad' });
    const e = campus.createEvent('01', { kind: 'other', title: 'Algo', date: null });
    new StudyRepository(db.handle).setSetting('course', '01');

    campus.renameCourse('01', '01MUIN Gestión');

    expect(db.getRecordingById(rec)!.course).toBe('01MUIN Gestión');
    expect(campus.getProfile('01MUIN Gestión')!.teacher).toBe('Ana');
    expect(campus.getDeliverable(d.id)!.course).toBe('01MUIN Gestión');
    expect(campus.getEvent(e.id)!.course).toBe('01MUIN Gestión');
    expect(new StudyRepository(db.handle).getSetting('course')).toBe('01MUIN Gestión');
    expect(() => campus.renameCourse('02', '01MUIN Gestión')).toThrow(/ya tiene datos/);
  });

  it('repairs old AI data without touching what the user decided', () => {
    const rec = add('s1');
    campus.saveProfile('01', { teacher: 'Profesor no nombrado explícitamente', schedule: 'en el siguiente mes', syllabus: [{ n: 1, title: 'Marco jurídico' }, { n: 2, title: 'capítulo 2' }], pass_rules: 'tener un 5' });
    campus.saveProfile('02', { teacher: 'Profesor no nombrado explícitamente' });
    campus.setProfileLocked('02', true);
    const falseExam = campus.upsertExam('01', { key: 'preguntas', title: 'Preguntas tipo examen', format: 'null' });
    const realExam = campus.upsertExam('01', { key: 'final', title: 'Examen final', format: 'null' });
    campus.replaceMentions(rec, [{ entity_type: 'exam', entity_id: falseExam.id, kind: 'tip', text: 'Ejemplo', t_ms: 0 }]);
    const ai = (title: string, kind: 'exam' | 'deadline' | 'session', date: string | null) => campus.createEvent('01', { kind, title, date }, 'ai');
    const dated = ai('Examen final', 'exam', '2027-01-07');
    const undated = ai('Examen final', 'exam', null);
    const asked = ai('Examen final', 'exam', null);
    campus.createProposal({ course: '01', target: `event:${asked.id}.date`, proposed_value: '2026-11-02' });
    const end1 = ai('Finalización de clases', 'session', '2026-12-09');
    const end2 = ai('Finalización de clases', 'session', '2026-12-09');
    const opening = ai('Apertura Actividad 1', 'deadline', '2026-11-04');
    const mine = campus.createEvent('01', { kind: 'deadline', title: 'Apertura mía', date: '2026-11-05' });

    const report = campus.repairAiData();

    expect(campus.getProfile('01')).toMatchObject({ teacher: '', schedule: '', pass_rules: 'Tener un 5', syllabus: [{ n: 1, title: 'Marco jurídico' }] });
    expect(campus.getProfile('02')!.teacher).toBe('Profesor no nombrado explícitamente');
    expect(campus.getExam(falseExam.id)).toBeUndefined();
    expect(campus.getExam(realExam.id)!.format).toBe('');
    expect(campus.listCourseMentions('01').map((m) => m.text)).toEqual(['Ejemplo']);
    expect(campus.getEvent(dated.id)!.dismissed).toBe(0);
    expect(campus.getEvent(undated.id)!.dismissed).toBe(1);
    expect(campus.getEvent(asked.id)!.dismissed).toBe(0); // an open question decides its own fate
    expect(campus.getEvent(end1.id)!.dismissed + campus.getEvent(end2.id)!.dismissed).toBe(1);
    expect(campus.getEvent(opening.id)!.kind).toBe('other');
    expect(campus.getEvent(mine.id)).toMatchObject({ kind: 'deadline', dismissed: 0 });
    expect(report).toMatchObject({ profiles: 1, formats: 2, exams: 1 });

    expect(campus.repairAiData()).toEqual({ profiles: 0, formats: 0, exams: 0, events: 0, sections: 0 }); // idempotent
  });
});

describe('tasks asked in class', () => {
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-tasks-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
    campus = new CampusRepository(db.handle);
    db.upsertRecording({ collabId: 's1', title: 's1', createdAt: '2026-10-12T16:00:00.000Z', durationSeconds: 3600, playbackUrl: '', course: '01' });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('regenerating replaces open tasks and never brings back a ticked or dismissed one', () => {
    const rec = db.getRecordingByCollabId('s1')!.id;
    campus.replaceAiTasks(rec, '01', [
      { text: 'Descargar GIM', t_ms: 1000 }, { text: 'Leer el capítulo 1', t_ms: 300000 }, { text: 'Formar grupo', t_ms: 900000 },
    ]);
    const [a, b] = campus.listOpenTasks();
    campus.updateTask(a!.id, { done: true });
    campus.updateTask(b!.id, { dismissed: true });
    expect(campus.listOpenTasks().map((t) => t.text)).toEqual(['Formar grupo']);

    campus.replaceAiTasks(rec, '01', [
      { text: 'Descargar GIM', t_ms: 1000 }, { text: 'Leer el capítulo 1', t_ms: 300000 }, { text: 'Activar credenciales', t_ms: 1800000 },
    ]);
    expect(campus.listOpenTasks().map((t) => t.text)).toEqual(['Activar credenciales']);
    expect(campus.updateTask(99999, { done: true })).toBe(false);
  });

  it('migrates to the latest version with the tasks table', () => {
    expect(db.handle.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });
});

describe('regenerating events after some were discarded', () => {
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-regen-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), logger);
    campus = new CampusRepository(db.handle);
    db.upsertRecording({ collabId: 's1', title: 's1', createdAt: '2026-10-12T16:00:00.000Z', durationSeconds: 7200, playbackUrl: '', course: '01' });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a discarded date-less event does not hide the real date said next to it, but a discarded date stays discarded', () => {
    const rec = db.getRecordingByCollabId('s1')!.id;
    const said = (date: string | null) => ({ kind: 'exam' as const, title: 'Examen final', date, t_ms: 2_261_000 });
    const [undated, wrong] = campus.replaceAiEvents(rec, '01', [said(null), { ...said('2027-02-02'), t_ms: 2_300_000 }]);
    campus.updateEvent(undated!, { dismissed: true });
    campus.updateEvent(wrong!, { dismissed: true });

    const again = campus.replaceAiEvents(rec, '01', [said('2027-01-07'), { ...said('2027-02-02'), t_ms: 2_300_000 }, said(null)]);

    expect(again[0]).not.toBeNull();
    expect(again[1]).toBeNull();
    expect(again[2]).toBeNull();
    expect(campus.listEvents({ course: '01' }).map((e) => e.date)).toEqual(['2027-01-07']);
  });
});
