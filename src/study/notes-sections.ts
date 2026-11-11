/**
 * Notes written per range of a class. The analysis already cut the session into ranges with a
 * destination (theory, deliverable, exam…); here Gemini only writes the text of each one, and
 * everything it returns is checked locally before it is stored. Pure: prompts, batching, validation
 * and the recomposed .clean.md all live here so they can be tested without a model.
 */

import type { NoteDestination } from '../database/CampusRepository.js';
import { toTimestampedText, type TranscriptSegment } from '../library/transcript-files.js';
import { msToClock, parseClock } from '../utils/time.js';
import { fold } from '../utils/text.js';
import { MONTHS } from './dates.js';
import { validateDiagrams } from './diagrams.js';
import { polishGist } from './class-summary.js';

/** Bump when the notes prompt changes. */
export const NOTES_PROMPT_VERSION = '5';

/** Transcript characters sent in one call (~15k tokens): a 1 h class fits in one, a 2 h class in two or three. */
export const NOTES_BATCH_CHARS = 60_000;

export const CALLOUT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION', 'EXAM'] as const;
const DEFAULT_CALLOUT = 'NOTE';
/** A time mark may fall this far outside its range (segment rounding) and still count as inside */
const TAG_TOLERANCE_MS = 5_000;
/** An [!EXAM] callout has to be backed by what was said this close to its time mark */
const EXAM_WINDOW_MS = 60_000;
const MIN_THEORY_CHARS = 200;
const MIN_THEORY_MINUTES = 5;
const MAX_GIST_CHARS = 300;

export interface NotesRange {
  ord: number;
  start_ms: number;
  end_ms: number;
  destination: NoteDestination;
  heading: string;
  /** Deliverable or exam this range is about, when it has one */
  entity_title?: string | null;
}

export interface SectionNotes {
  ord: number;
  gist: string;
  markdown: string;
  /** Model that wrote it (DeepSeek when Gemini failed): set by the refiner, not by the validation */
  model?: string;
}

export interface RawNotesOutput {
  sections?: { ord?: unknown; gist?: unknown; markdown?: unknown }[];
}

export interface NotesPromptContext {
  title?: string;
  course?: string;
  glossary?: string[];
}

// ── Schema and prompt ───────────────────────────────────────────────────────

/**
 * The notes come back as delimited text, not as JSON: Markdown full of LaTeX (`\\frac`, `\\sum`) inside a JSON string
 * needs every backslash and quote escaped, and a single slip breaks the whole answer (more so on models that do not
 * enforce a schema). One block per range:
 *
 *   <<<TRAMO 3>>>
 *   RESUMEN: una frase
 *   ### Apuntes en Markdown…
 *   <<<FIN>>>
 */
const BLOCK_START = /^[ \t]*<<<\s*TRAMO\s+(\d+)\s*>>>[ \t]*$/gim;
const BLOCK_END = /^[ \t]*<<<\s*FIN\s*>>>[ \t]*$/im;
const GIST_LINE = /^[ \t]*(?:RESUMEN|GIST)\s*:\s*(.*)$/i;

/** Read the delimited answer. Lenient: an outer code fence is dropped and, when only one range was asked, a bare answer counts for it. */
export function parseDelimitedNotes(text: string, askedOrds: number[] = []): RawNotesOutput {
  let body = text.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body);
  if (fenced && /<<<\s*TRAMO/i.test(fenced[1]!)) body = fenced[1]!.trim();

  const starts = [...body.matchAll(BLOCK_START)];
  if (starts.length === 0) {
    // No markers at all: a single range can only mean this text
    if (askedOrds.length === 1 && body) {
      const { gist, markdown } = splitGist(body.replace(BLOCK_END, ''));
      return { sections: [{ ord: askedOrds[0], gist, markdown }] };
    }
    return { sections: [] };
  }
  const sections: NonNullable<RawNotesOutput['sections']> = [];
  starts.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : body.length;
    let block = body.slice(from, to);
    const end = BLOCK_END.exec(block);
    if (end) block = block.slice(0, end.index);
    const { gist, markdown } = splitGist(block);
    sections.push({ ord: Number(m[1]), gist, markdown });
  });
  return { sections };
}

function splitGist(block: string): { gist: string; markdown: string } {
  const lines = block.replace(/^\n+/, '').split('\n');
  const m = GIST_LINE.exec(lines[0] ?? '');
  if (!m) return { gist: '', markdown: lines.join('\n').trim() };
  return { gist: m[1]!.trim(), markdown: lines.slice(1).join('\n').trim() };
}

export const NOTES_SYSTEM_PROMPT = `Eres un asistente experto en apuntes universitarios de ingeniería.
Recibes la transcripción automática (con marcas [mm:ss]) de uno o varios TRAMOS de una clase, ya clasificados por su destino, y redactas los apuntes de cada tramo.

Formato de salida (texto, NO JSON): una entrada por cada tramo marcado con →, con exactamente esta forma y sin nada fuera de ellas:

<<<TRAMO 2>>>
RESUMEN: una sola frase que diga de qué va el tramo
### Primer subtítulo [14:20]
- Apuntes en Markdown, con fórmulas como $E = mc^2$ escritas tal cual (una sola barra invertida).
<<<FIN>>>

Cada entrada empieza con la línea <<<TRAMO n>>> (n es el número del tramo), sigue con la línea RESUMEN:, luego los apuntes en Markdown, y acaba con la línea <<<FIN>>>. No uses bloques de código para envolver la respuesta.

Reglas comunes:
- Escribe en español, en tono académico claro y directo, sin saludos, sin frases de introducción ni de cierre.
- Quita muletillas, repeticiones, titubeos y comprobaciones de audio.
- No inventes nada. Si una frase es ininteligible o dudosa, omítela.
- Conserva exactos los nombres de software, cifras, porcentajes y fechas. Escribe una fecha solo si el profesor la dice con su día y su mes.
- La transcripción se hizo con reconocimiento automático y confunde cifras ("100.000" por "6.000"). Si una cifra contradice a otra o no cuadra con un total o una suma que el profesor da, escribe lo que se oye y pon ⚠️ justo después de la cifra dudosa. No la corrijas por tu cuenta.
- Fórmulas en LaTeX: $…$ en línea y $$…$$ en bloque.
- Dentro de "markdown" no uses títulos de nivel 1 ni 2 (el título del tramo lo pone la aplicación): usa ### y ####.
- Añade al final de cada subtítulo y de cada viñeta importante UNA marca [mm:ss]: la del momento en que se explica. Nunca varias seguidas. Usa solo marcas del propio tramo.
- Bloques de aviso, con el formato "> [!TIPO] Título opcional" y las líneas siguientes también con ">": NOTE, TIP, IMPORTANT, WARNING, CAUTION o EXAM. EXAM solo si el profesor dice expresamente que algo entra o importa para el examen. WARNING para errores típicos y requisitos eliminatorios. Máximo 4 por tramo.

Gráficas y diagramas (opcional, como mucho 3 por tramo): si el profesor describe en voz alta una función, unos datos o un proceso con pasos, puedes dibujarlos con un bloque de código cuyo contenido es JSON en una sola línea. La clase no tiene diapositivas en el audio, así que NUNCA dibujes algo que el profesor no haya dicho: cada cifra, constante y paso tiene que salir de la transcripción.
- \`\`\`plot para funciones de x: {"title":"…","xLabel":"t (s)","yLabel":"V","xMin":-5,"xMax":5,"curves":[{"expr":"sin(x)/x","label":"seno cardinal"}],"points":[{"x":0,"y":1,"label":"máximo"}]}. En "expr" solo x, números, pi, e, + - * / ^, paréntesis y sin cos tan exp ln log sqrt abs (sin barras invertidas: "2*x^2", no LaTeX).
- \`\`\`chart para datos con cifras dichas: {"type":"bar","title":"…","unit":"%","labels":["A","B"],"series":[{"name":"2024","values":[30,70]}]} (type: bar, line o pie).
- \`\`\`flow para un proceso o una estructura: {"title":"…","direction":"LR","nodes":[{"id":"a","label":"Medir","kind":"start"},{"id":"b","label":"¿Supera el umbral?","kind":"decision"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"a","label":"no"}]} (kind: start, step, decision o end).
Ábrelos y ciérralos con tres acentos graves en su propia línea. Si dudas, no pongas ninguno: es mejor una viñeta que un dibujo inventado.

Qué escribir según el destino del tramo:
- teoría: subtítulos ### con los conceptos, definiciones, fórmulas y ejemplos explicados.
- trabajo (deliverable): objetivo, requisitos, formato y entrega, criterios de evaluación, consejos y dudas resueltas.
- examen: qué entra, qué no, formato y consejos, con bloques EXAM.
- información de la asignatura (course_info): como mucho 8 viñetas con lo esencial; el detalle ya está en la ficha.

Si un tramo se llama «… (parte n de m)», es un trozo de un tramo más largo que se escribe por partes: escribe solo lo de ese trozo, sin presentación ni conclusión del conjunto, y no repitas lo que dirían las otras partes.`;

const DESTINATION_LABEL: Record<NoteDestination, string> = {
  theory: 'teoría', deliverable: 'trabajo', exam: 'examen', course_info: 'información de la asignatura', admin: 'logística',
};

// ── Ranges ──────────────────────────────────────────────────────────────────

/** The segments that start inside a range (end excluded). */
export function rangeSegments(segments: TranscriptSegment[], range: Pick<NotesRange, 'start_ms' | 'end_ms'>): TranscriptSegment[] {
  return segments.filter((s) => s.start * 1000 >= range.start_ms && s.start * 1000 < range.end_ms);
}

export function rangeTranscript(segments: TranscriptSegment[], range: NotesRange): string {
  return toTimestampedText(rangeSegments(segments, range), { windowSeconds: 15 });
}

/** One range covering a whole class: what the notes use when the analysis could not cut it. */
export function wholeClassRange(durationMs: number): NotesRange {
  return { ord: 0, start_ms: 0, end_ms: durationMs, destination: 'theory', heading: 'Contenido de la clase', entity_title: null };
}

/** Group contiguous ranges into batches that stay under `budget` characters; a range is never split. */
export function batchRanges(ranges: NotesRange[], size: (range: NotesRange) => number, budget = NOTES_BATCH_CHARS): NotesRange[][] {
  const batches: NotesRange[][] = [];
  let current: NotesRange[] = [];
  let used = 0;
  for (const range of ranges) {
    const n = size(range);
    if (current.length > 0 && used + n > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(range);
    used += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Longest stretch of transcript written in one go. A model's answer is capped (DeepSeek: 16k tokens) and the notes
 * are about a third as long as what they summarise, so a single 97-minute range (77k characters) came back cut off
 * on every model and the class was published without its theory. Longer ranges are written in parts.
 */
export const NOTES_PART_CHARS = 30_000;
/** Ords of the parts of a split range: the range's ord × 1000 + the part number (ranges themselves have small ords) */
const PART_ORD_FACTOR = 1000;

function estimatedChars(segments: TranscriptSegment[]): number {
  // The text plus the time marks the transcript adds every ~15 s
  let total = 0;
  for (const s of segments) total += s.text.length + 1;
  const seconds = segments.length > 0 ? segments[segments.length - 1]!.end - segments[0]!.start : 0;
  return total + Math.ceil(Math.max(0, seconds) / 15) * 8;
}

/**
 * Cut every range whose transcript is longer than `maxChars` into parts of about the same size, each cut at the
 * longest pause near the even split (so a sentence or an explanation is not cut in half). Ranges that fit are returned
 * as they are. `parts` maps every range ord to the ords of the units written for it, in time order.
 */
export function splitLongRanges(
  ranges: NotesRange[],
  segments: TranscriptSegment[],
  maxChars = NOTES_PART_CHARS
): { units: NotesRange[]; parts: Map<number, number[]> } {
  const units: NotesRange[] = [];
  const parts = new Map<number, number[]>();
  for (const range of ranges) {
    const inside = rangeSegments(segments, range);
    const total = estimatedChars(inside);
    const count = Math.ceil(total / maxChars);
    if (count <= 1 || inside.length < count * 2) {
      units.push(range);
      parts.set(range.ord, [range.ord]);
      continue;
    }
    // Cumulative size after each segment
    const cumulative: number[] = [];
    let run = 0;
    for (const s of inside) {
      run += s.text.length + 1 + (8 / 15) * Math.max(0, s.end - s.start);
      cumulative.push(run);
    }
    const cuts: number[] = []; // index of the first segment of each part after the first
    // Look for the pause within a tenth of a part on either side of the even split
    const window = Math.max(3, Math.floor(inside.length / count / 10));
    for (let k = 1; k < count; k++) {
      const target = (cumulative[cumulative.length - 1]! * k) / count;
      let at = cumulative.findIndex((c) => c >= target);
      if (at < 0) at = inside.length - 1;
      let best = at;
      let bestGap = -1;
      const lowest = Math.max((cuts[cuts.length - 1] ?? 0) + 1, at - window);
      for (let j = lowest; j <= Math.min(inside.length - 1, at + window); j++) {
        const gap = inside[j]!.start - inside[j - 1]!.end;
        if (gap > bestGap) { bestGap = gap; best = j; }
      }
      cuts.push(best);
    }
    const ords: number[] = [];
    const bounds = [0, ...cuts, inside.length];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const first = inside[bounds[k]!]!;
      // floor, not round: rangeSegments keeps a segment when start × 1000 >= start_ms, so the first segment of a part
      // must never fall below the part's own start (rounding up would hand it to the part before)
      const nextStart = k + 2 < bounds.length ? Math.floor(inside[bounds[k + 1]!]!.start * 1000) : range.end_ms;
      const ord = range.ord * PART_ORD_FACTOR + k + 1;
      units.push({
        ...range,
        ord,
        start_ms: k === 0 ? range.start_ms : Math.floor(first.start * 1000),
        end_ms: nextStart,
        heading: `${range.heading} (parte ${k + 1} de ${bounds.length - 1})`,
      });
      ords.push(ord);
    }
    parts.set(range.ord, ords);
  }
  return { units, parts };
}

/** One gist per range out of its parts', cut at a full sentence when it is too long. */
function mergeGists(gists: string[]): string {
  const joined = gists.map((g) => g.trim()).filter(Boolean).map((g) => (/[.!?…]$/.test(g) ? g : `${g}.`)).join(' ');
  if (joined.length <= MAX_GIST_CHARS) return joined;
  const cut = joined.slice(0, MAX_GIST_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '…');
}

/**
 * Put the parts of each split range back together. A range is written only when every one of its parts is: a missing
 * part would leave a hole in the middle of the notes that nobody would notice, so the range counts as failed instead.
 */
export function mergeSplitSections(
  written: SectionNotes[],
  parts: Map<number, number[]>
): { sections: SectionNotes[]; failed: number[] } {
  const byOrd = new Map(written.map((s) => [s.ord, s]));
  const sections: SectionNotes[] = [];
  const failed: number[] = [];
  for (const [ord, unitOrds] of parts) {
    const found = unitOrds.map((u) => byOrd.get(u));
    if (found.length === 0 || found.some((s) => !s)) {
      failed.push(ord);
      continue;
    }
    const done = found as SectionNotes[];
    if (done.length === 1) {
      sections.push(done[0]!);
      continue;
    }
    const models = [...new Set(done.map((s) => s.model).filter((m): m is string => !!m))];
    sections.push({
      ord,
      gist: mergeGists(done.map((s) => s.gist)),
      markdown: done.map((s) => s.markdown.trim()).join('\n\n'),
      ...(models.length > 0 ? { model: models.join(' + ') } : {}),
    });
  }
  return { sections: sections.sort((a, b) => a.ord - b.ord), failed: failed.sort((a, b) => a - b) };
}

function rangeLabel(r: NotesRange): string {
  return `${msToClock(r.start_ms)}–${msToClock(r.end_ms)} · ${DESTINATION_LABEL[r.destination]} · «${r.heading}»${r.entity_title ? ` · sobre «${r.entity_title}»` : ''}`;
}

export function buildNotesPrompt(
  batch: { range: NotesRange; transcript: string }[],
  all: NotesRange[],
  context: NotesPromptContext = {},
  /** Extra text shown under a range after its transcript (the verified facts of the first pass) */
  extras: Map<number, string> = new Map()
): string {
  const asked = new Set(batch.map((b) => b.range.ord));
  const lines: string[] = [];
  if (context.course) lines.push(`Asignatura: ${context.course}`);
  if (context.title) lines.push(`Título de la clase: ${context.title}`);
  if (context.glossary?.length) lines.push(`Vocabulario técnico de la asignatura (usa esta ortografía exacta): ${context.glossary.slice(0, 80).join(', ')}`);
  lines.push('', 'Índice de la clase (solo escribes los tramos marcados con →):');
  for (const r of all) lines.push(`${asked.has(r.ord) ? '→' : ' '} ${r.ord}. ${rangeLabel(r)}`);
  const parts = batch.map(({ range, transcript }) => {
    const extra = extras.get(range.ord);
    return `=== TRAMO ${range.ord} · ${rangeLabel(range)} ===\n${transcript}${extra ? `\n\n--- ${extra}` : ''}`;
  });
  return `${lines.join('\n')}\n\n${parts.join('\n\n')}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

const TAG = /[ \t]*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const PREAMBLE = /^(aqui tienes|aqui esta|aqui van|claro|por supuesto|a continuacion|te presento|estos son|estas son|perfecto|entendido|de acuerdo|vale\b)/;
const POSTAMBLE = /^(espero que|si necesitas|si quieres|si deseas|no dudes|quedo a|me avisas|puedo (ayudarte|ampliar)|estos apuntes)/;
const EXAM_WORDS = /\b(examen|examenes|entra|entrara|entran|cae|caera|caen|nota|notas|evalu\w*)\b/;
const MONTH_NAMES = Object.keys(MONTHS).join('|');
const DATE_MENTION = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MONTH_NAMES})\\b(?:\\s+de\\s+\\d{4})?(?!\\s?⚠)`, 'gi');

function stripEnds(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  for (let i = 0; i < 2 && paragraphs.length > 0; i++) {
    const first = fold(paragraphs[0]!.trim());
    if (PREAMBLE.test(first)) paragraphs.shift();
    else break;
  }
  for (let i = 0; i < 2 && paragraphs.length > 0; i++) {
    const last = fold(paragraphs[paragraphs.length - 1]!.trim());
    if (POSTAMBLE.test(last)) paragraphs.pop();
    else break;
  }
  return paragraphs.join('\n\n');
}

/** # and ## belong to the document, not to a range. Code fences are left alone. */
function demoteHeadings(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
      return fenced ? line : line.replace(/^#{1,2}(?=\s)/, '###');
    })
    .join('\n');
}

function dropForeignTags(text: string, range: NotesRange): string {
  return text.replace(TAG, (whole, clock: string) => {
    const seconds = parseClock(clock);
    if (seconds === null) return whole;
    const ms = seconds * 1000;
    return ms >= range.start_ms - TAG_TOLERANCE_MS && ms <= range.end_ms + TAG_TOLERANCE_MS ? whole : '';
  });
}

/** Callout type in capitals and one the renderer knows; an [!EXAM] has to be backed by the transcript. */
function fixCallouts(text: string, range: NotesRange, segments: TranscriptSegment[], warnings: string[]): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^(>\s*\[!)([A-Za-z]+)(\])/.exec(lines[i]!);
    if (!head) continue;
    let type = head[2]!.toUpperCase();
    if (!(CALLOUT_TYPES as readonly string[]).includes(type)) type = DEFAULT_CALLOUT;
    if (type === 'EXAM') {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1]!.startsWith('>')) end++;
      const mark = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/.exec(lines.slice(i, end + 1).join('\n'));
      const seconds = mark ? parseClock(mark[1]!) : null;
      const near = seconds === null
        ? rangeSegments(segments, range)
        : rangeSegments(segments, { start_ms: seconds * 1000 - EXAM_WINDOW_MS, end_ms: seconds * 1000 + EXAM_WINDOW_MS });
      // In a range already about the exam, the whole range backs its callouts: the teacher says "preguntas de examen"
      // once and then reads questions for minutes, far beyond the window of the later ones
      const backing = range.destination === 'exam' ? [...near, ...rangeSegments(segments, range)] : near;
      if (!EXAM_WORDS.test(fold(backing.map((s) => s.text).join(' ')))) {
        type = 'IMPORTANT';
        warnings.push('Aviso EXAM sin respaldo en la clase: pasa a IMPORTANT');
      }
    }
    lines[i] = lines[i]!.replace(/^(>\s*\[!)([A-Za-z]+)(\])/, `$1${type}$3`);
  }
  return lines.join('\n');
}

/** True when the transcript says that day of that month: together ("20 de noviembre") or close by. */
function dateIsSaid(day: number, month: string, transcript: string): boolean {
  if (new RegExp(`\\b0?${day}\\s+de\\s+${month}\\b`).test(transcript)) return true;
  const dayRe = new RegExp(`\\b0?${day}\\b`);
  for (const m of transcript.matchAll(new RegExp(`\\b${month}\\b`, 'g'))) {
    if (dayRe.test(transcript.slice(Math.max(0, m.index! - 60), m.index! + month.length + 60))) return true;
  }
  return false;
}

function flagUnsaidDates(text: string, transcript: string, warnings: string[]): string {
  const folded = fold(transcript);
  return text.replace(DATE_MENTION, (whole, day: string, month: string) => {
    if (dateIsSaid(Number(day), fold(month), folded)) return whole;
    const note = `Fecha «${whole}» que la clase no dice`;
    if (!warnings.includes(note)) warnings.push(note);
    return `${whole} ⚠️`;
  });
}

// ── Figures that do not add up ──────────────────────────────────────────────

interface FigureNode {
  line: number;
  indent: number;
  label: string;
  amount: number | null;
  children: FigureNode[];
}

/** "Préstamos: 6.000 euros", "Total: (30.000) €": label before the colon, amount at the end (Spanish number format). */
const FIGURE_LINE = /^(.*?):\s*(?:[=≈]\s*)?(\(|[−-])?\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\)?\s*(?:€|euros?|dólares?|dolares?|usd|\$)?\s*[.;]?\s*$/i;
const TOTAL_LABEL = /^(total|suma)\b/;

function parseFigure(text: string): { label: string; amount: number | null } {
  const clean = text.replace(/\*\*|__/g, '').replace(TAG, '').replace(/⚠️/g, '').trim();
  const m = FIGURE_LINE.exec(clean);
  if (!m) return { label: clean.replace(/:\s*$/, ''), amount: null };
  const value = Number(`${m[3]!.replace(/\./g, '')}${m[4] ? `.${m[4]}` : ''}`);
  return { label: m[1]!.trim(), amount: m[2] ? -value : value };
}

/** The bullet lists of a Markdown text as trees (code blocks skipped): what a list of figures looks like. */
function figureTrees(lines: string[]): FigureNode[] {
  const roots: FigureNode[] = [];
  const stack: FigureNode[] = [];
  let fenced = false;
  lines.forEach((raw, line) => {
    if (/^\s*```/.test(raw)) { fenced = !fenced; return; }
    const m = fenced ? null : /^([ \t]*)[-*+]\s+(.*)$/.exec(raw);
    if (!m) {
      // Anything that is not a bullet (a heading, a paragraph) closes the list
      if (raw.trim() && !/^\s/.test(raw)) stack.length = 0;
      return;
    }
    const indent = m[1]!.replace(/\t/g, '    ').length;
    const node: FigureNode = { line, indent, ...parseFigure(m[2]!), children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    (stack.length > 0 ? stack[stack.length - 1]!.children : roots).push(node);
    stack.push(node);
  });
  return roots;
}

/** What a list item is worth: its own amount, else the total it lists, else the sum of its items (null when unknown). */
function figureValue(node: FigureNode): number | null {
  if (node.amount !== null) return node.amount;
  if (node.children.length === 0) return null;
  const total = node.children.find((c) => TOTAL_LABEL.test(fold(c.label)) && c.amount !== null);
  if (total) return total.amount;
  let sum = 0;
  for (const c of node.children) {
    const v = figureValue(c);
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

function stem(word: string): string {
  return fold(word).replace(/[^a-z0-9]/g, '').slice(0, 5);
}

/**
 * A "Total …" bullet whose figure is not the sum of the items above it ("Total Pasivo + Patrimonio Neto: 300.000" over
 * 6.000 + 50.000 + 6.000 + 50.000): the transcript misheard a number or the teacher misspoke, and the notes copied it.
 * The total line gets a ⚠️ and the warning says what the items add up to. Only what can be checked is checked: a
 * list with an item without a figure is left alone.
 */
export function flagInconsistentTotals(text: string, warnings: string[]): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const flagged = new Set<number>();
  const visit = (siblings: FigureNode[]) => {
    let groupStart = 0;
    siblings.forEach((node, i) => {
      if (TOTAL_LABEL.test(fold(node.label)) && node.amount !== null) {
        const terms = fold(node.label).replace(TOTAL_LABEL, '').split(/\s*\+\s*|\s+y\s+/).map(stem).filter(Boolean);
        const named = /\+|\sy\s/.test(fold(node.label)) && terms.length > 1;
        const addends = siblings.slice(groupStart, i).filter((s) => !named || terms.some((t) => stem(s.label).startsWith(t)));
        const values = addends.map(figureValue);
        if (addends.length >= 2 && values.every((v): v is number => v !== null)) {
          const sum = values.reduce((a, b) => a + b, 0);
          if (Math.abs(sum - node.amount) > Math.max(1, Math.abs(node.amount) * 0.005)) {
            flagged.add(node.line);
            const fmt = (n: number) => n.toLocaleString('es-ES');
            warnings.push(`Cifras que no cuadran en «${node.label}»: los apartados suman ${fmt(sum)} y se dice ${fmt(node.amount)}`);
          }
        }
        groupStart = i + 1;
      }
      visit(node.children);
    });
  };
  visit(figureTrees(lines));
  for (const n of flagged) if (!/⚠/.test(lines[n]!)) lines[n] = `${lines[n]!.trimEnd()} ⚠️`;
  return lines.join('\n');
}

const STAMP_RUN = /(\[\d{1,2}:\d{2}(?::\d{2})?\])(?:[ \t]*\[\d{1,2}:\d{2}(?::\d{2})?\])+/g;

/** "texto [52:14] [52:30] [52:46]" → "texto [52:14]": one moment per idea; a run of marks is noise to read. */
export function collapseStampRuns(text: string): string {
  return text.replace(STAMP_RUN, '$1');
}

/**
 * Clean the notes the model wrote for one range: no introduction or closing, no titles above ###,
 * no time marks from outside the range, one mark where the model wrote a run, known callout types,
 * no EXAM claim the class does not make, a ⚠️ on any date the range never says and on any total that does not add up.
 * Returns '' when nothing is left.
 */
export function validateSectionNotes(raw: string, range: NotesRange, segments: TranscriptSegment[]): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  let text = demoteHeadings(stripEnds(raw.replace(/\r\n?/g, '\n').trim()));
  text = collapseStampRuns(dropForeignTags(text, range));
  text = fixCallouts(text, range, segments, warnings);
  const said = rangeSegments(segments, range).map((s) => s.text).join(' ');
  text = flagUnsaidDates(text, said, warnings);
  text = flagInconsistentTotals(text, warnings);
  const diagrams = validateDiagrams(text, said);
  text = diagrams.markdown.trim();
  warnings.push(...diagrams.warnings);
  if (!text) return { markdown: '', warnings: [] };

  const minutes = (range.end_ms - range.start_ms) / 60_000;
  if (range.destination === 'theory' && minutes >= MIN_THEORY_MINUTES && text.length < MIN_THEORY_CHARS) {
    warnings.push(`Apuntes muy cortos para ${Math.round(minutes)} min de teoría`);
  }
  return { markdown: text, warnings };
}

function cleanGist(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(TAG, '').replace(/\s+/g, ' ').trim().slice(0, MAX_GIST_CHARS);
}

/** Validate a whole answer: keeps what answers a requested range, and says which ranges got nothing. */
export function validateNotesOutput(
  raw: RawNotesOutput,
  ranges: NotesRange[],
  segments: TranscriptSegment[]
): { sections: SectionNotes[]; failed: number[]; warnings: string[] } {
  const byOrd = new Map(ranges.map((r) => [r.ord, r]));
  const done = new Map<number, SectionNotes>();
  const warnings: string[] = [];
  for (const item of Array.isArray(raw.sections) ? raw.sections : []) {
    if (!item || typeof item !== 'object' || typeof item.ord !== 'number' || !Number.isInteger(item.ord)) continue;
    const range = byOrd.get(item.ord);
    if (!range || done.has(range.ord)) continue;
    const { markdown, warnings: found } = validateSectionNotes(typeof item.markdown === 'string' ? item.markdown : '', range, segments);
    if (!markdown) continue;
    done.set(range.ord, { ord: range.ord, gist: cleanGist(item.gist), markdown });
    warnings.push(...found.map((w) => `«${range.heading}»: ${w}`));
  }
  return {
    sections: [...done.values()].sort((a, b) => a.ord - b.ord),
    failed: ranges.filter((r) => !done.has(r.ord)).map((r) => r.ord),
    warnings,
  };
}

// ── Recomposing the document ────────────────────────────────────────────────

export interface NotesPart {
  range: NotesRange;
  gist: string;
  markdown: string;
}

/**
 * The class notes as one Markdown document: title, a summary made of each range's gist, then one
 * section per range in class order. Logistics and ranges without text are left out.
 */
export function composeCleanMd(title: string, parts: NotesPart[]): string {
  const written = parts.filter((p) => p.range.destination !== 'admin' && p.markdown.trim());
  const gists = written
    .map((p) => polishGist(p.gist))
    .filter(Boolean)
    .map((g) => (/[.!?…]$/.test(g) ? g : `${g}.`));
  const blocks = [`# ${title.trim()}`];
  if (gists.length > 0) blocks.push('## Resumen', gists.join(' '));
  for (const p of written) {
    blocks.push(`## ${p.range.heading.replace(TAG, '').trim()} [${msToClock(p.range.start_ms)}]`, p.markdown.trim());
  }
  return `${blocks.join('\n\n')}\n`;
}

// ── What to (re)write ───────────────────────────────────────────────────────

export type NotesPlan = 'all' | 'missing' | 'none';

export interface NotesPlanInput {
  notes: { prompt_version: string; markdown: string } | undefined;
  sections: { destination: NoteDestination; markdown: string }[];
  version: string;
  /** The user asked for a rewrite of everything */
  force: boolean;
  /** The notes step was asked for by name (a regenerate job), not run as part of the default steps */
  explicit: boolean;
}

/**
 * - 'all': write every range again.
 * - 'missing': current notes where some range has no text (an interrupted run, or a new analysis).
 * - 'none': leave the notes alone.
 * Notes the user edited are only rewritten by force; notes from an older prompt only when asked for
 * (or when they have no time marks, which cannot drive the player).
 */
export function planNotes(input: NotesPlanInput): NotesPlan {
  const { notes } = input;
  if (!notes) return 'all';
  if (notes.prompt_version === 'manual') return input.force ? 'all' : 'none';
  if (input.force) return 'all';
  if (notes.prompt_version !== input.version) {
    const hasMarks = /\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(notes.markdown);
    return !hasMarks || input.explicit ? 'all' : 'none';
  }
  return input.sections.some((s) => s.destination !== 'admin' && !s.markdown.trim()) ? 'missing' : 'none';
}
