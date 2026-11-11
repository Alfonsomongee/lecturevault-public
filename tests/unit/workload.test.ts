import { describe, it, expect } from 'vitest';
import { weekStart, weeklyLoad, loadLevel, describeWeek, type LoadEvent } from '../../src/campus/workload.js';
import { alarmTrigger, buildIcs, parseReminderDays } from '../../src/study/exporters.js';
import type { AlertRow } from '../../src/database/StudyRepository.js';

let next = 1;
const ev = (kind: string, date: string | null, extra: Partial<LoadEvent> = {}): LoadEvent =>
  ({ id: next++, kind, title: `${kind} ${date}`, course: '01MUIN', date, ...extra });

describe('weekly workload', () => {
  it('starts weeks on Monday, across months and years', () => {
    expect(weekStart('2026-11-03')).toBe('2026-11-02'); // Tuesday
    expect(weekStart('2026-11-02')).toBe('2026-11-02'); // Monday
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // Sunday
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
  });

  it('weighs exams over deadlines and ignores sessions, dismissed and undated events', () => {
    const weeks = weeklyLoad([
      ev('exam', '2026-11-04'), ev('deadline', '2026-11-08'),
      ev('session', '2026-11-05'), ev('deadline', '2026-11-06', { dismissed: 1 }), ev('exam', null),
      ev('deadline', '2026-11-10'),
    ], '2026-11-03', 3);
    expect(weeks.map((w) => [w.start, w.end, w.score, w.level])).toEqual([
      ['2026-11-02', '2026-11-08', 5, 'critical'],
      ['2026-11-09', '2026-11-15', 2, 'light'],
      ['2026-11-16', '2026-11-22', 0, 'none'],
    ]);
    expect(weeks[0]!.events.map((e) => e.kind)).toEqual(['exam', 'deadline']);
  });

  it('names the levels and describes a week the way Inicio says it', () => {
    expect([0, 1, 3, 4, 5, 9].map(loadLevel)).toEqual(['none', 'light', 'busy', 'busy', 'critical', 'critical']);
    const [week] = weeklyLoad([ev('exam', '2026-11-04'), ev('exam', '2026-11-05'), ev('deadline', '2026-11-06'), ev('lab', '2026-11-06')], '2026-11-04', 1);
    expect(describeWeek(week!)).toBe('2 exámenes, 1 entrega y 1 evento más');
    expect(describeWeek({ exams: 1, deadlines: 0, events: [ev('exam', '2026-11-04')] })).toBe('1 examen');
  });
});

describe('calendar reminders', () => {
  it('parses the days typed in Ajustes and rejects anything else', () => {
    expect(parseReminderDays('1, 7 ,7')).toEqual([7, 1]);
    expect(parseReminderDays('  ')).toEqual([]);
    expect(parseReminderDays('0')).toEqual([0]);
    expect(() => parseReminderDays('una semana')).toThrow(/no es un número/);
    expect(() => parseReminderDays('90')).toThrow(/entre 0 y 60/);
    expect(() => parseReminderDays('1,2,3,4,5')).toThrow(/Como mucho 4/);
  });

  it('fires all-day reminders at 09:00 and timed ones before the hour', () => {
    expect(alarmTrigger(7, false)).toBe('-P6DT15H');
    expect(alarmTrigger(1, false)).toBe('-PT15H');
    expect(alarmTrigger(0, false)).toBe('PT9H');
    expect(alarmTrigger(2, true)).toBe('-P2D');
    expect(alarmTrigger(0, true)).toBe('-PT1H');
  });

  it('uses the configured reminders, a timed start when there is an hour, and none for sessions', () => {
    const row = (over: Partial<AlertRow & { time: string | null }>) => ({
      id: 1, recording_id: 1, kind: 'exam', text: 'Examen', quote: '', t_ms: 0, due_date: '2026-12-10', date_text: '',
      confidence: 'high', confirmed: 1, dismissed: 0, created_at: '', ...over,
    }) as AlertRow & { time?: string | null };
    const ics = buildIcs(
      [row({ time: '16:30' }), row({ id: 2, kind: 'session', uid: 'session-2' } as never)],
      { now: new Date('2026-11-03T10:00:00Z'), reminders: { exam: [3], deadline: [], other: [1] } }
    );
    expect(ics).toContain('DTSTART:20261210T163000');
    expect(ics).toContain('DURATION:PT1H');
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(ics).toContain('TRIGGER:-P3D');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
  });
});
