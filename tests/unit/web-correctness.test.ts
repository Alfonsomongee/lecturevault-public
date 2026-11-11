import { describe, expect, it } from 'vitest';
import { resolveDateText } from '../../src/study/dates.js';
import { isNextSessionNoise } from '../../src/campus/analysis.js';
import { withClassTitle } from '../../src/study/notes-summary.js';

describe('a misheard year', () => {
  const classDate = { y: 2026, m: 10, d: 27 };
  it('keeps a spoken year that makes sense', () => {
    expect(resolveDateText('el 26 de febrero de 2027', classDate)).toEqual({ date: '2027-02-26', confidence: 'high' });
  });
  it('turns an impossible year into the next such day, with less confidence', () => {
    expect(resolveDateText('hasta el 26 de febrero de 2017', classDate)).toEqual({ date: '2027-02-26', confidence: 'medium' });
  });
});

describe('isNextSessionNoise', () => {
  it('spots the teacher saying goodbye', () => {
    expect(isNextSessionNoise('session', 'Próxima sesión')).toBe(true);
    expect(isNextSessionNoise('session', 'Próxima sesión: Tema 3')).toBe(true);
    expect(isNextSessionNoise('session', 'Siguiente clase')).toBe(true);
  });
  it('keeps real dates', () => {
    expect(isNextSessionNoise('session', 'Última sesión teórica')).toBe(false);
    expect(isNextSessionNoise('session', 'Finalización de clases')).toBe(false);
    expect(isNextSessionNoise('exam', 'Próxima sesión')).toBe(false);
  });
});

describe('withClassTitle', () => {
  it('replaces only the first heading and keeps line endings', () => {
    const md = '# Viejo título\r\n\r\n## Resumen\r\n\r\nTexto';
    expect(withClassTitle(md, 'Clase 5. Nuevo')).toBe('# Clase 5. Nuevo\r\n\r\n## Resumen\r\n\r\nTexto');
  });
  it('leaves notes without a title, or without a class title, alone', () => {
    expect(withClassTitle('## Resumen\n\nTexto', 'Clase 5. Nuevo')).toBe('## Resumen\n\nTexto');
    expect(withClassTitle('# Viejo\n\nTexto', null)).toBe('# Viejo\n\nTexto');
  });
});

import { officialTimetable } from '../../src/campus/lms-calendar.js';

describe('officialTimetable', () => {
  it('takes the teacher and the weekly slot from the university timetable', () => {
    const sessions = [
      { date: '2026-11-03', time: '20:00', title: 'Clase (Ana Pérez Lara)' }, // Tuesday
      { date: '2026-11-05', time: '20:00', title: 'Clase (Ana Pérez Lara)' }, // Thursday
      { date: '2026-11-10', time: '20:00', title: 'Clase (Ana Pérez Lara)' },
      { date: '2026-11-12', time: '20:00', title: 'Clase' },
    ];
    expect(officialTimetable(sessions)).toEqual({ teacher: 'Ana Pérez Lara', schedule: 'Martes y jueves, 20:00' });
  });
  it('lists several time slots and gives nothing when there are no classes', () => {
    const two = [
      { date: '2026-11-02', time: '18:00', title: 'Clase (Ana)' }, // Monday
      { date: '2026-11-02', time: '20:00', title: 'Clase (Ana)' },
      { date: '2026-11-04', time: '18:00', title: 'Clase (Ana)' }, // Wednesday
    ];
    expect(officialTimetable(two).schedule).toBe('Lunes y miércoles, 18:00 y 20:00');
    expect(officialTimetable([])).toEqual({ teacher: '', schedule: '' });
  });
});

import { CampusRepository } from '../../src/database/CampusRepository.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import pino from 'pino';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('a presentation recorded late corrects the sheet', () => {
  it('lets an earlier class replace what a later class filled in, but not the other way round', () => {
    const file = path.join(os.tmpdir(), `lv-sheet-${Date.now()}.sqlite`);
    const db = new DatabaseManager(file, pino({ level: 'silent' }));
    try {
      const add = (id: string, day: string) => db.upsertRecording({ collabId: id, title: id, createdAt: `${day}T10:00:00Z`, durationSeconds: 60, playbackUrl: 'x' });
      add('late-presentation', '2026-10-27');
      add('second-class', '2026-10-29');
      const [first, second] = [db.getRecordingByCollabId('late-presentation')!.id, db.getRecordingByCollabId('second-class')!.id];
      const campus = new CampusRepository(db.handle);
      campus.applyAiProfile('X', { teacher: 'Pasajero' }, { recording_id: second });
      expect(campus.getProfile('X')?.teacher).toBe('Pasajero');
      // The earlier class corrects it...
      campus.applyAiProfile('X', { teacher: 'Titular' }, { recording_id: first });
      expect(campus.getProfile('X')?.teacher).toBe('Titular');
      expect(campus.getProfile('X')?.source_recording_id).toBe(first);
      // ...and a later one only fills gaps
      campus.applyAiProfile('X', { teacher: 'Otro' }, { recording_id: second });
      expect(campus.getProfile('X')?.teacher).toBe('Titular');
    } finally {
      db.close();
      fs.rmSync(file, { force: true });
    }
  });
});

import { shortSyllabusTitle } from '../../src/campus/analysis.js';

describe('shortSyllabusTitle', () => {
  it('drops the sub-topics the guide lists in brackets, even when the text was cut mid-bracket', () => {
    expect(shortSyllabusTitle('Diseño de circuitos y sistemas electrónicos (Amplificadores y filtros, Lógica combinacional)')).toBe('Diseño de circuitos y sistemas electrónicos');
    expect(shortSyllabusTitle('Sistemas digitales basados en microcontroladores (Introducción a la arquitectura, Programación')).toBe('Sistemas digitales basados en microcontroladores');
    expect(shortSyllabusTitle('Marco jurídico')).toBe('Marco jurídico');
    expect(shortSyllabusTitle('(Todo entre paréntesis)')).toBe('(Todo entre paréntesis)');
  });
});
