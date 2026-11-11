import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { ExamRepository } from '../../src/database/ExamRepository.js';
import { validateExamQuestions, significantNumbers, examChunks, type RawExam } from '../../src/study/exam-questions.js';
import type { TranscriptSegment } from '../../src/library/transcript-files.js';
// @ts-expect-error plain JS module shared with the browser
import { gradeQuestion, pickQuestions, failedIds, totalScore, covers } from '../../public/app/exam-grade.js';

const seg = (start: number, text: string): TranscriptSegment => ({ start, end: start + 8, text });
const SEGMENTS: TranscriptSegment[] = [
  seg(60, 'El coeficiente de seguridad se define como la relación entre la tensión de rotura y la tensión admisible.'),
  seg(70, 'Esto es muy importante, esto cae en el examen: para acero estructural usamos un coeficiente de 1,5 en carga estática.'),
  seg(80, 'La tensión de von Mises combina las tensiones principales y se compara con el límite elástico del material.'),
  seg(160, 'La rigidez de un resorte se mide en newtons por metro y depende del módulo de elasticidad del material.'),
  seg(400, 'Pasamos a hablar de la entrega del proyecto y de los grupos.'),
];
const RANGES = [
  { start_ms: 0, end_ms: 200_000, destination: 'theory' as const },
  { start_ms: 200_000, end_ms: 500_000, destination: 'admin' as const },
];
const ctx = { durationSeconds: 600, ranges: RANGES };

const base = (over: Record<string, unknown>) => ({
  kind: 'tf',
  question: 'El coeficiente de seguridad es la relación entre la tensión de rotura y la admisible.',
  answer: 'verdadero',
  explanation: 'Se define como tensión de rotura entre tensión admisible.',
  origin: 'inferred',
  evidence: 'El coeficiente de seguridad se define como la relación entre la tensión de rotura y la tensión admisible',
  t: '01:00',
  topic: 'Seguridad',
  ...over,
});

describe('validateExamQuestions', () => {
  it('keeps a grounded true/false and a multiple-choice with shuffled options', () => {
    const raw: RawExam = {
      questions: [
        base({}),
        base({
          kind: 'mcq',
          question: '¿Qué coeficiente se usa para acero estructural en carga estática?',
          answer: '1,5',
          options: ['1,5', '2,5', '3', '1,1'],
          explanation: 'Un coeficiente de 1,5.',
          evidence: 'para acero estructural usamos un coeficiente de 1,5 en carga estática',
          t: '01:10',
          origin: 'explicit',
        }),
      ],
    };
    const out = validateExamQuestions(raw, SEGMENTS, ctx);
    expect(out.questions).toHaveLength(2);
    const mcq = out.questions.find((q) => q.kind === 'mcq')!;
    expect(mcq.options).toHaveLength(4);
    expect(mcq.options[Number(mcq.answer)]).toBe('1,5');
    // she said "esto cae en el examen" next to that minute: explicit and stressed
    expect(mcq.origin).toBe('explicit');
    expect(mcq.emphasis).toBe(true);
  });

  it('does not grant "explicit" because the model says so', () => {
    const far = base({
      question: 'La rigidez de un resorte se mide en newtons por metro.', explanation: 'Se mide en newtons por metro.',
      evidence: 'La rigidez de un resorte se mide en newtons por metro y depende del módulo de elasticidad', t: '02:40', origin: 'explicit',
    });
    const out = validateExamQuestions({ questions: [far] }, SEGMENTS, ctx);
    expect(out.questions[0]!.origin).toBe('inferred');
    expect(out.questions[0]!.emphasis).toBe(false);
  });

  it('drops a question whose evidence is not in the transcript', () => {
    const out = validateExamQuestions(
      { questions: [base({ evidence: 'La transformada de Fourier descompone señales periódicas en armónicos', t: '01:00' })] },
      SEGMENTS,
      ctx
    );
    expect(out.questions).toHaveLength(0);
    expect(out.dropped).toBe(1);
  });

  it('drops a right answer with a figure the class never said', () => {
    const out = validateExamQuestions({ questions: [base({ explanation: 'El coeficiente vale 2,75 en este caso.' })] }, SEGMENTS, ctx);
    expect(out.questions).toHaveLength(0);
  });

  it('drops questions from outside the teaching ranges', () => {
    const out = validateExamQuestions(
      {
        questions: [
          base({
            question: '¿La entrega del proyecto se hace en grupos?',
            answer: 'verdadero',
            explanation: 'Se habló de los grupos.',
            evidence: 'Pasamos a hablar de la entrega del proyecto y de los grupos',
            t: '06:40',
          }),
        ],
      },
      SEGMENTS,
      ctx
    );
    expect(out.questions).toHaveLength(0);
  });

  it('rejects malformed multiple choice (answer not among options, "todas las anteriores")', () => {
    const mcq = (over: Record<string, unknown>) => base({ kind: 'mcq', options: ['A uno', 'B dos', 'C tres'], answer: 'A uno', ...over });
    expect(validateExamQuestions({ questions: [mcq({ answer: 'otra' })] }, SEGMENTS, ctx).questions).toHaveLength(0);
    expect(validateExamQuestions({ questions: [mcq({ options: ['A uno', 'B dos', 'Todas las anteriores'] })] }, SEGMENTS, ctx).questions).toHaveLength(0);
    expect(validateExamQuestions({ questions: [mcq({ options: ['A uno', 'B dos'] })] }, SEGMENTS, ctx).questions).toHaveLength(0);
  });

  it('keeps only rubric keys the class said, and needs two points', () => {
    const essay = (rubric: unknown) =>
      base({
        kind: 'essay',
        question: 'Explica cómo se compara la tensión de von Mises con el material.',
        answer: 'La tensión de von Mises combina las tensiones principales y se compara con el límite elástico del material.',
        evidence: 'La tensión de von Mises combina las tensiones principales y se compara con el límite elástico',
        t: '01:20',
        rubric,
      });
    const good = validateExamQuestions(
      {
        questions: [
          essay([
            { point: 'Combina las tensiones principales', keys: ['principales'] },
            { point: 'Se compara con el límite elástico', keys: ['límite elástico', 'elástico'] },
            { point: 'Inventado', keys: ['hamiltoniano'] },
          ]),
        ],
      },
      SEGMENTS,
      ctx
    );
    expect(good.questions).toHaveLength(1);
    expect(good.questions[0]!.rubric).toHaveLength(2);
    const thin = validateExamQuestions({ questions: [essay([{ point: 'Solo uno', keys: ['principales'] }])] }, SEGMENTS, ctx);
    expect(thin.questions).toHaveLength(0);
  });

  it('removes duplicates', () => {
    const out = validateExamQuestions({ questions: [base({}), base({})] }, SEGMENTS, ctx);
    expect(out.questions).toHaveLength(1);
  });

  it('knows which figures count', () => {
    expect(significantNumbers('paso 2 con 1,5 y 30 y 4.25')).toEqual(['1.5', '30', '4.25']);
  });

  it('chunks only the teaching ranges', () => {
    const chunks = examChunks(SEGMENTS, ctx);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('TEORÍA');
    expect(chunks[0]).not.toContain('entrega del proyecto');
  });
});

describe('ExamRepository', () => {
  let tmp: string;
  let db: DatabaseManager;
  let repo: ExamRepository;
  let rid: number;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-exam-'));
    db = new DatabaseManager(path.join(tmp, 'test.db'), pino({ level: 'silent' }));
    repo = new ExamRepository(db.handle);
    db.upsertRecording({ collabId: 'c1', title: 'Clase', createdAt: '2026-10-01T10:00:00Z', durationSeconds: 3600, playbackUrl: '', course: '02MUIN' });
    rid = db.getRecordingByCollabId('c1')!.id;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const q = (question: string) => ({
    kind: 'tf' as const,
    question,
    options: [],
    answer: 'true',
    explanation: 'x',
    rubric: [],
    topic: 't',
    origin: 'inferred' as const,
    emphasis: false,
    quote: 'q',
    t_ms: 1000,
  });

  it('keeps starred and dismissed questions when a class is regenerated', () => {
    repo.replaceQuestions(rid, [q('Pregunta uno es larga'), q('Pregunta dos es larga'), q('Pregunta tres es larga')], 'm', '1');
    const [a, b] = repo.list({ recordingId: rid });
    repo.setFlags(a!.id, { starred: true });
    repo.setFlags(b!.id, { dismissed: true });
    repo.replaceQuestions(rid, [q('Pregunta nueva es larga')], 'm', '2');
    const all = repo.list({ recordingId: rid, includeDismissed: true }).map((x) => x.question);
    expect(all).toContain(a!.question);
    expect(all).toContain(b!.question);
    expect(all).toContain('Pregunta nueva es larga');
    expect(all).not.toContain('Pregunta tres es larga');
    expect(repo.list({ recordingId: rid }).map((x) => x.question)).not.toContain(b!.question);
    expect(db.getRecordingById(rid)!.exam_version).toBe('2');
  });

  it('lists outdated classes only when they have a transcript', () => {
    expect(repo.listOutdated('1')).toEqual([]);
    db.handle.prepare("INSERT INTO segments (recording_id, idx, start_ms, end_ms, text) VALUES (?, 0, 0, 1000, 'hola')").run(rid);
    expect(repo.listOutdated('1')).toEqual([rid]);
    repo.markGenerated(rid, '1');
    expect(repo.listOutdated('1')).toEqual([]);
  });

  it('saves attempts', () => {
    const attempt = repo.saveAttempt('02MUIN', [
      { id: 1, score: 1 },
      { id: 2, score: 0.5 },
    ]);
    expect(attempt.total).toBe(2);
    expect(attempt.correct).toBe(1.5);
    expect(repo.listAttempts('02MUIN')).toHaveLength(1);
  });
});

describe('practice grading (browser module)', () => {
  const tf = { id: 1, kind: 'tf', answer: 'false' };
  const mcq = { id: 2, kind: 'mcq', answer: '2' };
  const essay = {
    id: 3,
    kind: 'essay',
    rubric: [
      { point: 'a', keys: ['derivada'] },
      { point: 'b', keys: ['límite elástico'] },
      { point: 'c', keys: ['inventado'] },
    ],
  };

  it('grades true/false and multiple choice', () => {
    expect(gradeQuestion(tf, false).score).toBe(1);
    expect(gradeQuestion(tf, true).score).toBe(0);
    expect(gradeQuestion(tf, undefined).answered).toBe(false);
    expect(gradeQuestion(mcq, 2).score).toBe(1);
    expect(gradeQuestion(mcq, 0).score).toBe(0);
  });

  it('grades a written answer by rubric coverage, tolerating plurals and accents', () => {
    const r = gradeQuestion(essay, 'Calculamos las derivadas y lo comparamos con el limite elastico');
    expect(r.hits).toEqual([true, true, false]);
    expect(r.score).toBeCloseTo(2 / 3);
    expect(gradeQuestion(essay, '').answered).toBe(false);
    expect(covers(['derivadas'], 'derivada')).toBe(true);
  });

  it('picks by weight, honours filters and brings back the failed ones', () => {
    const pool = [
      { id: 1, kind: 'mcq', recording_id: 1, emphasis: true, origin: 'explicit', starred: false },
      { id: 2, kind: 'tf', recording_id: 1, emphasis: false, origin: 'inferred', starred: false },
      { id: 3, kind: 'tf', recording_id: 2, emphasis: false, origin: 'inferred', starred: false },
    ];
    const ids = (list: { id: number }[]) => list.map((x) => x.id);
    expect(ids(pickQuestions(pool, { n: 10, recordings: new Set([2]) }))).toEqual([3]);
    expect(ids(pickQuestions(pool, { n: 10, onlyEmphasis: true }))).toEqual([1]);
    expect(ids(pickQuestions(pool, { n: 10, onlyFailed: true, failed: new Set([2]) }))).toEqual([2]);
    expect(pickQuestions(pool, { n: 2 })).toHaveLength(2);
    const failed = failedIds([
      { created_at: '2026-01-01 10:00:00', items: [{ id: 1, score: 0 }, { id: 2, score: 1 }] },
      { created_at: '2026-01-02 10:00:00', items: [{ id: 1, score: 1 }, { id: 3, score: 0.2 }] },
    ]);
    expect([...failed]).toEqual([3]);
    expect(totalScore([{ score: 1 }, { score: 0.5 }, { score: 0.3 }])).toBe(1.75);
  });
});
