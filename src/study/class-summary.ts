/**
 * The summary of a class: a paragraph on what mattered plus the key points to remember, written by the model from
 * the notes that are already finished (not from the transcript: a small, consistent call that can only say what the
 * notes say) and checked locally before it is stored. Pure: prompt, input, validation and document editing live here
 * so they can be tested without a model.
 *
 * Where it lives: inside the notes document, as `## Resumen` (the paragraph) and `## Puntos clave` (the list), right
 * under the title. A class has the new summary when its notes carry `## Puntos clave`; the others are brought up to
 * date by the `summary` step of the pipeline.
 */

import { fold } from '../utils/text.js';
import { parseClock } from '../utils/time.js';

export interface ClassSummary {
  text: string;
  points: string[];
}

export interface SummaryClient {
  generateText(prompt: string, options?: { system?: string; temperature?: number }): Promise<string>;
}

/** Notes shorter than this have nothing worth summarising twice */
export const MIN_BODY_CHARS = 800;
/** Characters of notes sent to the model; longer notes are cut section by section, in proportion */
export const SUMMARY_INPUT_CHARS = 48_000;

const MIN_TEXT_CHARS = 120;
const MAX_TEXT_CHARS = 1000;
const MAX_SENTENCES = 7;
const MIN_POINT_CHARS = 20;
const MAX_POINT_CHARS = 320;
const MIN_POINTS = 3;
const MAX_POINTS = 10;
/** A mark in a key point may differ this much from one in the notes (rounding) */
const MARK_TOLERANCE_S = 2;
const DUPLICATE_SIMILARITY = 0.7;

const MARK = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const SUMMARY_HEADING = /^##\s+(resumen|puntos clave)\s*$/i;
const JARGON = /\btramos?\b/i;

// ── Editing the notes document ──────────────────────────────────────────────

/** The notes without their `## Resumen` and `## Puntos clave` blocks (headings inside code fences are ignored). */
export function stripSummary(markdown: string): string {
  const out: string[] = [];
  let skipping = false;
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (!skipping) out.push(line);
      continue;
    }
    if (!fenced && /^#{1,2}\s/.test(line)) skipping = SUMMARY_HEADING.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** What the summary is written from: the notes without the title and without any earlier summary. */
export function notesBody(markdown: string): string {
  const lines = stripSummary(markdown).split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  return (h1 >= 0 ? [...lines.slice(0, h1), ...lines.slice(h1 + 1)] : lines).join('\n').trim();
}

export function hasKeyPoints(markdown: string): boolean {
  return /^##\s+Puntos clave\s*$/im.test(markdown);
}

export function renderSummary(summary: ClassSummary): string {
  const blocks = ['## Resumen', summary.text.trim()];
  if (summary.points.length > 0) blocks.push('## Puntos clave', summary.points.map((p) => `- ${p}`).join('\n'));
  return blocks.join('\n\n');
}

/** The notes document with this summary under the title, replacing whatever summary it had. */
export function withSummary(markdown: string, summary: ClassSummary): string {
  const lines = stripSummary(markdown).split('\n');
  const block = renderSummary(summary);
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 < 0) return `${block}\n\n${lines.join('\n').trim()}\n`;
  const head = lines.slice(0, h1 + 1).join('\n');
  const rest = lines.slice(h1 + 1).join('\n').replace(/^\n+/, '').trimEnd();
  return `${head}\n\n${block}${rest ? `\n\n${rest}` : ''}\n`;
}

/** A per-range gist as the old summary used it, without the "Este tramo…" that leaks the pipeline's own word. */
export function polishGist(gist: string): string {
  const cleaned = gist.trim().replace(/^(?:este|el|un)\s+(?:tramo|segmento|fragmento)(?:\s+de\s+la\s+clase)?\s+/i, '');
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

/** How many key points a class deserves: one per ~4k characters of notes, between 5 and 10. */
export function pointTarget(bodyChars: number): number {
  return Math.max(5, Math.min(MAX_POINTS, Math.round(bodyChars / 4000)));
}

export const SUMMARY_SYSTEM_PROMPT = `Eres un asistente experto en apuntes universitarios de ingeniería.
Recibes los apuntes ya redactados de una clase (secciones con su título y marcas de tiempo [mm:ss]) y escribes el RESUMEN que el alumno leerá para repasar antes de un examen.

Formato de salida (texto, NO JSON), exactamente así y sin nada fuera de ello:

<<<RESUMEN>>>
Un párrafo.
<<<PUNTOS>>>
- Primer punto clave [14:20]
- Segundo punto clave [31:05]
<<<FIN>>>

El párrafo (3 a 5 frases, entre 250 y 800 caracteres):
- Empieza directamente por el tema principal de la clase y di qué se explicó, en orden de importancia. Escribe en presente y en tono académico claro.
- Cierra, solo si los apuntes lo dicen, con lo que condiciona al alumno: una entrega, una fecha o algo que el profesor dijo que entra en el examen.
- Nunca uses la palabra «tramo», ni «en esta clase se», ni «el profesor dice que». No hables de la grabación, del audio ni de la logística del aula.

Los puntos clave (el número exacto de puntos te lo indica el mensaje):
- Cada punto se entiende solo, sin leer el resto: una definición, un método o procedimiento, una fórmula esencial ($…$ en LaTeX con una sola barra invertida), un criterio de decisión, un error típico o algo que entra en el examen.
- Una sola idea por punto, de 60 a 220 caracteres. Que sean distintos entre sí y distintos de lo que ya dice el párrafo.
- Ordénalos como van apareciendo en la clase y termina cada uno con la marca [mm:ss] copiada de los apuntes, donde ese punto se explica.

Reglas comunes:
- Todo sale de los apuntes: no inventes nada, no añadas cifras, nombres, fórmulas ni fechas que no estén en ellos.
- Conserva exactos los nombres de software, magnitudes y cifras. Una fecha, solo si los apuntes la dicen con esas mismas palabras (por ejemplo «lunes 9» o «13 de noviembre»).
- Ignora la información administrativa sin consecuencias (saludos, problemas de sonido, organización del aula).`;

/** The notes as they go to the model: whole when they fit, otherwise every section cut in proportion. */
export function summaryInput(body: string, budget = SUMMARY_INPUT_CHARS): string {
  if (body.length <= budget) return body;
  const sections: string[][] = [[]];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^##\s/.test(line) && sections[sections.length - 1]!.length > 0) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  const total = body.length;
  return sections
    .map((lines) => {
      const text = lines.join('\n');
      const share = Math.max(1200, Math.floor((budget * text.length) / total));
      if (text.length <= share) return text;
      const cut = text.slice(0, share);
      return `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : share)}\n[…]`;
    })
    .join('\n');
}

export function buildSummaryPrompt(body: string, context: { title?: string; course?: string }, target: number): string {
  const lines: string[] = [];
  if (context.course) lines.push(`Asignatura: ${context.course}`);
  if (context.title) lines.push(`Título de la clase: ${context.title}`);
  lines.push(`Puntos clave a escribir: entre ${target - 1} y ${target}.`, '', 'Apuntes de la clase:', '', summaryInput(body));
  return lines.join('\n');
}

// ── Validation ──────────────────────────────────────────────────────────────

function clockSeconds(text: string): number[] {
  return [...text.matchAll(MARK)].map((m) => parseClock(m[1]!)).filter((s): s is number => s !== null);
}

const numberTokens = (text: string): string[] =>
  (text.replace(MARK, ' ').replace(/\$[^$\n]*\$/g, ' ').replace(/`[^`\n]*`/g, ' ').match(/\d+(?:[.,]\d+)?/g) ?? []).map((t) => t.replace(',', '.'));

/** Numbers (two digits or decimals) the text states that the notes never state. */
function unsupportedNumbers(text: string, known: Set<string>): string[] {
  return [...new Set(numberTokens(text))].filter((t) => (t.length >= 2 || t.includes('.')) && !known.has(t));
}

const DATE_MENTION =
  /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+(?:dia\s+)?\d{1,2}\b|\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g;

/** Dates ("lunes 9", "13 de noviembre") the text states in words that the notes never use: a one-digit day slips past the number check. */
function unsupportedDates(text: string, bodyFolded: string): string[] {
  const found = fold(text.replace(MARK, ' ')).replace(/\s+/g, ' ').match(DATE_MENTION) ?? [];
  return [...new Set(found)].filter((d) => !bodyFolded.includes(d));
}

/** No full stop at the end of a key point, before its time mark or without one: they read as a list, not as sentences. */
function tidyPoint(point: string): string {
  return point.replace(/\.\s*(\[\d{1,2}:\d{2}(?::\d{2})?\])\s*$/, ' $1').replace(/\.\s*$/, '').trim();
}

function words(text: string): Set<string> {
  return new Set(fold(text.replace(MARK, ' ')).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 3));
}

function similar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared) >= DUPLICATE_SIMILARITY;
}

function readBullets(block: string): string[] {
  const out: string[] = [];
  for (const raw of block.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) out.push(bullet[1]!.trim());
    else if (raw.trim() && out.length > 0) out[out.length - 1] = `${out[out.length - 1] ?? ''} ${raw.trim()}`; // a wrapped line
  }
  return out.map((b) => b.replace(/\s+/g, ' ').replace(/\*\*(.+?)\*\*/g, '$1'));
}

export interface SummaryCheck {
  summary?: ClassSummary;
  /** What made the answer unusable: it is asked again with these */
  problems: string[];
  /** What was dropped from an answer that is otherwise used */
  warnings: string[];
}

/**
 * Check the model's answer against the notes it summarises. The paragraph must stand as written (a problem sends the
 * whole answer back); a key point that fails is dropped on its own. Marks the notes do not have are removed.
 */
export function validateSummary(raw: string, body: string, maxPoints = MAX_POINTS): SummaryCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  let answer = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(answer);
  if (fenced && /<<<\s*RESUMEN/i.test(fenced[1]!)) answer = fenced[1]!.trim();

  const parts = /<<<\s*RESUMEN\s*>>>([\s\S]*?)<<<\s*PUNTOS\s*>>>([\s\S]*?)(?:<<<\s*FIN\s*>>>|$)/i.exec(answer);
  if (!parts) return { problems: ['Formato incorrecto: faltan las líneas <<<RESUMEN>>>, <<<PUNTOS>>> y <<<FIN>>>'], warnings };

  const known = new Set(numberTokens(body));
  const bodyFolded = fold(body).replace(/\s+/g, ' ');
  const marks = clockSeconds(body);
  // «tramo» is the pipeline's own word for a stretch of the class; it is only fine when the notes use it for a real thing
  const jargon = (s: string): boolean => JARGON.test(s) && !JARGON.test(body);

  const text = parts[1]!.replace(/^\s*(?:RESUMEN|Resumen)\s*:\s*/, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_TEXT_CHARS) problems.push(`El párrafo es demasiado corto (${text.length} caracteres; mínimo ${MIN_TEXT_CHARS})`);
  if (text.length > MAX_TEXT_CHARS) problems.push(`El párrafo es demasiado largo (${text.length} caracteres; máximo ${MAX_TEXT_CHARS})`);
  if ((text.match(/[.!?…](?:\s|$)/g) ?? []).length > MAX_SENTENCES) problems.push(`El párrafo tiene más de ${MAX_SENTENCES} frases`);
  if (jargon(text)) problems.push('El párrafo usa la palabra «tramo»');
  if (/^(?:en\s+esta\s+clase|la\s+clase\s+(?:comienza|empieza))/i.test(text)) problems.push('El párrafo empieza por «En esta clase»: ve directo al tema');
  const badNumbers = unsupportedNumbers(text, known);
  if (badNumbers.length > 0) problems.push(`El párrafo cita cifras que los apuntes no dicen: ${badNumbers.slice(0, 4).join(', ')}`);
  const badDates = unsupportedDates(text, bodyFolded);
  if (badDates.length > 0) problems.push(`El párrafo cita fechas que los apuntes no dicen con esas palabras: ${badDates.slice(0, 3).join(', ')}`);

  const points: string[] = [];
  const seen: Set<string>[] = [];
  for (const candidate of readBullets(parts[2]!)) {
    let point = candidate;
    // Marks the notes do not have are removed; the point stays
    point = point.replace(MARK, (whole, clock: string) => {
      const s = parseClock(clock);
      return s !== null && marks.some((m) => Math.abs(m - s) <= MARK_TOLERANCE_S) ? whole : '';
    }).replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
    const bare = point.replace(MARK, '').trim();
    if (bare.length < MIN_POINT_CHARS) { warnings.push('Un punto clave demasiado corto, descartado'); continue; }
    if (bare.length > MAX_POINT_CHARS) { warnings.push(`Un punto clave demasiado largo, descartado: «${bare.slice(0, 40)}…»`); continue; }
    if (jargon(bare)) { warnings.push(`Un punto clave con la palabra «tramo», descartado: «${bare.slice(0, 40)}…»`); continue; }
    const bad = unsupportedNumbers(point, known);
    if (bad.length > 0) { warnings.push(`Punto clave con cifras que los apuntes no dicen (${bad.slice(0, 3).join(', ')}), descartado`); continue; }
    const badDate = unsupportedDates(point, bodyFolded);
    if (badDate.length > 0) { warnings.push(`Punto clave con una fecha que los apuntes no dicen (${badDate[0]}), descartado`); continue; }
    const w = words(bare);
    if (seen.some((s) => similar(s, w)) || similar(words(text), w)) { warnings.push('Punto clave repetido, descartado'); continue; }
    seen.push(w);
    points.push(tidyPoint(point));
  }
  if (points.length < MIN_POINTS) problems.push(`Hay ${points.length} puntos clave válidos; hacen falta al menos ${MIN_POINTS}`);
  if (problems.length > 0) return { problems, warnings };
  return { summary: { text, points: points.slice(0, maxPoints) }, problems: [], warnings };
}

// ── Asking the model ────────────────────────────────────────────────────────

/**
 * Summarise finished notes. Tries twice (the second time telling the model what was wrong); returns no summary when
 * the notes are too short or both answers fail, and the caller keeps the summary it had.
 */
export async function summarizeNotes(
  client: SummaryClient,
  body: string,
  context: { title?: string; course?: string } = {}
): Promise<{ summary?: ClassSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const text = body.trim();
  if (text.length < MIN_BODY_CHARS) return { warnings };
  const prompt = buildSummaryPrompt(text, context, pointTarget(text.length));
  let previous: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const answer = await client.generateText(
        previous.length > 0
          ? `${prompt}\n\nTu intento anterior tenía estos problemas; corrígelos:\n${previous.map((p) => `- ${p}`).join('\n')}`
          : prompt,
        { system: SUMMARY_SYSTEM_PROMPT, temperature: 0.2 }
      );
      const check = validateSummary(answer, text);
      if (check.summary) {
        warnings.push(...check.warnings.map((w) => `Resumen: ${w}`));
        return { summary: check.summary, warnings };
      }
      previous = check.problems;
      if (attempt === 2) warnings.push(`Resumen: se usa el resumen por partes (${check.problems.join('; ')})`);
    } catch (err) {
      previous = [];
      if (attempt === 2) warnings.push(`Resumen: se usa el resumen por partes (${(err as Error).message.slice(0, 160)})`);
    }
  }
  return { warnings };
}
