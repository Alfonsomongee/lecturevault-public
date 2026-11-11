/**
 * Exam question bank: practice questions (true/false, multiple choice, short answer, essay) built from the
 * class transcripts. Two sources, kept apart in the prompt and in the data:
 *   - `explicit`: the teacher said it matters for the exam, or asked it out loud;
 *   - `inferred`: concepts she stressed or repeated that an exam could ask.
 *
 * The model is not trusted. `validateExamQuestions` (pure) keeps a question only if its evidence is really in
 * the transcript, inside a teaching range, with every figure of the right answer said near that minute and
 * every rubric keyword present. The flag "the teacher said so" is checked against her own words around the
 * minute: the model cannot grant it by itself.
 */

import type { Logger } from 'pino';
import { createHash } from 'node:crypto';
import { GeminiClient } from '../ai/GeminiClient.js';
import { toTimestampedText, type TranscriptSegment } from '../library/transcript-files.js';
import type { NoteDestination } from '../database/CampusRepository.js';
import { locateEvidence, contentTokens } from './grounding.js';
import { rangeTranscript } from './notes-sections.js';
import { parseClock, formatClock } from '../utils/time.js';
import { foldWs } from '../utils/text.js';

/** Bump it to have every class offered for regeneration (Ajustes › «Generar preguntas de examen»). */
export const EXAM_PROMPT_VERSION = '1';

export const QUESTION_KINDS = ['tf', 'mcq', 'short', 'essay'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionOrigin = 'explicit' | 'inferred';

export interface RubricItem {
  /** What a good answer says, in one sentence */
  point: string;
  /** Words that show the point is covered (any one of them is enough) */
  keys: string[];
}

export interface ExamQuestionInput {
  kind: QuestionKind;
  question: string;
  /** mcq only, already in the order shown */
  options: string[];
  /** tf: 'true' | 'false'; mcq: index of the right option; short/essay: the model answer */
  answer: string;
  explanation: string;
  rubric: RubricItem[];
  topic: string;
  origin: QuestionOrigin;
  /** The teacher stressed it (said it was for the exam, or insisted) */
  emphasis: boolean;
  quote: string;
  t_ms: number;
}

export interface ExamContext {
  durationSeconds: number;
  /** Ranges the analysis cut the class into: questions only come from theory and exam ones */
  ranges?: { start_ms: number; end_ms: number; destination: NoteDestination }[];
}

export interface ExamOutput {
  questions: ExamQuestionInput[];
  dropped: number;
}

const MAX_QUESTIONS = 30;
const MAX_PER_KIND: Record<QuestionKind, number> = { tf: 12, mcq: 14, short: 6, essay: 4 };
const RANGE_TOLERANCE_MS = 5_000;
const QUESTION_DESTINATIONS: NoteDestination[] = ['theory', 'exam'];
/** Seconds around the cited minute inside which the figures and keywords must have been said */
const FACT_WINDOW_S = 120;
/** Per call: DeepSeek cut its answer (token limit) with 85 000 characters in; ~35 000 keeps the answer short enough */
const MAX_INPUT_CHARS = 35_000;

/** What the teacher says when something is for the exam (strong: grants `explicit`). */
const EXPLICIT_RE =
  /\b(?:entra(?:r[aá])?|cae(?:r[aá]n?)?|caer[aá]n?|va\s+a\s+(?:caer|entrar)|pregunta(?:r[eé]|r[aá]n?|mos)?|preguntas?\s+(?:de|del|tipo)|ex[aá]menes?|tipo\s+test|verdadero\s+o\s+falso|me\s+gusta\s+preguntar|suelo\s+preguntar|sale\s+en\s+el)\b/i;
/** Softer stress cues (grant `emphasis` only). */
const EMPHASIS_RE =
  /\b(?:importante|fundamental|esencial|clave|ojo|cuidado|tened\s+en\s+cuenta|tenéis\s+que\s+saber|ten[eé]is\s+que\s+saber|hay\s+que\s+saber|no\s+os\s+olvid[eé]is|recordad|memoriz|aprended|insisto|repito|muy\s+importante)\b/i;

export const EXAM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: [...QUESTION_KINDS] },
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          answer: { type: 'STRING' },
          explanation: { type: 'STRING' },
          rubric: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { point: { type: 'STRING' }, keys: { type: 'ARRAY', items: { type: 'STRING' } } },
              required: ['point', 'keys'],
            },
          },
          topic: { type: 'STRING' },
          origin: { type: 'STRING', enum: ['explicit', 'inferred'] },
          evidence: { type: 'STRING' },
          t: { type: 'STRING' },
        },
        required: ['kind', 'question', 'answer', 'explanation', 'origin', 'evidence', 't'],
      },
    },
  },
  required: ['questions'],
};

const SYSTEM_PROMPT = `Eres un profesor universitario que prepara un banco de preguntas de examen a partir de la transcripción de UNA clase (con marcas de tiempo [mm:ss]). Devuelve únicamente JSON que cumpla el esquema.

Cada pregunta debe poder responderse con lo que se dice en la transcripción, nunca con conocimiento externo. Hay dos orígenes:
- origin "explicit": la profesora dijo que algo cae o entra en el examen, insistió en ello ("esto es muy importante", "ojo con esto", "esto lo voy a preguntar") o planteó ella misma una pregunta en voz alta y la respondió. Escribe la pregunta tal como la plantea o la convertiría ella.
- origin "inferred": conceptos, definiciones, fórmulas, métodos o criterios que explica con detalle o repite y que un examen podría preguntar.

Tipos (kind), con esta proporción aproximada: 40 % mcq, 35 % tf, 15 % short, 10 % essay:
- "tf" (verdadero/falso): "question" es una afirmación completa y autocontenida; "answer" es "verdadero" o "falso". Haz mitad verdaderas y mitad falsas. Una falsa se construye cambiando UN detalle de algo que sí se dijo (un número, una condición, un sentido, "siempre" por "nunca"), sin inventar conceptos nuevos. "explanation" enuncia el hecho correcto con las cifras exactas de la clase.
- "mcq" (respuesta múltiple): "question" y entre 3 y 4 "options" breves, plausibles y de la misma naturaleza, con UNA sola correcta; "answer" es el texto exacto de la opción correcta. Los distractores son errores típicos o valores cercanos, nunca algo que la clase contradiga ni "todas/ninguna de las anteriores". "explanation" justifica la correcta.
- "short" (desarrollo breve): una pregunta que se contesta en 1-3 frases; "answer" es la respuesta modelo; "rubric" lista 2-4 puntos que debe cubrir, cada uno con "point" y "keys" (1-3 palabras o raíces técnicas que aparecen en la transcripción y delatan que el punto está cubierto).
- "essay" (desarrollo): una pregunta de explicar, comparar o justificar; "answer" es la respuesta modelo (4-8 frases); "rubric" con 3-6 puntos y sus "keys".

Para cada pregunta: "evidence" es un fragmento literal y corto de la transcripción en que se basa (sin cambiar palabras; en un V/F falso, la frase verdadera original), "t" su marca mm:ss y "topic" el tema en 2-4 palabras. Conserva exactamente nombres, fórmulas y cifras. Escribe en español. Las preguntas se leerán fuera de la clase: que sean autocontenidas, sin decir "según la clase", "según la profesora" ni "se presenta en la clase"; pregunta por el contenido mismo. Evita lo trivial o evidente y los distractores absurdos: cada opción incorrecta debe ser algo que un alumno que no estudió podría creer. No repitas preguntas ni hagas dos sobre el mismo dato. Si el tramo es poco sustancioso, devuelve menos preguntas; no rellenes.`;

interface RawRubric { point?: unknown; keys?: unknown }
interface RawQuestion {
  kind?: unknown; question?: unknown; options?: unknown; answer?: unknown; explanation?: unknown;
  rubric?: unknown; topic?: unknown; origin?: unknown; evidence?: unknown; t?: unknown;
}
export interface RawExam { questions?: RawQuestion[] }

const clamp = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Figures of a text, comparable across "1,5" and "1.5"; single digits are left out (list numbers, "paso 2"). */
export function significantNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = m[0].replace(',', '.');
    if (n.length >= 2) out.add(n);
  }
  return [...out];
}

/** The transcript text said within `seconds` of a moment. */
function windowAround(segments: TranscriptSegment[], startMs: number, before: number, after: number): string {
  const lo = startMs / 1000 - before;
  const hi = startMs / 1000 + after;
  return segments.filter((s) => s.end >= lo && s.start <= hi).map((s) => s.text).join(' ');
}

/** Same seed → same order, so regenerating does not reshuffle the options of questions the student already saw. */
function shuffled<T>(items: T[], seed: string): T[] {
  const out = [...items];
  let h = parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function questionGuid(recordingId: number, question: string): string {
  return createHash('sha1').update(`${recordingId}|${foldWs(question)}`).digest('hex').slice(0, 24);
}

/** Validate and ground the model's questions. Pure: all the trust logic lives here. */
export function validateExamQuestions(raw: RawExam, segments: TranscriptSegment[], context: ExamContext): ExamOutput {
  const maxMs = Math.max(context.durationSeconds, segments[segments.length - 1]?.end ?? 0) * 1000;
  const hint = (t: unknown) => {
    const seconds = parseClock(typeof t === 'string' ? t.replace(/[[\]\s]/g, '') : '');
    return seconds === null ? 0 : Math.min(seconds * 1000, maxMs);
  };
  const ranges = context.ranges?.length ? context.ranges.filter((r) => QUESTION_DESTINATIONS.includes(r.destination)) : null;

  let dropped = 0;
  const seen = new Set<string>();
  const kept: ExamQuestionInput[] = [];

  for (const q of (raw.questions ?? []).slice(0, MAX_QUESTIONS * 3)) {
    const kind = QUESTION_KINDS.find((k) => k === q.kind);
    const question = clamp(q.question, 500);
    const explanation = clamp(q.explanation, 600);
    const evidence = clamp(q.evidence, 500);
    if (!kind || question.length < 12 || !evidence) { dropped++; continue; }

    const key = foldWs(question);
    if (seen.has(key)) { dropped++; continue; }

    const loc = locateEvidence(evidence, segments, hint(q.t));
    if (loc.score < 0.5) { dropped++; continue; }
    if (ranges && !ranges.some((r) => loc.startMs >= r.start_ms - RANGE_TOLERANCE_MS && loc.startMs <= r.end_ms + RANGE_TOLERANCE_MS)) { dropped++; continue; }

    const facts = windowAround(segments, loc.startMs, FACT_WINDOW_S, FACT_WINDOW_S);
    const said = new Set(significantNumbers(facts));
    const figuresSaid = (text: string) => significantNumbers(text).every((n) => said.has(n));

    let options: string[] = [];
    let answer = '';
    let rubric: RubricItem[] = [];

    if (kind === 'tf') {
      const a = clamp(q.answer, 20).toLowerCase();
      if (/^(verdadero|cierto|true|v)$/.test(a)) answer = 'true';
      else if (/^(falso|false|f)$/.test(a)) answer = 'false';
      else { dropped++; continue; }
      if (!explanation || !figuresSaid(explanation)) { dropped++; continue; }
    } else if (kind === 'mcq') {
      const list = Array.isArray(q.options) ? q.options.map((o) => clamp(o, 220)).filter(Boolean) : [];
      const unique = [...new Map(list.map((o) => [foldWs(o), o])).values()];
      const correctText = clamp(q.answer, 220);
      const right = unique.findIndex((o) => foldWs(o) === foldWs(correctText));
      if (unique.length < 3 || unique.length > 5 || right < 0) { dropped++; continue; }
      if (unique.some((o) => /\b(?:todas|ninguna)\s+(?:de\s+)?las\s+anteriores\b/i.test(o))) { dropped++; continue; }
      if (!figuresSaid(`${unique[right]!} ${explanation}`)) { dropped++; continue; }
      options = shuffled(unique, key);
      answer = String(options.findIndex((o) => foldWs(o) === foldWs(correctText)));
    } else {
      answer = clamp(q.answer, kind === 'short' ? 600 : 1200);
      if (answer.length < 15 || !figuresSaid(answer)) { dropped++; continue; }
      const factTokens = new Set(contentTokens(windowAround(segments, loc.startMs, FACT_WINDOW_S * 1.5, FACT_WINDOW_S * 1.5)));
      const items = Array.isArray(q.rubric) ? (q.rubric as RawRubric[]) : [];
      for (const it of items.slice(0, 8)) {
        const point = clamp(it.point, 300);
        const keys = (Array.isArray(it.keys) ? it.keys : [])
          .map((k) => clamp(k, 40))
          .filter((k) => k && contentTokens(k).every((t) => factTokens.has(t)) && contentTokens(k).length > 0)
          .slice(0, 4);
        if (point && keys.length > 0) rubric.push({ point, keys });
      }
      rubric = rubric.slice(0, kind === 'short' ? 4 : 6);
      if (rubric.length < 2) { dropped++; continue; }
    }

    // "The teacher said so" is checked against her own words, never taken from the model
    const near = windowAround(segments, loc.startMs, 60, 30);
    const claimed: QuestionOrigin = q.origin === 'explicit' ? 'explicit' : 'inferred';
    const origin: QuestionOrigin = claimed === 'explicit' && EXPLICIT_RE.test(near) ? 'explicit' : 'inferred';
    const emphasis = origin === 'explicit' || EMPHASIS_RE.test(windowAround(segments, loc.startMs, 45, 20));

    seen.add(key);
    kept.push({
      kind, question, options, answer, explanation, rubric,
      topic: clamp(q.topic, 60), origin, emphasis, quote: evidence, t_ms: loc.startMs,
    });
  }

  // What the teacher stressed first, then in class order; cap per kind so the bank is not all one type
  kept.sort((a, b) => Number(b.origin === 'explicit') - Number(a.origin === 'explicit') || Number(b.emphasis) - Number(a.emphasis) || a.t_ms - b.t_ms);
  const perKind: Record<QuestionKind, number> = { tf: 0, mcq: 0, short: 0, essay: 0 };
  const questions: ExamQuestionInput[] = [];
  for (const q of kept) {
    if (perKind[q.kind] >= MAX_PER_KIND[q.kind] || questions.length >= MAX_QUESTIONS) { dropped++; continue; }
    perKind[q.kind]++;
    questions.push(q);
  }
  questions.sort((a, b) => a.t_ms - b.t_ms);
  return { questions, dropped };
}

/** The transcript to send, as chunks of labelled teaching ranges (or the whole class when it has none). */
export function examChunks(segments: TranscriptSegment[], context: ExamContext): string[] {
  const labelled = (context.ranges ?? [])
    .filter((r) => QUESTION_DESTINATIONS.includes(r.destination))
    .map((r) => {
      const body = rangeTranscript(segments, { ...r, ord: 0, heading: '' });
      return body ? `=== [${formatClock(r.start_ms / 1000)}–${formatClock(r.end_ms / 1000)}] ${r.destination === 'exam' ? 'EXAMEN' : 'TEORÍA'} ===\n${body}` : '';
    })
    .filter(Boolean);
  const parts = context.ranges?.length ? labelled : [toTimestampedText(segments, { windowSeconds: 15 })].filter((t) => t.trim());

  // A range longer than a chunk is cut at segment boundaries, each piece keeping the range's label
  const pieces = parts.flatMap((part) => {
    if (part.length <= MAX_INPUT_CHARS) return [part];
    const lines = part.split('\n');
    const header = lines[0]!.startsWith('===') ? lines.shift()! : '';
    const out: string[] = [];
    let acc = '';
    for (const line of lines) {
      if (acc && acc.length + line.length > MAX_INPUT_CHARS) { out.push(header ? `${header}\n${acc}` : acc); acc = ''; }
      acc += (acc ? '\n' : '') + line;
    }
    if (acc) out.push(header ? `${header}\n${acc}` : acc);
    return out;
  });

  const chunks: string[] = [];
  let current = '';
  for (const part of pieces) {
    if (current && current.length + part.length > MAX_INPUT_CHARS) { chunks.push(current); current = ''; }
    current += (current ? '\n\n' : '') + part;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class ExamQuestionGenerator {
  private client: GeminiClient;
  private logger?: Logger;

  constructor(options: { client: GeminiClient; logger?: Logger }) {
    this.client = options.client;
    this.logger = options.logger?.child({ component: 'exam-questions' });
  }

  /** Model that answered the last call (DeepSeek by default, Gemini when it fails) */
  get model(): string {
    return this.client.lastModelUsed;
  }

  async generate(segments: TranscriptSegment[], context: ExamContext & { title: string; course: string }): Promise<ExamOutput> {
    const chunks = examChunks(segments, context);
    if (chunks.length === 0) return { questions: [], dropped: 0 };

    const raw: RawExam = { questions: [] };
    let failure: unknown = null;
    for (const [i, chunk] of chunks.entries()) {
      // One more try per part: a long answer is sometimes cut, and the next draw is usually shorter
      for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const part = await this.client.generateJson<RawExam>(
          `Asignatura: ${context.course || '(sin asignar)'}\nTítulo: ${context.title}\n` +
            `Escribe como máximo 10 preguntas de esta parte (menos si no hay materia), y respuestas modelo concisas.\n\nTRANSCRIPCIÓN:\n${chunk}`,
          EXAM_SCHEMA,
          { system: SYSTEM_PROMPT, temperature: 0.3, maxOutputTokens: 16_384, prefer: 'deepseek' }
        );
        raw.questions!.push(...(part.questions ?? []));
        failure = null;
        break;
      } catch (err) {
        failure = err;
        this.logger?.warn({ err: (err as Error).message, chunk: i + 1, of: chunks.length, attempt }, 'Exam questions: a part failed');
      }
      }
    }
    if (raw.questions!.length === 0 && failure) throw failure;

    const out = validateExamQuestions(raw, segments, context);
    this.logger?.info({ questions: out.questions.length, dropped: out.dropped }, 'Preguntas de examen generadas');
    return out;
  }
}
