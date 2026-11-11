/**
 * First pass of the notes: the model lists what is worth keeping from each range (definitions, formulas,
 * figures, warnings, what the teacher stresses) with the minute it was said; code then throws out whatever
 * cannot be backed by the transcript, and the second pass writes the notes with that list as an obligation.
 * Splitting "what matters" from "how to write it" makes the filtering explicit and checkable. Pure: the
 * prompt, the parsing, the verification and the completeness check live here, the model call in the refiner.
 */

import type { TranscriptSegment } from '../library/transcript-files.js';
import { msToClock, parseClock } from '../utils/time.js';
import { fold } from '../utils/text.js';
import { figuresIn, transcriptHasFigure } from './notes-quality.js';
import { rangeSegments, type NotesRange } from './notes-sections.js';

export const FACT_KINDS = ['DEF', 'FORMULA', 'METODO', 'EJEMPLO', 'DATO', 'AVISO', 'ENFASIS'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Fact {
  t_ms: number;
  kind: FactKind;
  text: string;
}

/** A fact is checked against what was said this close to its minute */
const GROUNDING_WINDOW_MS = 120_000;
/** Facts may sit this far outside their range (segment rounding) */
const RANGE_TOLERANCE_MS = 10_000;
const MAX_FACTS_PER_RANGE = 40;
const MAX_FACT_CHARS = 400;
/** What the second pass must not leave out: these kinds always matter, EJEMPLO and METODO are context */
const MUST_KEEP: FactKind[] = ['DEF', 'FORMULA', 'DATO', 'AVISO', 'ENFASIS'];

export const FACTS_SYSTEM_PROMPT = `Eres un asistente que prepara el material de estudio de una clase universitaria de ingeniería. Recibes la transcripción automática (con marcas [mm:ss]) de uno o varios TRAMOS y listas los HECHOS que merece la pena conservar en unos apuntes. No redactas apuntes: solo la lista.

Conserva:
- DEF: definiciones y conceptos explicados.
- FORMULA: fórmulas y ecuaciones, en LaTeX entre $…$.
- METODO: pasos de un procedimiento o criterio de decisión.
- EJEMPLO: ejemplos resueltos, con sus cifras.
- DATO: cifras, porcentajes, plazos y requisitos concretos. Una fecha solo si se dice con su día y su mes.
- AVISO: errores típicos, advertencias y requisitos eliminatorios.
- ENFASIS: lo que el profesor remarca de forma expresa («esto es importante», «esto entra en el examen», «fijaos en esto»).

Descarta: saludos, comprobaciones de audio y de pantalla, anécdotas, bromas, repeticiones, dudas ajenas a la materia y cualquier relleno. Si una frase es ininteligible o dudosa, omítela. No inventes nada y no completes con lo que sepas de la materia: solo lo que dice la transcripción.

Formato (texto, NO JSON): por cada tramo marcado con →, una línea <<<TRAMO n>>> y debajo un hecho por línea, en orden de tiempo, con la forma:

[mm:ss] TIPO | texto del hecho en una sola línea

Ejemplo:
<<<TRAMO 2>>>
[14:20] DEF | El filtro paso bajo deja pasar las frecuencias por debajo de la frecuencia de corte.
[14:55] FORMULA | La frecuencia de corte es $f_c = \\frac{1}{2\\pi R C}$.
[16:10] ENFASIS | El profesor insiste en que esta fórmula entra en el examen.
<<<FIN>>>

Como mucho ${MAX_FACTS_PER_RANGE} hechos por tramo. Usa solo marcas de tiempo que existan en la transcripción del tramo.`;

export const NOTES_FACTS_RULE = `

Cuando un tramo trae «HECHOS A RECOGER», son lo que ya se ha comprobado que dice la clase:
- Todos deben aparecer en los apuntes del tramo, cada uno con su marca [mm:ss]. Agrúpalos con criterio bajo subtítulos y explícalos con la transcripción; no los copies como lista suelta.
- Los ENFASIS merecen un bloque de aviso (EXAM solo si el profesor dijo que entra en el examen).
- Puedes añadir lo que la transcripción diga con claridad y no esté en la lista, pero no inventes nada.`;

const FACT_LINE = new RegExp(
  `^\\s*[-*]?\\s*\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]\\s*(${FACT_KINDS.join('|')})\\s*[|:–—-]\\s*(.+?)\\s*$`,
  'i'
);

/** Read the facts answer: `<<<TRAMO n>>>` blocks of `[mm:ss] TIPO | texto` lines. Unreadable lines are skipped. */
export function parseFacts(text: string): Map<number, Fact[]> {
  const out = new Map<number, Fact[]>();
  let current: Fact[] | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const head = /^\s*<<<\s*TRAMO\s+(\d+)\s*>>>\s*$/i.exec(line);
    if (head) { current = []; out.set(Number(head[1]), current); continue; }
    if (/^\s*<<<\s*FIN\s*>>>\s*$/i.test(line)) { current = null; continue; }
    if (!current) continue;
    const m = FACT_LINE.exec(line);
    const seconds = m ? parseClock(m[1]!) : null;
    if (!m || seconds === null) continue;
    current.push({ t_ms: seconds * 1000, kind: m[2]!.toUpperCase() as FactKind, text: m[3]!.slice(0, MAX_FACT_CHARS) });
  }
  return out;
}

/** The transcript around a minute, folded for matching */
function around(segments: TranscriptSegment[], t_ms: number): string {
  return rangeSegments(segments, { start_ms: t_ms - GROUNDING_WINDOW_MS, end_ms: t_ms + GROUNDING_WINDOW_MS }).map((s) => s.text).join(' ');
}

/** Figures of a fact, leaving out what is inside a formula */
function factFigures(text: string): string[] {
  return figuresIn(text.replace(/\$\$[\s\S]+?\$\$/g, ' ').replace(/\$[^$\n]+\$/g, ' '));
}

/**
 * Keep the facts that belong to the range and whose figures the class says around that minute.
 * Returns what was dropped and why, for the report.
 */
export function verifyFacts(facts: Fact[], range: NotesRange, segments: TranscriptSegment[]): { kept: Fact[]; dropped: string[] } {
  const kept: Fact[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.t_ms < range.start_ms - RANGE_TOLERANCE_MS || f.t_ms > range.end_ms + RANGE_TOLERANCE_MS) {
      dropped.push(`[${msToClock(f.t_ms)}] fuera del tramo`);
      continue;
    }
    const key = fold(f.text).replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const nearby = around(segments, f.t_ms);
    const unsaid = factFigures(f.text).filter((fig) => !transcriptHasFigure(fig, nearby));
    if (unsaid.length > 0) {
      dropped.push(`[${msToClock(f.t_ms)}] cifra que la clase no dice (${unsaid.join(', ')})`);
      continue;
    }
    if (kept.length < MAX_FACTS_PER_RANGE) kept.push(f);
  }
  return { kept: kept.sort((a, b) => a.t_ms - b.t_ms), dropped };
}

/** The lines the second prompt shows under a range */
export function factsBlock(facts: Fact[]): string {
  if (facts.length === 0) return '';
  return `HECHOS A RECOGER (comprobados contra la transcripción):\n${facts.map((f) => `- [${msToClock(f.t_ms)}] ${f.kind} | ${f.text}`).join('\n')}`;
}

const STEM = 6;
function stemsOf(text: string): string[] {
  return fold(text).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= STEM).map((w) => w.slice(0, STEM));
}

/** True when the notes carry this fact: its figures, its formula or most of its own words. */
export function factIsCovered(fact: Fact, markdown: string): boolean {
  const compact = (s: string) => s.replace(/\s+/g, '');
  if (fact.kind === 'FORMULA') {
    const formulas = [...fact.text.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g)].map((m) => compact(m[1] ?? m[2] ?? ''));
    if (formulas.length > 0) return formulas.every((f) => compact(markdown).includes(f));
  }
  const figures = factFigures(fact.text).map((f) => f.replace('%', ''));
  const haystack = fold(markdown);
  if (figures.length > 0) {
    const figuresPresent = figures.every((f) => haystack.includes(f) || haystack.includes(f.replace('.', ',')) || haystack.includes(f.replace(/\./g, '')));
    if (!figuresPresent) return false;
    // Figures alone ("2" in "2 puntos") say little: the fact's words must also appear when it has any
  }
  const words = [...new Set(stemsOf(fact.text.replace(/\$[^$\n]+\$/g, ' ')))];
  if (words.length === 0) return figures.length > 0;
  const present = new Set(stemsOf(markdown));
  const hits = words.filter((w) => present.has(w)).length;
  return hits / words.length >= 0.5;
}

/** The facts the second pass was told to keep and the notes do not carry. */
export function missingFacts(facts: Fact[], markdown: string): Fact[] {
  return facts.filter((f) => MUST_KEEP.includes(f.kind) && !factIsCovered(f, markdown));
}

/** Add the missing facts at the end of the range, in their own sub-heading, each with its minute. */
export function appendMissingFacts(markdown: string, missing: Fact[]): string {
  if (missing.length === 0) return markdown;
  const lines = missing.map((f) => `- ${f.text.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')} [${msToClock(f.t_ms)}]`);
  return `${markdown.trimEnd()}\n\n#### Otros puntos del tramo\n${lines.join('\n')}`;
}
