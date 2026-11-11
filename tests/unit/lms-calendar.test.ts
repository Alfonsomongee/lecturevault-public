import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIcs, classifyLmsEvent, lmsEvents, suspiciousRemoval } from '../../src/campus/lms-calendar.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { CampusRepository, type LmsEventInput } from '../../src/database/CampusRepository.js';

// The shape of the VIU campus feed (oncampus.universidadviu.com/events/ics), trimmed
const FEED = [
  'BEGIN:VCALENDAR', 'PRODID:-//eluceo/ical//2.0/EN', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:1052072', 'SUMMARY:SESIÓN 04 MUIN',
  'DESCRIPTION:Descripción: 2026_10_A_11178: 04MUIN_10_A_2026-27_Tecnología ', ' electrónica e instrumentación',
  'DTSTART:20261103T200000', 'DTEND:20261103T220000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:70a1beb5', 'SUMMARY:04MUIN_10_A_2026-27_Tecnología electrónica e instrumentación',
  'DESCRIPTION:Módulo: 2026_10_A_11178\\n\\nDuración: 120m\\n\\nInstructor: Ana P', ' érez Lara\\n\\nUbicación: VIU Online.',
  'DTSTART:20261103T200000', 'DTEND:20261103T220000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1062600', 'SUMMARY:Proyecto parte 1. Rediseño de un Componente',
  'DESCRIPTION:Descripción: 2026_10_A_11176: 02MUIN_10_A_2026-27_Ingeniería mecánica y diseño de máquinas',
  'DTSTART:20261118T235900', 'DTEND:20261118T235900', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1062601', 'SUMMARY:Cuestionario A', 'DESCRIPTION:Descripción: 2026_04_Y_51191: 17MUIN_04_Y_2026-27_ CF- Herramientas de simulación',
  'DTSTART:20261202T235900', 'DTEND:20261202T235900', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1062602', 'SUMMARY:Cuestionario B', 'DESCRIPTION:Descripción: 2026_04_Y_51191: 17MUIN_04_Y_2026-27_ CF- Herramientas de simulación',
  'DTSTART:20261202T235900', 'DTEND:20261202T235900', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1062603', 'SUMMARY:✨ ¡Conócete y Conéctate! ', 'DESCRIPTION:Descripción: 2026_04_Y_51193: 19MUIN_04_Y_2026-27_CF - Diseño de máquinas',
  'DTSTART:20261217T235929', 'DTEND:20261217T235929', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1070000', 'SUMMARY:Examen 1ª Convocatoria 03MUIN',
  'DESCRIPTION:Franja 1: 12:00\\nFranja 2: 20:00 2026_10_A_11177: 03MUIN_10_A_2026-27_Sistemas eléctricos',
  'DTSTART:20270304T000000', 'DTEND:20270304T235900', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:1062531', 'SUMMARY:Práctica 04MUIN Grupo B', 'DESCRIPTION:', 'DTSTART:20261120T190000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:2000001', 'SUMMARY:VIU_Seminario Online: "Gobernanza\\, IA"', 'DESCRIPTION:', 'DTSTART:20261112T163000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:2000002', 'SUMMARY:Festivo', 'DTSTART;VALUE=DATE:20261208', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('university calendar feed', () => {
  it('unfolds lines, unescapes text and reads local, all-day and UTC starts', () => {
    const events = parseIcs(FEED);
    expect(events).toHaveLength(10);
    expect(events[0]!.description).toContain('Tecnología electrónica e instrumentación');
    expect(events[1]!.description).toContain('Instructor: Ana Pérez Lara');
    expect(events[8]!.summary).toBe('VIU_Seminario Online: "Gobernanza, IA"');
    expect(events[9]).toMatchObject({ date: '2026-12-08', time: null });
    const [utc] = parseIcs('BEGIN:VEVENT\nUID:x\nDTSTART:20260115T110000Z\nEND:VEVENT');
    expect(utc!.date).toBe('2026-01-15');
    expect(utc!.time).toMatch(/^\d{2}:00$/);
  });

  it('classifies classes, deadlines, labs and exams, and leaves out what has no course', () => {
    const [sesion, modulo, proyecto, , , foro, examen, practica, viu] = parseIcs(FEED).map(classifyLmsEvent);
    expect(sesion).toMatchObject({ code: '04MUIN', kind: 'session', title: 'Clase', courseName: 'Tecnología electrónica e instrumentación' });
    expect(modulo).toMatchObject({ kind: 'session', title: 'Clase (Ana Pérez Lara)' });
    expect(proyecto).toMatchObject({ code: '02MUIN', kind: 'deadline', time: '23:59', courseName: 'Ingeniería mecánica y diseño de máquinas' });
    expect(foro).toMatchObject({ code: '19MUIN', kind: 'other', title: '¡Conócete y Conéctate!', courseName: 'Diseño de máquinas' });
    expect(examen).toMatchObject({ code: '03MUIN', kind: 'exam', date: '2027-03-04', time: null });
    expect(practica).toMatchObject({ kind: 'lab', time: '19:00' });
    expect(viu).toBeNull();
  });

  it('keeps one event per class but every deadline, with a uid stable across feed orders', () => {
    const { events, skipped } = lmsEvents(FEED);
    expect(skipped).toBe(2);
    const classes = events.filter((e) => e.kind === 'session');
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ title: 'Clase (Ana Pérez Lara)', uid: '1052072' });
    expect(events.filter((e) => e.code === '17MUIN').map((e) => e.title)).toEqual(['Cuestionario A', 'Cuestionario B']);
  });
});

describe('syncing the university calendar', () => {
  let tmp: string;
  let db: DatabaseManager;
  let campus: CampusRepository;
  const lms = (over: Partial<LmsEventInput>): LmsEventInput =>
    ({ uid: 'u1', course: '02MUIN Mecánica', kind: 'deadline', title: 'Proyecto parte 1', date: '2026-11-18', time: '23:59', ...over });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-lms-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), pino({ level: 'silent' }));
    campus = new CampusRepository(db.handle);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds confirmed events, and a second sync of the same feed changes nothing', () => {
    expect(campus.syncLmsEvents([lms({}), lms({ uid: 'u2', kind: 'session', title: 'Clase', time: '20:00' })], '2026-11-03'))
      .toEqual({ added: 2, updated: 0, matched: 0, removed: 0, held: 0 });
    expect(campus.syncLmsEvents([lms({}), lms({ uid: 'u2', kind: 'session', title: 'Clase', time: '20:00' })], '2026-11-03'))
      .toEqual({ added: 0, updated: 0, matched: 0, removed: 0, held: 0 });
    const e = campus.listEvents({ course: '02MUIN Mecánica' }).find((x) => x.external_uid === 'u1');
    expect(e).toMatchObject({ source: 'lms', confirmed: 1, confidence: 'high', external_uid: 'u1' });
  });

  it('confirms what the AI heard in class instead of doubling it, and follows the university when it moves', () => {
    const ai = campus.createEvent('02MUIN Mecánica', { kind: 'deadline', title: 'Entrega del proyecto (lo dijo el profe)', date: '2026-11-18', quote: 'el dieciocho' }, 'ai');
    expect(campus.syncLmsEvents([lms({})], '2026-11-03')).toMatchObject({ added: 0, matched: 1 });
    expect(campus.getEvent(ai.id)).toMatchObject({ confirmed: 1, title: 'Entrega del proyecto (lo dijo el profe)', quote: 'el dieciocho', time: '23:59' });

    expect(campus.syncLmsEvents([lms({ date: '2026-11-20' })], '2026-11-03')).toMatchObject({ updated: 1 });
    expect(campus.getEvent(ai.id)!.date).toBe('2026-11-20');
  });

  describe('the class and the university say different days', () => {
    const COURSE = '02MUIN Mecánica';
    const exam = (over: Partial<LmsEventInput> = {}) =>
      lms({ uid: 'x1', kind: 'exam', title: 'Examen 1ª Convocatoria 02MUIN', date: '2027-01-20', time: null, ...over });

    it('is one event: the university day wins and the class day waits in the inbox, with its quote', () => {
      const heard = campus.createEvent(COURSE, { kind: 'exam', title: 'Examen Final (1.ª convocatoria)', date: '2027-01-18', quote: 'el 18 de enero', t_ms: 5000 }, 'ai');
      expect(campus.syncLmsEvents([exam()], '2026-11-03')).toMatchObject({ added: 0, matched: 1 });

      expect(campus.listEvents({ course: COURSE }).filter((e) => e.kind === 'exam')).toHaveLength(1);
      expect(campus.getEvent(heard.id)).toMatchObject({ date: '2027-01-20', confirmed: 1, source: 'ai', external_uid: 'x1', quote: 'el 18 de enero' });
      expect(campus.listProposals({ status: 'open' })).toMatchObject([
        { target: `event:${heard.id}.date`, current_value: '2027-01-20', proposed_value: '2027-01-18', quote: 'el 18 de enero' },
      ]);

      // syncing again changes nothing and asks nothing new
      expect(campus.syncLmsEvents([exam()], '2026-11-03')).toMatchObject({ added: 0, matched: 0, updated: 0 });
      expect(campus.listProposals({ status: 'open' })).toHaveLength(1);
    });

    it('accepting the class day keeps it as the student\'s, so the next sync does not undo it', () => {
      const heard = campus.createEvent(COURSE, { kind: 'exam', title: 'Examen final primera convocatoria', date: '2027-01-18' }, 'ai');
      campus.syncLmsEvents([exam()], '2026-11-03');
      campus.acceptProposal(campus.listProposals({ status: 'open' })[0]!.id);
      campus.syncLmsEvents([exam()], '2026-11-03');
      expect(campus.getEvent(heard.id)).toMatchObject({ date: '2027-01-18', source: 'user' });
    });

    it('a day the student already confirmed stays, and the university day is what gets proposed', () => {
      const heard = campus.createEvent(COURSE, { kind: 'exam', title: 'Examen final 1ª convocatoria', date: '2027-01-18' }, 'ai');
      campus.updateEvent(heard.id, { confirmed: true });
      campus.syncLmsEvents([exam()], '2026-11-03');
      expect(campus.getEvent(heard.id)).toMatchObject({ date: '2027-01-18', source: 'user', external_uid: 'x1' });
      expect(campus.listProposals({ status: 'open' })).toMatchObject([{ current_value: '2027-01-18', proposed_value: '2027-01-20' }]);
    });

    it('a class event with no day takes the university day without asking anything', () => {
      const heard = campus.createEvent(COURSE, { kind: 'lab', title: 'Práctica de laboratorio Grupo D', date: null }, 'ai');
      campus.syncLmsEvents([lms({ uid: 'l1', kind: 'lab', title: 'Práctica 02MUIN Grupo D', date: '2026-11-27', time: '19:00' })], '2026-11-03');
      expect(campus.getEvent(heard.id)).toMatchObject({ date: '2026-11-27', time: '19:00', external_uid: 'l1' });
      expect(campus.listProposals({ status: 'open' })).toHaveLength(0);
    });

    it('does not merge the second call into the first, nor things it cannot tell apart', () => {
      campus.createEvent(COURSE, { kind: 'exam', title: 'Examen Final (2ª convocatoria)', date: '2027-03-08' }, 'ai');
      campus.createEvent(COURSE, { kind: 'deadline', title: 'Entrega Proyecto Parte 1', date: '2026-11-18' }, 'ai');
      expect(campus.syncLmsEvents([exam(), lms({ uid: 'p1', title: 'Presentación del Proyecto', date: '2026-11-13' })], '2026-11-03'))
        .toMatchObject({ added: 2, matched: 0 });
      expect(campus.listEvents({ course: COURSE })).toHaveLength(4);
    });
  });

  it('respects what the student edited or discarded, and removes only future events the feed dropped', () => {
    campus.syncLmsEvents([lms({}), lms({ uid: 'u2', title: 'Foro', kind: 'other' }), lms({ uid: 'old', date: '2026-10-01' })], '2026-11-03');
    const [proyecto, foro] = ['u1', 'u2'].map((uid) => campus.listEvents({ includeDismissed: true }).find((e) => e.external_uid === uid)!);
    campus.updateEvent(proyecto!.id, { title: 'Proyecto (mi grupo entrega el 17)', date: '2026-11-17' });
    campus.updateEvent(foro!.id, { dismissed: true });

    expect(campus.syncLmsEvents([lms({ title: 'Proyecto parte 1 (nuevo nombre)' }), lms({ uid: 'u2', title: 'Foro', kind: 'other' })], '2026-11-03'))
      .toMatchObject({ updated: 0, removed: 0 }); // 'old' is past: kept as a record
    expect(campus.getEvent(proyecto!.id)).toMatchObject({ title: 'Proyecto (mi grupo entrega el 17)', date: '2026-11-17' });
    expect(campus.getEvent(foro!.id)!.dismissed).toBe(1);

    expect(campus.syncLmsEvents([lms({})], '2026-11-03')).toMatchObject({ removed: 1 }); // the foro left the feed
    expect(campus.getEvent(foro!.id)).toBeUndefined();
  });

  describe('a feed that looks broken', () => {
    const six = Array.from({ length: 6 }, (_, i) => lms({ uid: `e${i}`, title: `Entrega ${i}`, date: `2026-12-0${i + 1}` }));
    const count = () => campus.listEvents({ includeDismissed: true }).length;

    it('deletes nothing when the feed comes empty, and says how many it kept', () => {
      campus.syncLmsEvents(six, '2026-11-03');
      expect(campus.syncLmsEvents([], '2026-11-03')).toMatchObject({ removed: 0, held: 6 });
      expect(count()).toBe(6);
    });

    it('deletes nothing when the feed loses more than half', () => {
      campus.syncLmsEvents(six, '2026-11-03');
      expect(campus.syncLmsEvents(six.slice(0, 2), '2026-11-03')).toMatchObject({ removed: 0, held: 4 });
      expect(count()).toBe(6);
    });

    it('still adds and updates while it holds the removals back', () => {
      campus.syncLmsEvents(six, '2026-11-03');
      const result = campus.syncLmsEvents([{ ...six[0]!, date: '2026-12-20' }, lms({ uid: 'nuevo', title: 'Otra entrega', date: '2026-12-22' })], '2026-11-03');
      expect(result).toMatchObject({ added: 1, updated: 1, removed: 0, held: 5 });
    });

    it('removes a normal change (half or fewer)', () => {
      campus.syncLmsEvents(six, '2026-11-03');
      expect(campus.syncLmsEvents(six.slice(0, 3), '2026-11-03')).toMatchObject({ removed: 3, held: 0 });
      expect(count()).toBe(3);
    });

    it('removes them when the student confirms the change is real', () => {
      campus.syncLmsEvents(six, '2026-11-03');
      expect(campus.syncLmsEvents([], '2026-11-03', { force: true })).toMatchObject({ removed: 6, held: 0 });
      expect(count()).toBe(0);
    });

    it('does not unlink the events of the AI or the student while it holds back', () => {
      const ai = campus.createEvent('02MUIN Mecánica', { kind: 'deadline', title: 'Proyecto parte 1', date: '2026-11-18' }, 'ai');
      campus.syncLmsEvents([lms({}), ...six], '2026-11-03'); // confirms the AI event
      expect(campus.getEvent(ai.id)!.external_uid).toBe('u1');
      campus.syncLmsEvents([], '2026-11-03');
      expect(campus.getEvent(ai.id)!.external_uid).toBe('u1');
    });
  });
});

describe('suspiciousRemoval', () => {
  it('trusts a feed that removes nothing, or at most half of what was there', () => {
    expect(suspiciousRemoval(0, 0, 0)).toBe(false);
    expect(suspiciousRemoval(5, 5, 0)).toBe(false);
    expect(suspiciousRemoval(3, 6, 3)).toBe(false);
    expect(suspiciousRemoval(1, 2, 1)).toBe(false);
  });

  it('distrusts an empty feed or one that loses over half', () => {
    expect(suspiciousRemoval(0, 4, 4)).toBe(true);
    expect(suspiciousRemoval(2, 6, 4)).toBe(true);
    expect(suspiciousRemoval(0, 1, 1)).toBe(true);
  });
});
