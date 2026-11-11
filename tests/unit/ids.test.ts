import { describe, it, expect } from 'vitest';
import { sanitizeRecordingId, uniqueRecordingId } from '../../src/utils/ids.js';

describe('uniqueRecordingId', () => {
  it('keeps a free id as it is (cleaned like any recording id)', () => {
    expect(uniqueRecordingId('Class Collaborate Sesión 03', () => false)).toBe(sanitizeRecordingId('Class Collaborate Sesión 03'));
  });

  it('never reuses a class that is already captured: its audio and transcript would be overwritten', () => {
    const taken = new Set(['clase', 'clase-2']);
    expect(uniqueRecordingId('clase', (id) => taken.has(id))).toBe('clase-3');
    expect(uniqueRecordingId('otra', (id) => taken.has(id))).toBe('otra');
  });

  it('stays within the 80 characters a transcript folder may have', () => {
    const long = 'a'.repeat(120);
    const first = sanitizeRecordingId(long);
    const next = uniqueRecordingId(long, (id) => id === first);
    expect(next.length).toBeLessThanOrEqual(80);
    expect(next.endsWith('-2')).toBe(true);
    expect(next).not.toBe(first);
  });
});
