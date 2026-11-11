/**
 * Study extraction: one Gemini call per class that returns critical alerts (exam hints,
 * deadlines, warnings), flashcards and glossary terms as schema-constrained JSON — followed by
 * strict local validation. Nothing the model says is stored unless it is grounded in the
 * transcript, and every timestamp is snapped to where the words were really spoken.
 */

import type { Logger } from 'pino';
import { GeminiClient } from '../ai/GeminiClient.js';
import { toTimestampedText, cleanSegments, type TranscriptSegment } from '../library/transcript-files.js';
import type { AlertInput, AlertKind, FlashcardInput, GlossaryInput } from '../database/StudyRepository.js';
import { locateEvidence } from './grounding.js';
import {
  isDateBacked, localCalendarDate, resolveDateText, sanitizeDueDate, toIso, weekdayName, type CalendarDate,
} from './dates.js';
import { parseClock } from '../utils/time.js';
import { foldWs } from '../utils/text.js';
import { formatClock } from '../utils/time.js';
import type { NoteDestination } from '../database/CampusRepository.js';
import { rangeTranscript } from './notes-sections.js';

const MAX_ALERTS = 40;
const MAX_CARDS = 30;
const MAX_TERMS = 40;
const MAX_INPUT_CHARS = 700_000;

export interface StudyContext {
  title: string;
  course: string;
  /** ISO timestamp of the class (anchor for relative dates) */
  classDate: string;
  /** False when classDate is only the transcription date (imported transcripts). Default true. */
  classDateConfirmed?: boolean;
  durationSeconds: number;
  glossary?: string[];
  /**
   * The ranges the analysis cut the class into. When present, logistics is not sent and flashcards
   * only count if they come from a theory or exam range.
   */
  ranges?: { start_ms: number; end_ms: number; destination: NoteDestination }[];
}

/** A flashcard's time may fall this far outside its range (segment rounding) and still count as inside */
const RANGE_TOLERANCE_MS = 5_000;
const CARD_DESTINATIONS: NoteDestination[] = ['theory', 'exam'];

export interface StudyOutput {
  alerts: AlertInput[];
  flashcards: FlashcardInput[];
  glossary: GlossaryInput[];
  dropped: { alerts: number; flashcards: number };
}

const ALERT_KINDS: AlertKind[] = ['exam', 'deadline', 'warning', 'formula', 'grading'];

export const STUDY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    alerts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ALERT_KINDS },
          text: { type: 'STRING' },
          evidence: { type: 'STRING' },
          t: { type: 'STRING' },
          date_text: { type: 'STRING' },
          due_date: { type: 'STRING', nullable: true },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        },
        required: ['kind', 'text', 'evidence', 't'],
      },
    },
    flashcards: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['basic', 'cloze'] },
          front: { type: 'STRING' },
          back: { type: 'STRING' },
          tag: { type: 'STRING' },
          evidence: { type: 'STRING' },
          t: { type: 'STRING' },
        },
        required: ['kind', 'front', 'back', 'evidence', 't'],
      },
    },
    glossary: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          term: { type: 'STRING' },
          definition: { type: 'STRING' },
          t: { type: 'STRING' },
        },
        required: ['term', 'definition'],
      },
    },
  },
  required: ['alerts', 'flashcards', 'glossary'],
};

const SYSTEM_PROMPT = `Eres un asistente de estudio para estudiantes universitarios de ingeniería.
Recibes la transcripción (con marcas de tiempo [mm:ss]) de UNA clase y debes extraer tres cosas. Devuelve únicamente JSON que cumpla el esquema.

1. alerts — Avisos críticos que el profesor dijo y que el alumno no debe perderse:
   - kind "exam": lo que entra o no entra en el examen, formato o fecha del examen.
   - kind "deadline": entregas, foros, prácticas y plazos con fecha.
   - kind "grading": pesos y criterios de evaluación (porcentajes, nota mínima).
   - kind "warning": advertencias ("cuidado con...", errores típicos, requisitos de software como Smowl).
   - kind "formula": fórmulas o procedimientos que el profesor marca como importantes.
   Para cada aviso: "text" (una frase clara y accionable), "evidence" (cita literal y corta de la transcripción, sin cambiar palabras), "t" (marca [mm:ss] donde se dijo, solo mm:ss), "date_text" (la expresión de fecha tal como se dijo, o ""), "due_date" (YYYY-MM-DD solo si el día puede determinarse con certeza a partir de la fecha de la clase; si no, null) y "confidence".
   No inventes fechas. Si el profesor dice "el día 20" sin mes, usa la fecha de la clase para decidir el mes y pon confidence "medium".

2. flashcards — Entre 15 y 20 tarjetas de memoria (menos si hay poca materia) sobre los conceptos técnicos clave de la clase. Si la transcripción viene dividida en tramos ("=== [mm:ss–mm:ss] DESTINO ==="), crea tarjetas solo de los tramos TEORÍA y EXAMEN; los demás tramos solo alimentan los avisos. Si no hay ninguno de esos dos, devuelve flashcards vacío:
   - kind "basic": pregunta en "front", respuesta breve y exacta en "back".
   - kind "cloze": frase en "front" con huecos {{c1::respuesta}}; "back" puede quedar vacío o llevar una aclaración.
   - Una idea por tarjeta, autocontenida, sin referirse a "la clase" ni a "el profesor".
   - "evidence": fragmento literal de la transcripción que respalda la respuesta. "t": su marca [mm:ss]. "tag": tema en una o dos palabras sin espacios (usa guion bajo).
   - Solo contenido que se explique realmente en la transcripción.

3. glossary — Términos técnicos, siglas y nombres de software que aparecen (máx. 30), con definición breve según lo explicado y "t".

Escribe en español. Conserva exactamente nombres de software, fórmulas y cifras.`;

interface RawAlert {
  kind?: string; text?: string; evidence?: string; t?: string;
  date_text?: string; due_date?: string | null; confidence?: string;
}
interface RawCard {
  kind?: string; front?: string; back?: string; tag?: string; evidence?: string; t?: string;
}
interface RawTerm { term?: string; definition?: string; t?: string }
interface RawStudy { alerts?: RawAlert[]; flashcards?: RawCard[]; glossary?: RawTerm[] }

/** Phrases that almost always matter to a student; used as a recall safety net. */
const KEYWORD_PATTERNS: { re: RegExp; kind: AlertKind }[] = [
  { re: /\b(?:entra|entrar[aá]|cae|caer[aá])\s+(?:en\s+)?(?:el\s+)?examen\b/i, kind: 'exam' },
  { re: /\b(?:fecha\s+l[ií]mite|plazo\s+de\s+entrega|fecha\s+de\s+entrega)\b/i, kind: 'deadline' },
  { re: /\bhasta\s+el\s+(?:d[ií]a\s+)?\d{1,2}\b/i, kind: 'deadline' },
  { re: /\b(?:cuidado\s+con|ojo\s+con|no\s+os\s+olvid[eé]is|no\s+se\s+os\s+olvide)\b/i, kind: 'warning' },
];

function clamp(text: unknown, max: number): string {
  return typeof text === 'string' ? text.trim().slice(0, max) : '';
}

function stripStamp(t: unknown): string {
  return typeof t === 'string' ? t.replace(/[[\]\s]/g, '') : '';
}

/** Validate and ground the model's output. Pure function: all the trust logic lives here. */
export function validateStudyOutput(raw: RawStudy, segments: TranscriptSegment[], context: StudyContext): StudyOutput {
  const classDate: CalendarDate = localCalendarDate(context.classDate);
  const dateOptions = { classDateConfirmed: context.classDateConfirmed ?? true };
  const maxMs = Math.max(context.durationSeconds, segments[segments.length - 1]?.end ?? 0) * 1000;
  const hint = (t: unknown) => {
    const seconds = parseClock(stripStamp(t));
    return seconds === null ? 0 : Math.min(seconds * 1000, maxMs);
  };
  const dropped = { alerts: 0, flashcards: 0 };

  // ── alerts ──
  const alerts: AlertInput[] = [];
  for (const a of (raw.alerts ?? []).slice(0, MAX_ALERTS * 2)) {
    const kind = ALERT_KINDS.find((k) => k === a.kind);
    const text = clamp(a.text, 300);
    if (!kind || !text) { dropped.alerts++; continue; }

    const evidence = clamp(a.evidence, 400);
    const loc = locateEvidence(evidence || text, segments, hint(a.t));
    if (loc.score < 0.2) { dropped.alerts++; continue; } // not found in the transcript

    const dateText = clamp(a.date_text, 80);
    let confidence: 'high' | 'medium' | 'low' =
      a.confidence === 'high' || a.confidence === 'low' ? a.confidence : 'medium';

    // The spoken phrase, resolved here, beats the model's ISO date; the model's date is only used
    // when the phrase can't be resolved, and only if the words actually say that day.
    let dueDate: string | null = null;
    const resolved = dateText ? resolveDateText(dateText, classDate, dateOptions) : null;
    if (resolved) {
      dueDate = resolved.date;
      if (resolved.confidence === 'medium' && confidence === 'high') confidence = 'medium';
    } else {
      const proposed = sanitizeDueDate(a.due_date, classDate, dateOptions);
      if (proposed && isDateBacked(proposed, `${dateText} ${evidence}`)) dueDate = proposed;
    }
    if (dueDate && !dateOptions.classDateConfirmed && confidence === 'high') confidence = 'medium';
    if (loc.score < 0.5) confidence = 'low';

    alerts.push({ kind, text, quote: evidence, t_ms: loc.startMs, due_date: dueDate, date_text: dateText, confidence });
    if (alerts.length >= MAX_ALERTS) break;
  }

  // Recall safety net: strong phrases the model missed become low-confidence warnings.
  for (const seg of cleanSegments(segments)) {
    for (const { re, kind } of KEYWORD_PATTERNS) {
      if (!re.test(seg.text)) continue;
      const ms = Math.round(seg.start * 1000);
      if (alerts.some((a) => a.kind === kind && Math.abs(a.t_ms - ms) <= 30_000)) break;
      if (alerts.length >= MAX_ALERTS) break;
      const resolved = resolveDateText(seg.text, classDate, dateOptions);
      alerts.push({
        kind, text: seg.text.slice(0, 300), quote: seg.text.slice(0, 400), t_ms: ms,
        due_date: kind === 'deadline' ? resolved?.date ?? null : null,
        date_text: '', confidence: 'low',
      });
      break;
    }
  }

  // ── flashcards ──
  const cardRanges = context.ranges?.length ? context.ranges.filter((r) => CARD_DESTINATIONS.includes(r.destination)) : null;
  const seenFronts = new Set<string>();
  const flashcards: FlashcardInput[] = [];
  for (const c of (raw.flashcards ?? []).slice(0, MAX_CARDS * 2)) {
    const kind = c.kind === 'cloze' ? 'cloze' : c.kind === 'basic' ? 'basic' : null;
    const front = clamp(c.front, 500);
    const back = clamp(c.back, 800);
    if (!kind || !front || (kind === 'basic' && !back)) { dropped.flashcards++; continue; }
    if (kind === 'cloze' && !/\{\{c\d+::.+?\}\}/.test(front)) { dropped.flashcards++; continue; }

    const key = foldWs(front);
    if (seenFronts.has(key)) { dropped.flashcards++; continue; }

    // A card is only kept if its evidence is really in the transcript.
    const evidence = clamp(c.evidence, 500);
    const loc = locateEvidence(evidence, segments, hint(c.t));
    if (!evidence || loc.score < 0.5) { dropped.flashcards++; continue; }
    // ...and, when the class is cut into ranges, if it comes from teaching content
    if (cardRanges && !cardRanges.some((r) => loc.startMs >= r.start_ms - RANGE_TOLERANCE_MS && loc.startMs <= r.end_ms + RANGE_TOLERANCE_MS)) {
      dropped.flashcards++;
      continue;
    }

    seenFronts.add(key);
    flashcards.push({
      kind, front, back,
      tag: clamp(c.tag, 40).replace(/\s+/g, '_'),
      t_ms: loc.startMs,
    });
    if (flashcards.length >= MAX_CARDS) break;
  }

  // ── glossary ──
  const terms = new Map<string, GlossaryInput>();
  for (const g of (raw.glossary ?? []).slice(0, MAX_TERMS * 2)) {
    const term = clamp(g.term, 80);
    if (!term) continue;
    const key = foldWs(term);
    if (terms.has(key)) continue;
    terms.set(key, { term, definition: clamp(g.definition, 400), t_ms: hint(g.t) });
    if (terms.size >= MAX_TERMS) break;
  }

  return { alerts, flashcards, glossary: [...terms.values()], dropped };
}

export class StudyGenerator {
  private client: GeminiClient;
  private logger?: Logger;

  constructor(options: { client: GeminiClient; logger?: Logger }) {
    this.client = options.client;
    this.logger = options.logger?.child({ component: 'study-generator' });
  }

  get model(): string {
    return this.client.model;
  }

  /** The whole class, or — when it is cut into ranges — each range under its label, without logistics. */
  private transcriptFor(segments: TranscriptSegment[], context: StudyContext): string {
    const plain = toTimestampedText(segments, { windowSeconds: 15 });
    if (!context.ranges?.length) return plain;
    const label: Record<NoteDestination, string> = {
      theory: 'TEORÍA', exam: 'EXAMEN', deliverable: 'TRABAJO', course_info: 'INFORMACIÓN DE LA ASIGNATURA', admin: 'LOGÍSTICA',
    };
    const parts = context.ranges
      .filter((r) => r.destination !== 'admin')
      .map((r) => {
        const body = rangeTranscript(segments, { ...r, ord: 0, heading: '' });
        return body ? `=== [${formatClock(r.start_ms / 1000)}–${formatClock(r.end_ms / 1000)}] ${label[r.destination]} ===\n${body}` : '';
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n\n') : plain;
  }

  async generate(segments: TranscriptSegment[], context: StudyContext): Promise<StudyOutput> {
    const transcript = this.transcriptFor(segments, context);
    if (!transcript.trim()) throw new Error('La transcripción está vacía; no hay nada que analizar.');
    if (transcript.length > MAX_INPUT_CHARS) throw new Error('La transcripción es demasiado larga para analizarla de una vez.');

    const classDate = localCalendarDate(context.classDate);
    const header = [
      `Asignatura: ${context.course || '(sin asignar)'}`,
      `Título: ${context.title}`,
      `Fecha de la clase: ${toIso(classDate)} (${weekdayName(classDate)})${
        context.classDateConfirmed === false ? ' — aproximada (fecha de transcripción); la clase pudo ser antes' : ''}`,
    ];
    if (context.glossary?.length) header.push(`Vocabulario conocido de la asignatura: ${context.glossary.slice(0, 80).join(', ')}`);

    const raw = await this.client.generateJson<RawStudy>(
      `${header.join('\n')}\n\nTRANSCRIPCIÓN:\n${transcript}`,
      STUDY_SCHEMA,
      { system: SYSTEM_PROMPT, temperature: 0.2 }
    );

    const out = validateStudyOutput(raw, segments, context);
    this.logger?.info(
      { alerts: out.alerts.length, flashcards: out.flashcards.length, glossary: out.glossary.length, dropped: out.dropped },
      'Extracción de estudio completada'
    );
    return out;
  }
}
