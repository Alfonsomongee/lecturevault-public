/**
 * Session analysis: one Gemini call per class that classifies the session by time ranges
 * (presentation, theory, project, exam, logistics), proposes a short title and extracts the
 * course sheet, grading, deliverables, exams, dated events, mentions and key moments as
 * schema-constrained JSON. Then strict local validation: nothing is routed unless it is grounded
 * in the transcript, and no date is kept unless its day was really spoken.
 *
 * Routing the validated result into the database is CampusRepository.applyAnalysis.
 */

import type { Logger } from 'pino';
import { GeminiClient } from '../ai/GeminiClient.js';
import { toTimestampedText, type TranscriptSegment } from '../library/transcript-files.js';
import type { Confidence } from '../database/StudyRepository.js';
import type {
  CourseProfileInput, EntityType, EventKind, MentionKind, NoteDestination, SyllabusEntry,
} from '../database/CampusRepository.js';
import type { SessionKind } from '../types.js';
import { contentTokens, locateEvidence } from '../study/grounding.js';
import {
  isDateBacked, localCalendarDate, resolveDateText, sanitizeDueDate, toIso, weekdayName, type CalendarDate,
} from '../study/dates.js';
import { formatClock, parseClock } from '../utils/time.js';
import { fold, foldWs } from '../utils/text.js';

export const ANALYSIS_PROMPT_VERSION = '3';

const MAX_INPUT_CHARS = 700_000;
const MAX_SECTIONS = 20;
const MAX_EVENTS = 30;
const MAX_MENTIONS = 60;
const MAX_HIGHLIGHTS = 8;
const MAX_TASKS = 6;
/** Gaps between ranges shorter than this are absorbed by the previous range instead of becoming "admin". */
const MIN_GAP_MS = 60_000;
/** A destination covering this share of the class names the session; otherwise it is "mixed". */
const DOMINANT_SHARE = 0.7;
/** A "logistics" range this long is suspect: it is checked against its own heading (see `isMislabelledAdmin`). */
const LONG_ADMIN_MS = 8 * 60_000;
/** Words that make a heading really about logistics (compared without accents). */
const ADMIN_HEADING = /\b(logistic\w*|audio|sonido|saludo\w*|bienvenid\w*|espera\w*|credencial\w*|foro|aviso\w*|planificacion|descanso|asistencia|tutoria\w*|aula virtual|problemas? tecnic\w*)\b/;

const SESSION_KINDS: SessionKind[] = ['presentation', 'theory', 'project', 'exam_review', 'lab', 'mixed'];
const DESTINATIONS: NoteDestination[] = ['theory', 'deliverable', 'exam', 'course_info', 'admin'];
const EVENT_KINDS: EventKind[] = ['exam', 'deadline', 'session', 'lab', 'other'];
const MENTION_KINDS: MentionKind[] = ['requirement', 'syllabus', 'format', 'date', 'tip', 'grading'];
const ENTITY_TYPES: EntityType[] = ['deliverable', 'exam', 'course'];

const KIND_OF_DESTINATION: Partial<Record<NoteDestination, SessionKind>> = {
  course_info: 'presentation', theory: 'theory', deliverable: 'project', exam: 'exam_review',
};

const DEFAULT_HEADING: Record<NoteDestination, string> = {
  theory: 'Teoría', deliverable: 'Trabajo', exam: 'Examen', course_info: 'Presentación de la asignatura', admin: 'Logística',
};

// ── Schema and prompt ───────────────────────────────────────────────────────

const evidenceProps = { evidence: { type: 'STRING' }, t: { type: 'STRING' } };

export const ANALYSIS_SCHEMA = {
  type: 'OBJECT',
  // Classify before extracting: the order of generation follows this list
  propertyOrdering: ['session_kind', 'title_summary', 'topic', 'sections', 'course_info',
                     'grading', 'deliverables', 'exams', 'events', 'mentions', 'tasks', 'highlights'],
  properties: {
    session_kind: { type: 'STRING', enum: SESSION_KINDS },
    title_summary: { type: 'STRING' },
    topic: { type: 'STRING' },
    sections: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      start: { type: 'STRING' }, end: { type: 'STRING' },
      destination: { type: 'STRING', enum: DESTINATIONS },
      entity_key: { type: 'STRING' },
      heading: { type: 'STRING' } }, required: ['start', 'end', 'destination', 'heading'] } },
    course_info: { type: 'OBJECT', nullable: true, properties: {
      overview: { type: 'STRING' }, teacher: { type: 'STRING' }, schedule: { type: 'STRING' },
      pass_rules: { type: 'STRING' },
      syllabus: { type: 'ARRAY', items: { type: 'STRING' } },
      resources: { type: 'ARRAY', items: { type: 'STRING' } },
      ...evidenceProps } },
    grading: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      name: { type: 'STRING' }, weight_pct: { type: 'NUMBER', nullable: true },
      parent: { type: 'STRING' }, entity_key: { type: 'STRING' },
      ...evidenceProps }, required: ['name', 'evidence', 't'] } },
    deliverables: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      key: { type: 'STRING' }, title: { type: 'STRING' }, description: { type: 'STRING' },
      format: { type: 'STRING' }, group_size: { type: 'STRING' },
      ...evidenceProps }, required: ['key', 'title', 'evidence', 't'] } },
    exams: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      key: { type: 'STRING' }, title: { type: 'STRING' }, format: { type: 'STRING' },
      ...evidenceProps }, required: ['key', 'title', 'evidence', 't'] } },
    events: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      kind: { type: 'STRING', enum: EVENT_KINDS },
      entity_key: { type: 'STRING' }, title: { type: 'STRING' },
      date_text: { type: 'STRING' },
      date: { type: 'STRING', nullable: true },
      time: { type: 'STRING', nullable: true },
      ...evidenceProps,
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] } },
      required: ['kind', 'title', 'date_text', 'evidence', 't'] } },
    mentions: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      entity_type: { type: 'STRING', enum: ENTITY_TYPES },
      entity_key: { type: 'STRING' },
      kind: { type: 'STRING', enum: MENTION_KINDS },
      text: { type: 'STRING' }, ...evidenceProps },
      required: ['entity_type', 'kind', 'text', 'evidence', 't'] } },
    tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: { type: 'STRING' }, ...evidenceProps }, required: ['text', 'evidence', 't'] } },
    highlights: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      t: { type: 'STRING' }, title: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['t', 'title'] } },
  },
  required: ['session_kind', 'title_summary', 'sections', 'events', 'mentions', 'highlights'],
};

export const ANALYSIS_SYSTEM_PROMPT = `Eres el organizador del campus virtual de un estudiante de ingeniería.
Recibes la transcripción (con marcas de tiempo [mm:ss]) de UNA clase y el contexto de su asignatura. Devuelve únicamente JSON que cumpla el esquema. No inventes nada: si un dato no se dice en la clase, déjalo vacío.

1. Clasifica primero. Divide la clase en tramos contiguos (máximo 12) que cubran toda la sesión, con "start" y "end" en formato mm:ss o h:mm:ss, y asigna a cada uno un "destination":
   - "course_info": presentación de la asignatura, evaluación, normas, calendario general.
   - "deliverable": el tramo explica un trabajo, proyecto o práctica concreto. Indica su "entity_key".
   - "exam": qué entra en el examen, su formato o su fecha, o un repaso para el examen. Indica su "entity_key".
   - "theory": contenido de la materia que se estudia y se evalúa, incluidas las demostraciones prácticas de un programa o herramienta (ANSYS, LTSpice, MATLAB…), los ejercicios resueltos en directo y los ejemplos paso a paso: aunque se hagan con la pantalla compartida, son materia de estudio.
   - "admin": logística sin valor de estudio (audio, saludos, esperas, credenciales, organización del aula). Nunca un tramo en el que se explica o se hace algo de la materia, por largo que sea; un tramo de logística rara vez dura más de unos minutos.
   "heading" es un título corto del tramo. "session_kind" es el destino dominante (presentation, theory, project, exam_review), "lab" si es una práctica guiada, o "mixed" si ninguno supera el 70 % del tiempo.
2. "title_summary": entre 3 y 5 palabras que describan el CONTENIDO de la clase (si la mitad es teoría, nómbrala: por ejemplo "Evaluación y fundamentos de mecanismos"). No empieces por "Clase", no pongas punto final ni comillas.
3. "topic": el tema del temario al que pertenece la teoría de la clase, tal como aparece en el temario conocido (o en el que se presente en esta clase). "" si no está claro.
4. Fechas ("events"): copia en "date_text" la expresión literal ("18 de octubre a las 23:59") y en "evidence" la frase donde se dijo. Rellena "date" (YYYY-MM-DD) solo si el día Y el mes se dicen explícitamente; usa el curso académico para el año. Si falta el número del día ("el día de noviembre") deja "date" en null y pon "confidence" en "low". Nunca completes un dato que no se haya dicho. "time" en HH:MM solo si se dice la hora. "deadline" es solo un día en que hay que entregar algo: la apertura o publicación de una actividad es "other". Un hito intermedio de un trabajo (presentar, elegir, entregar una parte) es un evento propio con su propio título, no otra fecha de la entrega final. Un control o "examencito" sin nota es un evento propio sin "entity_key" de convocatoria.
5. Entidades: reutiliza las keys conocidas si se habla de lo mismo. Crea una key nueva (kebab-case, por ejemplo "proyecto-parte-1") solo si es un trabajo o examen distinto. Una convocatoria ordinaria y una extraordinaria son exámenes distintos. Cada trabajo y examen que se mencione va en "deliverables" o "exams"; sus fechas van además en "events" con su "entity_key". En "exams" va solo una prueba concreta que se va a hacer: las preguntas de ejemplo o tipo examen son "mentions".
6. "mentions": cualquier requisito, formato, rúbrica, consejo o "esto entra o no entra" sobre un trabajo, un examen o la asignatura ("entity_type" "course"), aunque la clase sea de teoría. Una idea por mención.
7. "course_info" solo si hay un tramo "course_info" con información general real de la asignatura (profesor, horario, descripción, temario, reglas de aprobado, recursos). Si no, null. "teacher" es solo un nombre propio; "schedule" solo días y horas fijos; "syllabus" solo títulos reales de tema, no "capítulo 2". Si no se dice, déjalo vacío en lugar de explicar por qué falta.
8. "grading": criterios de evaluación con su peso en % ("parent" si es una parte de otro criterio; "entity_key" si corresponde a un trabajo o examen).
9. "highlights": entre 3 y 8 momentos clave de la clase ("t", "title" corto y "why": por qué importa).
10. "tasks": lo que el profesor pide expresamente al alumno que haga pronto o antes de la próxima clase (descargar un programa, leer un capítulo, formar grupo, activar credenciales, traer algo). Máximo 6, una acción por tarea, empezando por un verbo en infinitivo ("Descargar GIM con las credenciales de la universidad"). No incluyas entregas con fecha (van en "events"), consejos generales (van en "mentions") ni lo que se hace durante la propia clase. Si no pide nada, deja la lista vacía.
En todos los elementos, "evidence" es una cita literal y corta de la transcripción, sin cambiar palabras, y "t" su marca mm:ss.
Escribe en español.`;

export interface KnownEntity {
  key: string;
  title: string;
}

export interface AnalysisContext {
  title: string;
  /** Catalog label of the course ('' when unassigned) */
  course: string;
  classNumber: number | null;
  /** ISO timestamp or YYYY-MM-DD of the class (anchor for relative dates) */
  classDate: string;
  classDateConfirmed?: boolean;
  durationSeconds: number;
  profileExists?: boolean;
  syllabus?: SyllabusEntry[];
  known?: { deliverables: KnownEntity[]; exams: KnownEntity[] };
  glossary?: string[];
}

/** Sept–Aug academic year that contains the class day. */
export function academicYear(classDate: CalendarDate): { start: string; end: string } {
  const y = classDate.m >= 9 ? classDate.y : classDate.y - 1;
  return { start: `${y}-09-01`, end: `${y + 1}-08-31` };
}

export function buildAnalysisPrompt(transcript: string, context: AnalysisContext): string {
  const classDate = localCalendarDate(context.classDate);
  const year = academicYear(classDate);
  const known = context.known ?? { deliverables: [], exams: [] };
  const list = (items: KnownEntity[]) => (items.length ? items.map((e) => `${e.key} «${e.title}»`).join(', ') : '(ninguno)');
  const lines = [
    `Asignatura: ${context.course || '(sin asignar)'}`,
    `Título original: ${context.title}`,
    `Número de clase: ${context.classNumber ?? 'desconocido'} · Fecha de la clase: ${toIso(classDate)} (${weekdayName(classDate)})${
      context.classDateConfirmed === false ? ' (sin confirmar: es la fecha de transcripción; la clase pudo ser antes)' : ''}`,
    `Curso académico: ${year.start} → ${year.end}`,
    `Ficha existente: ${context.profileExists ? 'sí' : 'no'}`,
    `Temario conocido: ${context.syllabus?.length ? context.syllabus.map((s) => `Tema ${s.n}. ${s.title}`).join(' · ') : '(vacío)'}`,
    'Entidades conocidas (usa estas keys si hablan de lo mismo):',
    `  deliverables: ${list(known.deliverables)}`,
    `  exams: ${list(known.exams)}`,
  ];
  if (context.glossary?.length) lines.push(`Vocabulario conocido de la asignatura: ${context.glossary.slice(0, 80).join(', ')}`);
  return `${lines.join('\n')}\n\nTRANSCRIPCIÓN:\n${transcript}`;
}

// ── Raw model output ────────────────────────────────────────────────────────

interface RawEvidence { evidence?: string; t?: string }
interface RawSection { start?: string; end?: string; destination?: string; entity_key?: string; heading?: string }
interface RawCourseInfo extends RawEvidence {
  overview?: string; teacher?: string; schedule?: string; pass_rules?: string; syllabus?: string[]; resources?: string[];
}
interface RawGrading extends RawEvidence { name?: string; weight_pct?: number | null; parent?: string; entity_key?: string }
interface RawDeliverable extends RawEvidence { key?: string; title?: string; description?: string; format?: string; group_size?: string }
interface RawExam extends RawEvidence { key?: string; title?: string; format?: string }
interface RawEvent extends RawEvidence {
  kind?: string; entity_key?: string; title?: string; date_text?: string; date?: string | null; time?: string | null; confidence?: string;
}
interface RawMention extends RawEvidence { entity_type?: string; entity_key?: string; kind?: string; text?: string }
interface RawHighlight { t?: string; title?: string; why?: string }

export interface RawAnalysis {
  session_kind?: string;
  title_summary?: string;
  topic?: string;
  sections?: RawSection[];
  course_info?: RawCourseInfo | null;
  grading?: RawGrading[];
  deliverables?: RawDeliverable[];
  exams?: RawExam[];
  events?: RawEvent[];
  mentions?: RawMention[];
  tasks?: (RawEvidence & { text?: string })[];
  highlights?: RawHighlight[];
}

// ── Validated analysis ──────────────────────────────────────────────────────

export interface Grounded {
  quote: string;
  t_ms: number;
}

export interface AnalysisSection {
  start_ms: number;
  end_ms: number;
  destination: NoteDestination;
  entity_type: 'deliverable' | 'exam' | null;
  entity_key: string | null;
  heading: string;
}

export interface AnalysisEvent extends Grounded {
  kind: EventKind;
  entity_type: 'deliverable' | 'exam' | null;
  entity_key: string | null;
  title: string;
  date: string | null;
  time: string | null;
  date_text: string;
  confidence: Confidence;
  /** A date the model gave but the transcript does not back: it goes to review, not to the calendar */
  claimed_date: string | null;
}

export interface AnalysisMention extends Grounded {
  entity_type: EntityType;
  /** null for course mentions */
  entity_key: string | null;
  kind: MentionKind;
  text: string;
  confidence: Confidence;
}

export interface AnalysisGrading extends Grounded {
  name: string;
  weight_pct: number | null;
  parent: string | null;
  entity_type: 'deliverable' | 'exam' | null;
  entity_key: string | null;
}

export interface AnalysisDeliverable extends Grounded {
  key: string;
  title: string;
  description: string;
  format: string;
  group_size: string;
}

export interface AnalysisExam extends Grounded {
  key: string;
  title: string;
  format: string;
}

export interface SessionAnalysis {
  session_kind: SessionKind;
  /** 3–5 words, already cleaned; the title is `Clase N. ${title_summary}` */
  title_summary: string | null;
  topic: string;
  sections: AnalysisSection[];
  course_info: (CourseProfileInput & Grounded) | null;
  grading: AnalysisGrading[];
  deliverables: AnalysisDeliverable[];
  exams: AnalysisExam[];
  events: AnalysisEvent[];
  mentions: AnalysisMention[];
  tasks: (Grounded & { text: string })[];
  highlights: { t_ms: number; text: string; why: string }[];
  dropped: { sections: number; events: number; mentions: number; grading: number; entities: number };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** What a model writes when it has nothing to say: "null", "no especificado"… */
export function isPlaceholderText(text: string): boolean {
  return /^(null|none|undefined|n\/?a|ninguno|ninguna|no aplica|no disponible|no (se )?(especifica|especificado|menciona|mencionado|indica|indicado))\.?$/.test(fold(text).trim());
}

function clamp(text: unknown, max: number): string {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  return isPlaceholderText(clean) ? '' : clean;
}

export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A person's name or nothing: "Profesor no nombrado explícitamente…" must not reach the fixed sheet. */
export function cleanTeacher(raw: unknown): string {
  const text = clamp(raw, 120);
  const folded = fold(text);
  if (/^(?:el|la)?\s*(?:profesor|profesora|docente|tutor|tutora)\.?$/.test(folded)) return '';
  if (/\b(no\s+(se\s+)?(nombra|menciona|indica|especifica|dice)|desconocid|sin nombre|se presenta|explicitamente)/.test(folded)) return '';
  return text.split(' ').length <= 6 && /\p{Lu}/u.test(text) ? text : '';
}

/** A fixed timetable says a weekday or an hour; "en el siguiente mes" or "el próximo martes" do not qualify. */
export function cleanSchedule(raw: unknown): string {
  const text = clamp(raw, 200);
  const folded = fold(text);
  if (/\b(proxim[oa]s?|siguiente|que viene)\b/.test(folded)) return '';
  const fixed = /\b(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/.test(folded) || /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*h\b/.test(folded);
  return fixed ? text : '';
}

/** "capítulo 2" alone says nothing about what the block covers. */
export function isRealSyllabusTitle(title: string): boolean {
  return !/^(capitulo|tema|unidad|bloque|modulo|parte)\s*\d+\.?$/.test(fold(title).trim());
}

/**
 * A topic name as a heading: the course guide lists each block with its sub-topics in brackets
 * ("Diseño de circuitos (Amplificadores y filtros, Lógica…)"), which makes labels run for lines.
 */
export function shortSyllabusTitle(title: string): string {
  const short = title.replace(/\s*\([^)]*\)?/g, ' ').replace(/\s+/g, ' ').replace(/[\s.:;,-]+$/, '').trim();
  return short.length >= 6 ? short : title.trim();
}

/** An exam is something you will sit; "Preguntas tipo examen" is study material, not a date to prepare for. */
export function isExamSitting(title: string): boolean {
  return !/^(ejemplos?|preguntas?|ejercicios?|dudas?|repaso)\b|preguntas?\s+(tipo|de)\s+examen/.test(fold(title).trim());
}

/**
 * "Próxima sesión" is the teacher saying goodbye, not a date worth keeping: the university's own timetable
 * already lists every class, and the AI's copy (a weekday guess, no time) only duplicates it.
 */
export function isNextSessionNoise(kind: string, title: string): boolean {
  return kind === 'session' && /^(la\s+)?(proxim[ao]|siguiente)\s+(sesion|clase|tutoria|reunion)\b/.test(fold(title).trim());
}

/** Opening an activity is not handing anything in. */
export function isOpeningEvent(title: string): boolean {
  return /^(apertura|publicacion|inicio|comienzo)\b/.test(fold(title).trim());
}

export interface EventIdentity {
  kind: string;
  title: string;
  date: string | null;
  deliverable_id?: number | null;
  exam_id?: number | null;
}

/**
 * The same date said again: same kind and title, on the same day or with no day at all. A date-less
 * event also repeats its exam when that exam has a date: an exam is one sitting, while a deliverable
 * can have several milestones ("Práctica grupo A" and "Práctica grupo D" are not the same date).
 */
export function isRepeatedEvent(event: EventIdentity, others: EventIdentity[]): boolean {
  return others.some((o) => {
    if (o.kind === event.kind && sameEntityTitle(o.title, event.title) && (!event.date || o.date === event.date)) return true;
    return !event.date && !!o.date && event.exam_id != null && o.exam_id === event.exam_id;
  });
}

/**
 * The syllabus block a topic names: by title (in either direction), or by number ("Tema 2"). A number only
 * counts when the topic has no name of its own or its name shares a word with the block: in 04MUIN the
 * teacher's "Tema 2.2. Instrumentación" is not block 2 "Lógica combinacional" of an incomplete syllabus.
 */
export function findSyllabusBlock(topic: string, syllabus: SyllabusEntry[]): SyllabusEntry | undefined {
  const t = foldWs(topic);
  const byTitle = syllabus.find((s) => t.includes(foldWs(s.title)) || foldWs(s.title).includes(t));
  if (byTitle) return byTitle;
  const ownName = new Set(contentTokens(topic.replace(/^\s*tema\s*\d+(?:[.,]\d+)*\s*[.:\-–]?\s*/i, '')));
  return syllabus.find((s) => {
    if (!new RegExp(`\\btema\\s*0?${s.n}\\b`).test(t)) return false;
    return ownName.size === 0 || contentTokens(s.title).some((w) => ownName.has(w));
  });
}

export const syllabusLabel = (block: SyllabusEntry) => `Tema ${block.n}. ${sentenceCase(block.title)}`;

/**
 * One name per topic of a course: its syllabus block, or the wording another class used for the same
 * thing ("Marco jurídico de la empresa" and "Tema 1. Marco jurídico" are one group). Pure, so grouping
 * old classes costs no Gemini call.
 */
export function canonicalTopics(topics: string[], syllabus: SyllabusEntry[] = []): Map<string, string> {
  const bare = (t: string) => foldWs(t.replace(/^tema\s*\d+\s*[.:\-–]?\s*/i, ''));
  const similar = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
  const ordered = [...new Set(topics.filter(Boolean))].sort((a, b) => Number(/^tema/i.test(b)) - Number(/^tema/i.test(a)));
  const names = new Map<string, string>();
  for (const topic of ordered) {
    const block = findSyllabusBlock(topic, syllabus);
    const twin = ordered.find((o) => names.has(o) && similar(bare(o), bare(topic)));
    names.set(topic, block ? syllabusLabel(block) : twin ? names.get(twin)! : topic);
  }
  return names;
}

function stripStamp(t: unknown): string {
  return typeof t === 'string' ? t.replace(/[[\]\s]/g, '') : '';
}

/** Kebab-case key: "Proyecto Parte 1" → "proyecto-parte-1" */
export function slugKey(value: string): string {
  return fold(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const ORDINALS: Record<string, string> = {
  primera: '1', primer: '1', primero: '1', segunda: '2', segundo: '2', tercera: '3', tercer: '3', tercero: '3',
  cuarta: '4', cuarto: '4', ordinaria: 'ord', extraordinaria: 'ext',
};

/** Numbers, call names and groups that make two otherwise equal titles different things ("parte 1" vs "parte 2", "grupo A" vs "grupo D"). */
function distinguishers(title: string): string {
  const folded = fold(title);
  const words = folded.match(/[a-z]+|\d+/g) ?? [];
  const groups = [...folded.matchAll(/\bgrupos?\s+([a-z])\b/g)].map((m) => `grupo-${m[1]}`);
  return [...new Set([...words.map((w) => (/^\d+$/.test(w) ? String(+w) : ORDINALS[w])), ...groups].filter(Boolean))].sort().join(',');
}

/** Same entity when the titles share most content words and no number or call tells them apart. */
export function sameEntityTitle(a: string, b: string): boolean {
  if (distinguishers(a) !== distinguishers(b)) return false;
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  ta.forEach((t) => { if (tb.has(t)) shared++; });
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

/** The call an exam title names: "1ª convocatoria", "Convocatoria 2", "segunda convocatoria", "ordinaria". */
export function examCall(title: string): string | null {
  const t = fold(title);
  const digit = /\b(\d)\s*\.?\s*(?:ra|da|a|o|ª|º)?\s*convocatoria\b/.exec(t) ?? /\bconvocatoria\s*(\d)\b/.exec(t);
  if (digit) return digit[1]!;
  // Only a call: "primer examencito" is not the first call of the final
  if (/\b(extraordinaria|segunda\s+convocatoria|2da)\b/.test(t)) return '2';
  if (/\b(ordinaria|primera\s+convocatoria|1ra)\b/.test(t)) return '1';
  return null;
}

/** Numbers, ordinals and groups of a title, shared words aside: what tells "Actividad 1" from "Actividad 2". */
const hasDistinguisher = (title: string) => distinguishers(title) !== '';

/**
 * The same thing on the calendar said by two sources (the class and the university), which may disagree
 * on the day: exams by their call, anything else by an equal title or by the same numbers and groups
 * with a word in common. Wording that differs altogether ("Presentación del proyecto" and "Entrega
 * proyecto parte 1") is not guessed: two sources that cannot be told to be one stay two.
 */
export function sameCalendarThing(left: { kind: string; title: string }, right: { kind: string; title: string }): boolean {
  if (left.kind !== right.kind || !['exam', 'deadline', 'lab'].includes(left.kind)) return false;
  // The campus writes the course code into its titles ("Práctica 04MUIN Grupo B"); the class never does
  const bare = (title: string) => title.replace(/\b\d{2}[a-z]{4,6}\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const [a, b] = [bare(left.title), bare(right.title)];
  if (left.kind === 'exam') {
    const [ca, cb] = [examCall(a), examCall(b)];
    if (ca && cb) return ca === cb && isExamSitting(a) && isExamSitting(b);
  }
  if (sameEntityTitle(a, b)) return true;
  if (!hasDistinguisher(a) || distinguishers(a) !== distinguishers(b)) return false;
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  let shared = 0;
  ta.forEach((t) => { if (tb.has(t)) shared++; });
  return shared >= 1 && shared / (ta.size + tb.size - shared) >= 0.25;
}

/** Words a title may contain but not start or end with */
const CONNECTORS = new Set(['del', 'las', 'los', 'con', 'por', 'para', 'sin', 'una', 'sus', 'que']);
const isConnector = (word: string) => word.length <= 2 || CONNECTORS.has(fold(word));

/**
 * Clean the model's 3–5 word summary: no quotes, no "Clase N", no final period, no dangling
 * connectors, first letter upper case. Too long is cut to 5 words; too short returns null.
 */
export function normalizeTitleSummary(raw: unknown): string | null {
  let text = clamp(raw, 200)
    .replace(/["'«»“”‘’]/g, '')
    .replace(/^clase\s*\d*\s*[.:\-–—]?\s*/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
  let words = text.split(/\s+/).filter(Boolean);
  const trim = () => {
    while (words.length && isConnector(words[0]!)) words.shift();
    while (words.length && isConnector(words[words.length - 1]!)) words.pop();
  };
  trim();
  if (words.length > 5) {
    words = words.slice(0, 5);
    trim();
  }
  if (words.length < 3) return null;
  text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function classTitle(classNumber: number | null, summary: string): string {
  return classNumber ? `Clase ${classNumber}. ${summary}` : summary;
}

const NUMBER_WORDS: Record<number, string[]> = {
  5: ['cinco'], 10: ['diez'], 15: ['quince'], 20: ['veinte'], 25: ['veinticinco'], 30: ['treinta'],
  35: ['treinta y cinco'], 40: ['cuarenta'], 45: ['cuarenta y cinco'], 50: ['cincuenta', 'mitad'],
  60: ['sesenta'], 70: ['setenta'], 75: ['setenta y cinco'], 80: ['ochenta'], 90: ['noventa'], 100: ['cien', 'ciento'],
};

/** True when the spoken text really says the number (as digits or, for round numbers, in words). */
export function isNumberBacked(n: number, text: string): boolean {
  const t = fold(text);
  if (new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(t)) return true;
  return (NUMBER_WORDS[n] ?? []).some((w) => new RegExp(`\\b${w}\\b`).test(t));
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Validate and ground the model's analysis. Pure function: all the trust logic lives here. */
export function validateAnalysis(raw: RawAnalysis, segments: TranscriptSegment[], context: AnalysisContext): SessionAnalysis {
  const classDate = localCalendarDate(context.classDate);
  const dateOptions = { classDateConfirmed: context.classDateConfirmed ?? true };
  const durationMs = Math.round(Math.max(context.durationSeconds, segments[segments.length - 1]?.end ?? 0) * 1000);
  const toMs = (t: unknown): number | null => {
    const seconds = parseClock(stripStamp(t));
    return seconds === null ? null : Math.min(Math.max(seconds * 1000, 0), durationMs);
  };
  const dropped = { sections: 0, events: 0, mentions: 0, grading: 0, entities: 0 };

  /** Locate a quote; null when it is not in the transcript at all. */
  const ground = (item: RawEvidence, fallback = ''): (Grounded & { score: number }) | null => {
    const quote = clamp(item.evidence, 400);
    const loc = locateEvidence(quote || fallback, segments, toMs(item.t) ?? 0);
    return loc.score < 0.2 ? null : { quote, t_ms: loc.startMs, score: loc.score };
  };
  /** What was really said around a moment: the only text a date or a number may come from. */
  const spokenAround = (ms: number) =>
    segments.filter((s) => s.end * 1000 >= ms - 5_000 && s.start * 1000 <= ms + 40_000).map((s) => s.text).join(' ');

  // ── entities: canonical keys, reusing known ones ──
  const known = context.known ?? { deliverables: [], exams: [] };
  const aliases = { deliverable: new Map<string, string>(), exam: new Map<string, string>() };
  for (const e of known.deliverables) aliases.deliverable.set(e.key, e.key);
  for (const e of known.exams) aliases.exam.set(e.key, e.key);

  const canonical = (type: 'deliverable' | 'exam', rawKey: unknown, title: string, pool: KnownEntity[]): string | null => {
    const key = slugKey(typeof rawKey === 'string' && rawKey ? rawKey : title);
    if (!key) return null;
    if (aliases[type].has(key)) return aliases[type].get(key)!;
    const match = title ? pool.find((e) => sameEntityTitle(e.title, title)) : undefined;
    const resolved = match ? match.key : key;
    aliases[type].set(key, resolved);
    return resolved;
  };

  const deliverables = new Map<string, AnalysisDeliverable>();
  for (const d of (raw.deliverables ?? []).slice(0, 30)) {
    const title = clamp(d.title, 200);
    const g = title ? ground(d, title) : null;
    const key = g ? canonical('deliverable', d.key, title, [...known.deliverables, ...deliverables.values()]) : null;
    if (!g || !key) { dropped.entities++; continue; }
    if (deliverables.has(key)) continue;
    deliverables.set(key, {
      key, title, quote: g.quote, t_ms: g.t_ms,
      description: clamp(d.description, 1000), format: clamp(d.format, 200), group_size: clamp(d.group_size, 80),
    });
  }

  const exams = new Map<string, AnalysisExam>();
  const notExams = new Set<string>();
  for (const e of (raw.exams ?? []).slice(0, 12)) {
    const title = clamp(e.title, 200);
    if (title && !isExamSitting(title)) {
      notExams.add(slugKey(typeof e.key === 'string' && e.key ? e.key : title));
      dropped.entities++;
      continue;
    }
    const g = title ? ground(e, title) : null;
    const key = g ? canonical('exam', e.key, title, [...known.exams, ...exams.values()]) : null;
    if (!g || !key) { dropped.entities++; continue; }
    if (exams.has(key)) continue;
    exams.set(key, { key, title, quote: g.quote, t_ms: g.t_ms, format: clamp(e.format, 300) });
  }

  /** A reference is valid only to an entity this class declared or the course already has. */
  const exists = (type: 'deliverable' | 'exam', key: string) =>
    type === 'deliverable'
      ? deliverables.has(key) || known.deliverables.some((e) => e.key === key)
      : exams.has(key) || known.exams.some((e) => e.key === key);
  const resolveRef = (rawKey: unknown, preferred?: 'deliverable' | 'exam'): { type: 'deliverable' | 'exam'; key: string } | null => {
    if (typeof rawKey !== 'string' || !rawKey.trim()) return null;
    const slug = slugKey(rawKey);
    const order: ('deliverable' | 'exam')[] = preferred === 'exam' ? ['exam', 'deliverable'] : ['deliverable', 'exam'];
    for (const type of order) {
      const key = aliases[type].get(slug) ?? slug;
      if (exists(type, key)) return { type, key };
    }
    return null;
  };

  // ── sections: sorted, clamped, no overlaps, no holes ──
  const parsed: AnalysisSection[] = [];
  for (const s of (raw.sections ?? []).slice(0, MAX_SECTIONS * 2)) {
    let destination = DESTINATIONS.find((d) => d === s.destination);
    const start = toMs(s.start);
    if (!destination || start === null) { dropped.sections++; continue; }
    let ref: ReturnType<typeof resolveRef> = null;
    if (destination === 'deliverable' || destination === 'exam') {
      ref = resolveRef(s.entity_key, destination);
      // A project/exam range about nothing we can identify is still course information
      if (!ref) destination = 'course_info';
      else destination = ref.type;
    }
    parsed.push({
      start_ms: start,
      end_ms: toMs(s.end) ?? -1,
      destination,
      entity_type: ref?.type ?? null,
      entity_key: ref?.key ?? null,
      heading: clamp(s.heading, 120) || DEFAULT_HEADING[destination],
    });
  }
  const sections = normalizeSections(promoteStudyAdmin(normalizeSections(parsed, durationMs)), durationMs).slice(0, MAX_SECTIONS);

  // ── session kind: measured on the ranges, not taken from the model ──
  const modelKind = SESSION_KINDS.find((k) => k === raw.session_kind) ?? 'mixed';
  let session_kind: SessionKind = modelKind;
  if (sections.length > 0 && modelKind !== 'lab') {
    const share = new Map<NoteDestination, number>();
    for (const s of sections) share.set(s.destination, (share.get(s.destination) ?? 0) + (s.end_ms - s.start_ms));
    const total = sections[sections.length - 1]!.end_ms - sections[0]!.start_ms || 1;
    const [top, ms] = [...share.entries()].sort((a, b) => b[1] - a[1])[0]!;
    session_kind = ms / total >= DOMINANT_SHARE ? KIND_OF_DESTINATION[top] ?? 'mixed' : 'mixed';
  }

  // ── title: 3–5 words, or the heading of the longest content range ──
  const longest = [...sections].filter((s) => s.destination !== 'admin').sort((a, b) => (b.end_ms - b.start_ms) - (a.end_ms - a.start_ms))[0];
  const title_summary = normalizeTitleSummary(raw.title_summary) ?? (longest ? normalizeTitleSummary(longest.heading) : null);

  // ── course sheet: only from a real presentation range ──
  let course_info: SessionAnalysis['course_info'] = null;
  const ci = raw.course_info;
  if (ci && sections.some((s) => s.destination === 'course_info')) {
    const g = ground(ci, [ci.teacher, ci.schedule, ci.pass_rules].filter(Boolean).join(' '));
    if (g) {
      const syllabus: SyllabusEntry[] = [];
      for (const item of (ci.syllabus ?? []).slice(0, 30)) {
        const text = clamp(item, 200);
        const numbered = /^(?:tema\s*)?(\d{1,2})\s*[.:\-–)]\s*(.+)$/i.exec(text);
        const title = shortSyllabusTitle(numbered ? numbered[2]!.trim() : text);
        if (title && isRealSyllabusTitle(title)) syllabus.push({ n: numbered ? +numbered[1]! : syllabus.length + 1, title });
      }
      course_info = {
        overview_md: sentenceCase(clamp(ci.overview, 2000)),
        // Better empty than a placeholder on the fixed sheet
        teacher: cleanTeacher(ci.teacher),
        schedule: cleanSchedule(ci.schedule),
        pass_rules: sentenceCase(clamp(ci.pass_rules, 400)),
        syllabus,
        resources: (ci.resources ?? []).map((r) => sentenceCase(clamp(r, 200))).filter(Boolean).slice(0, 20),
        quote: g.quote,
        t_ms: g.t_ms,
      };
    }
  }

  // ── topic: must be one of the syllabus blocks when the syllabus is known (from this class if it presents it) ──
  let topic = clamp(raw.topic, 120);
  const syllabusKnown = context.syllabus?.length ? context.syllabus : course_info?.syllabus ?? [];
  if (topic && syllabusKnown.length) {
    const block = findSyllabusBlock(topic, syllabusKnown);
    topic = block ? syllabusLabel(block) : '';
  }

  // ── grading: grounded, and a weight only if the number was said ──
  const grading: AnalysisGrading[] = [];
  for (const item of (raw.grading ?? []).slice(0, 30)) {
    const name = clamp(item.name, 120);
    const g = name ? ground(item, name) : null;
    if (!g) { dropped.grading++; continue; }
    const weight = typeof item.weight_pct === 'number' && item.weight_pct > 0 && item.weight_pct <= 100 ? item.weight_pct : null;
    const ref = resolveRef(item.entity_key);
    grading.push({
      name, quote: g.quote, t_ms: g.t_ms,
      weight_pct: weight !== null && isNumberBacked(weight, `${g.quote} ${spokenAround(g.t_ms)}`) ? weight : null,
      parent: clamp(item.parent, 120) || null,
      entity_type: ref?.type ?? null,
      entity_key: ref?.key ?? null,
    });
    if (grading.length >= 20) break;
  }

  // ── events: the spoken words decide the date, never the model ──
  const events: AnalysisEvent[] = [];
  for (const e of (raw.events ?? []).slice(0, MAX_EVENTS * 2)) {
    const modelEventKind = EVENT_KINDS.find((k) => k === e.kind);
    const title = clamp(e.title, 200);
    const kind = modelEventKind === 'deadline' && isOpeningEvent(title) ? 'other' : modelEventKind;
    const g = kind && title && (kind !== 'exam' || isExamSitting(title)) ? ground(e, title) : null;
    if (!kind || !g || isNextSessionNoise(kind, title)) { dropped.events++; continue; }

    const dateText = clamp(e.date_text, 120);
    const spoken = spokenAround(g.t_ms);
    let confidence: Confidence = e.confidence === 'high' || e.confidence === 'low' ? e.confidence : 'medium';

    // The literal phrase, resolved here, beats the model's ISO date. Either way the day must
    // appear in what was really said there: this is what stops "el día de noviembre" → 20 nov.
    let candidate: string | null = null;
    const resolved = dateText ? resolveDateText(dateText, classDate, dateOptions) : null;
    if (resolved) {
      candidate = resolved.date;
      if (resolved.confidence === 'medium' && confidence === 'high') confidence = 'medium';
    } else {
      candidate = sanitizeDueDate(e.date, classDate, dateOptions);
    }
    const backed = candidate !== null && isDateBacked(candidate, spoken);
    const date = backed ? candidate : null;
    const claimed_date = candidate !== null && !backed ? candidate : null;
    if (!date) confidence = 'low';
    if (date && !dateOptions.classDateConfirmed && confidence === 'high') confidence = 'medium';
    if (g.score < 0.5) confidence = 'low';

    const time = typeof e.time === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(e.time.trim()) ? e.time.trim().padStart(5, '0') : null;
    const ref = resolveRef(e.entity_key, kind === 'exam' ? 'exam' : 'deliverable');
    events.push({
      kind, title, quote: g.quote, t_ms: g.t_ms, date, claimed_date, date_text: dateText, confidence,
      time: date && time && isNumberBacked(+time.slice(0, 2), `${dateText} ${spoken}`) ? time : null,
      entity_type: ref?.type ?? null,
      entity_key: ref?.key ?? null,
    });
    if (events.length >= MAX_EVENTS) break;
  }

  // ── mentions ──
  const mentions: AnalysisMention[] = [];
  for (const m of (raw.mentions ?? []).slice(0, MAX_MENTIONS * 2)) {
    // What was said about "Preguntas tipo examen" is still worth keeping, on the course
    const aboutNotExam = m.entity_type === 'exam' && notExams.has(slugKey(String(m.entity_key ?? '')));
    const entity_type = aboutNotExam ? 'course' : ENTITY_TYPES.find((t) => t === m.entity_type);
    const kind = MENTION_KINDS.find((k) => k === m.kind);
    const text = clamp(m.text, 400);
    const g = entity_type && kind && text ? ground(m, text) : null;
    if (!entity_type || !kind || !g) { dropped.mentions++; continue; }
    let entity_key: string | null = null;
    if (entity_type !== 'course') {
      const ref = resolveRef(m.entity_key, entity_type);
      if (!ref || ref.type !== entity_type) { dropped.mentions++; continue; }
      entity_key = ref.key;
    }
    mentions.push({ entity_type, entity_key, kind, text, quote: g.quote, t_ms: g.t_ms, confidence: g.score < 0.5 ? 'low' : 'medium' });
    if (mentions.length >= MAX_MENTIONS) break;
  }

  // ── tasks: only what was really asked in class ──
  const tasks: SessionAnalysis['tasks'] = [];
  for (const item of raw.tasks ?? []) {
    const text = sentenceCase(clamp(item.text, 200));
    const g = text ? ground(item, text) : null;
    if (!g || tasks.some((x) => sameEntityTitle(x.text, text))) continue;
    tasks.push({ text, quote: g.quote, t_ms: g.t_ms });
    if (tasks.length >= MAX_TASKS) break;
  }

  // ── key moments ──
  const highlights: SessionAnalysis['highlights'] = [];
  for (const h of raw.highlights ?? []) {
    const t_ms = toMs(h.t);
    const text = clamp(h.title, 120);
    if (t_ms === null || !text) continue;
    if (highlights.some((x) => Math.abs(x.t_ms - t_ms) < 30_000)) continue;
    highlights.push({ t_ms, text, why: clamp(h.why, 300) });
    if (highlights.length >= MAX_HIGHLIGHTS) break;
  }
  highlights.sort((a, b) => a.t_ms - b.t_ms);

  return {
    session_kind, title_summary, topic, sections, course_info, grading,
    deliverables: [...deliverables.values()], exams: [...exams.values()],
    events, mentions, tasks, highlights, dropped,
  };
}

/**
 * A range the model called logistics that lasts 8 minutes or more and whose own heading does not talk about
 * logistics ("Demostración práctica de ANSYS", 35 min): live demos and solved exercises were lost to the notes this way.
 */
export function isMislabelledAdmin(section: Pick<AnalysisSection, 'destination' | 'heading' | 'start_ms' | 'end_ms'>): boolean {
  return section.destination === 'admin'
    && section.end_ms - section.start_ms >= LONG_ADMIN_MS
    && !ADMIN_HEADING.test(fold(section.heading));
}

/** Mislabelled logistics becomes theory (its heading is kept). */
export function promoteStudyAdmin<T extends AnalysisSection>(sections: T[]): T[] {
  return sections.map((s) => (isMislabelledAdmin(s) ? { ...s, destination: 'theory' as const } : s));
}

/**
 * Sort ranges, clamp them to the class, cut overlaps and cover the whole class: short holes are
 * absorbed by the range before them, long ones become "admin". Neighbours with the same
 * destination and entity are merged.
 */
export function normalizeSections(input: AnalysisSection[], durationMs: number): AnalysisSection[] {
  const sorted = input
    .filter((s) => s.start_ms < durationMs)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((s, i, all) => ({ ...s, end_ms: Math.min(s.end_ms > s.start_ms ? s.end_ms : all[i + 1]?.start_ms ?? durationMs, durationMs) }));

  const out: AnalysisSection[] = [];
  const admin = (start: number, end: number): AnalysisSection => ({
    start_ms: start, end_ms: end, destination: 'admin', entity_type: null, entity_key: null, heading: DEFAULT_HEADING.admin,
  });
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(s.start_ms, cursor);
    if (s.end_ms <= start) continue;
    if (start - cursor >= MIN_GAP_MS) out.push(admin(cursor, start));
    else if (out.length > 0) out[out.length - 1]!.end_ms = start;
    out.push({ ...s, start_ms: out.length === 0 && start < MIN_GAP_MS ? 0 : start, end_ms: s.end_ms });
    cursor = s.end_ms;
  }
  if (out.length > 0 && durationMs - cursor >= MIN_GAP_MS) out.push(admin(cursor, durationMs));
  else if (out.length > 0) out[out.length - 1]!.end_ms = durationMs;

  const merged: AnalysisSection[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.destination === s.destination && prev.entity_key === s.entity_key) prev.end_ms = s.end_ms;
    else merged.push(s);
  }
  return merged;
}

export class SessionAnalyzer {
  private readonly client: GeminiClient;
  private readonly logger?: Logger;

  constructor(options: { client: GeminiClient; logger?: Logger }) {
    this.client = options.client;
    this.logger = options.logger?.child({ component: 'session-analyzer' });
  }

  async analyze(segments: TranscriptSegment[], context: AnalysisContext): Promise<SessionAnalysis> {
    const transcript = toTimestampedText(segments, { windowSeconds: 15 });
    if (!transcript.trim()) throw new Error('La transcripción está vacía; no hay nada que analizar.');
    if (transcript.length > MAX_INPUT_CHARS) throw new Error('La transcripción es demasiado larga para analizarla de una vez.');

    const raw = await this.client.generateJson<RawAnalysis>(buildAnalysisPrompt(transcript, context), ANALYSIS_SCHEMA, {
      system: ANALYSIS_SYSTEM_PROMPT,
      temperature: 0.2,
    });
    const out = validateAnalysis(raw, segments, context);
    this.logger?.info(
      {
        kind: out.session_kind,
        title: out.title_summary,
        sections: out.sections.map((s) => `${formatClock(s.start_ms / 1000)} ${s.destination}`),
        events: out.events.length,
        mentions: out.mentions.length,
        dropped: out.dropped,
      },
      'Análisis de la sesión completado'
    );
    return out;
  }
}
