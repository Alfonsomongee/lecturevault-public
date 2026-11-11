import { describe, it, expect } from 'vitest';
import {
  extractSessionNumber,
  extractRecordingPart,
  findExistingTranscribedMatch,
} from '../../src/campus/daily-matcher.js';
import { buildCollaborateRecordingsUrl } from '../../src/campus/daily-agent.js';
import { RecordingExtractor } from '../../src/extractor/RecordingExtractor.js';
import type { RecordingMetadata, RecordingRow } from '../../src/types.js';

function makeRow(partial: Partial<RecordingRow> & { id: number; collab_id: string; title: string }): RecordingRow {
  return {
    id: partial.id,
    collab_id: partial.collab_id,
    title: partial.title,
    created_at: partial.created_at ?? '2026-11-01T10:00:00.000Z',
    duration_seconds: partial.duration_seconds ?? 6000,
    playback_url: partial.playback_url ?? '',
    first_seen_at: '2026-11-01T10:00:00.000Z',
    last_seen_at: '2026-11-01T10:00:00.000Z',
    status: partial.status ?? 'processed',
    course: partial.course ?? '01MUIN Gestión de Empresas e Ingeniería de Organización',
    transcript_id: partial.transcript_id ?? partial.collab_id.replace(/^local:/, ''),
    segments_hash: 'abc',
    display_title: partial.display_title ?? null,
    title_source: 'ai',
    class_number: partial.class_number ?? null,
    class_date: partial.class_date ?? null,
    session_kind: 'theory',
    topic: '',
    analysis_version: '3',
    ignored_at: partial.ignored_at ?? null,
  };
}

describe('Daily Campus Agent & Matcher', () => {
  describe('buildCollaborateRecordingsUrl', () => {
    it('builds launchRecordings URL from Blackboard Ultra course outline URL', () => {
      expect(
        buildCollaborateRecordingsUrl('https://learn.universidadviu.com/ultra/courses/_250115_1/outline')
      ).toBe('https://learn.universidadviu.com/ultra/courses/_250115_1/outline/collab/launchRecordings');
    });

    it('builds launchRecordings URL when query params or subpaths exist', () => {
      expect(
        buildCollaborateRecordingsUrl('https://learn.universidadviu.com/ultra/courses/_250115_1/outline?foo=bar')
      ).toBe('https://learn.universidadviu.com/ultra/courses/_250115_1/outline/collab/launchRecordings');
    });
  });

  describe('RecordingExtractor 2-digit year dates (VIU Collaborate format)', () => {
    it('parses DD/MM/YY HH:mm dates accurately as 20YY', () => {
      const iso = RecordingExtractor.normalizeDate('4/11/26 20:01');
      const d = new Date(iso);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(10); // November (0-indexed)
      expect(d.getDate()).toBe(4);
      expect(d.getHours()).toBe(20);
      expect(d.getMinutes()).toBe(1);
    });
  });

  describe('extractSessionNumber & extractRecordingPart', () => {
    it('extracts session numbers from VIU Collaborate titles and local IDs', () => {
      expect(
        extractSessionNumber(
          'Sesión 4. Tema 2: Análisis de los Estados Financieros. Tipos de análisis Financieros. ./recording_1'
        )
      ).toBe(4);
      expect(
        extractSessionNumber(
          'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales/recording_1'
        )
      ).toBe(3);
      expect(
        extractSessionNumber('SESION 2: VC Tema 1: Derecho Mercantil. Derecho al Trabajo y PRL./recording_1')
      ).toBe(2);
      expect(
        extractSessionNumber('SESION 1: Turoria Inicial / VC Tema 1: Marco Jurídico de la Empresa./recording_1')
      ).toBe(1);
      expect(extractSessionNumber('sesion03_01MUIN')).toBe(3);
      expect(
        extractSessionNumber('Class Collaborate Sesi n 01 Tutor a Colectiva Presentaci n y Hoja de Ruta de la')
      ).toBe(1);
    });

    it('extracts recording_N part numbers when present', () => {
      expect(extractRecordingPart('Sesión 4. Tema 2./recording_1')).toBe(1);
      expect(extractRecordingPart('Sesión 4. Tema 2 - recording_2')).toBe(2);
      expect(extractRecordingPart('sesion03_01MUIN')).toBeNull();
    });
  });

  describe('findExistingTranscribedMatch', () => {
    const course01 = '01MUIN Gestión de Empresas e Ingeniería de Organización';
    const existingRows: RecordingRow[] = [
      makeRow({
        id: 6,
        collab_id: 'local:sesion01_01MUIN',
        title: 'sesion01 01MUIN',
        display_title: 'Clase 1. Presentación asignatura y Marco Jurídico',
        class_number: 1,
        course: course01,
        duration_seconds: 6502,
      }),
      makeRow({
        id: 9,
        collab_id: 'local:sesion02_01MUIN',
        title: 'sesion02 01MUIN',
        display_title: 'Clase 2. Marco jurídico, laboral y PRL',
        class_number: 2,
        course: course01,
        duration_seconds: 6326,
      }),
      makeRow({
        id: 12,
        collab_id: 'local:sesion03_01MUIN',
        title: 'sesion03 01MUIN',
        display_title: 'Clase 3. Revisión Tema 1, quiz',
        class_number: 3,
        course: course01,
        duration_seconds: 6655,
      }),
      makeRow({
        id: 16,
        collab_id: 'local:Class_Collaborate_Sesi_n_4_Tema_2_An_lisis_de_los_Estados_Financieros_Tipos_de_a',
        title: 'Class Collaborate Sesi n 4 Tema 2 An lisis de los Estados Financieros Tipos de a',
        display_title: 'Clase 4. Análisis de estados financieros',
        class_number: 4,
        course: course01,
        class_date: '2026-11-04',
        duration_seconds: 6355,
      }),
    ];

    it('recognizes all 4 existing 01MUIN sessions from the Collaborate table as already transcribed', () => {
      const tableCandidates: RecordingMetadata[] = [
        {
          collabId: 'hash-s4',
          title: 'Sesión 4. Tema 2: Análisis de los Estados Financieros. Tipos de análisis Financieros. ./recording_1',
          createdAt: RecordingExtractor.normalizeDate('4/11/26 20:01'),
          durationSeconds: RecordingExtractor.parseDuration('01:45:57'),
          playbackUrl: '',
        },
        {
          collabId: 'hash-s3',
          title: 'Sesión 3. Tema 2: Contabilidad Financiera. Estructura de las cuentas anuales/recording_1',
          createdAt: RecordingExtractor.normalizeDate('2/11/26 19:59'),
          durationSeconds: RecordingExtractor.parseDuration('01:50:59'),
          playbackUrl: '',
        },
        {
          collabId: 'hash-s2',
          title: 'SESION 2: VC Tema 1: Derecho Mercantil. Derecho al Trabajo y PRL./recording_1',
          createdAt: RecordingExtractor.normalizeDate('28/10/26 20:00'),
          durationSeconds: RecordingExtractor.parseDuration('01:45:32'),
          playbackUrl: '',
        },
        {
          collabId: 'hash-s1',
          title: 'SESION 1: Turoria Inicial / VC Tema 1: Marco Jurídico de la Empresa./recording_1',
          createdAt: RecordingExtractor.normalizeDate('26/10/26 20:00'),
          durationSeconds: RecordingExtractor.parseDuration('01:48:27'),
          playbackUrl: '',
        },
      ];

      expect(findExistingTranscribedMatch(tableCandidates[0]!, course01, existingRows)?.id).toBe(16);
      expect(findExistingTranscribedMatch(tableCandidates[1]!, course01, existingRows)?.id).toBe(12);
      expect(findExistingTranscribedMatch(tableCandidates[2]!, course01, existingRows)?.id).toBe(9);
      expect(findExistingTranscribedMatch(tableCandidates[3]!, course01, existingRows)?.id).toBe(6);
    });

    it('returns undefined for a new Sesión 5 in 01MUIN so it gets recorded and transcribed', () => {
      const newSession5: RecordingMetadata = {
        collabId: 'hash-s5',
        title: 'Sesión 5. Tema 3: Dirección Estratégica y Operaciones./recording_1',
        createdAt: RecordingExtractor.normalizeDate('6/11/26 20:00'),
        durationSeconds: RecordingExtractor.parseDuration('01:47:10'),
        playbackUrl: '',
      };

      expect(findExistingTranscribedMatch(newSession5, course01, existingRows)).toBeUndefined();
    });

    it('does not cross-match sessions from a different course', () => {
      const otherCourse = '02MUIN Ingeniería mecánica y diseño de máquinas';
      const candidateIn02: RecordingMetadata = {
        collabId: 'hash-02-s4',
        title: 'Sesión 4. Dinámica de engranes./recording_1',
        createdAt: RecordingExtractor.normalizeDate('5/11/26 18:00'),
        durationSeconds: 6355,
        playbackUrl: '',
      };

      expect(findExistingTranscribedMatch(candidateIn02, otherCourse, existingRows)).toBeUndefined();
    });

    it('still recognises a class after an earlier class renumbered the course (class_number is chronological, not the campus session)', () => {
      const course04 = '04MUIN Tecnología electrónica e instrumentación';
      // sesion01 was "Clase 1"; the presentation (Sesión 1 recording_1) arrived later and pushed it to "Clase 2"
      const rows = [
        makeRow({ id: 19, collab_id: '11ffa7', title: 'Sesión 1: 04MUIN/recording_1', transcript_id: '04MUIN_Sesi_n_1_04MUIN_recording_1', course: course04, class_number: 1, duration_seconds: 1314, created_at: '2026-10-27T19:00:00.000Z' }),
        makeRow({ id: 7, collab_id: 'local:sesion01_04MUIN', title: 'sesion01 04MUIN', transcript_id: 'sesion01_04MUIN', course: course04, class_number: 2, duration_seconds: 5929, created_at: '2026-10-28T09:45:03Z' }),
      ];
      const part2 = { collabId: 'abc', title: 'Sesión 1: 04MUIN/recording_2', createdAt: '2026-10-27T19:30:00.000Z', durationSeconds: 5935, playbackUrl: '', course: course04 } as unknown as RecordingMetadata;
      expect(findExistingTranscribedMatch(part2, course04, rows)?.id).toBe(7);
    });
  });
});
