/**
 * Measures notes against the transcript they came from, without calling a model. Pure, so it can run on every
 * class already on disk and, with `npm run notes:eval -- --live`, compare two versions of the prompt on the
 * same class. The score is for comparing versions of the same class, not an absolute grade: what it catches
 * are the failures a model really has (broken formulas, invented figures, time marks that lead nowhere,
 * leftover filler, whole topics missing).
 */

import katex from 'katex';
import type { TranscriptSegment } from '../library/transcript-files.js';
import { parseClock } from '../utils/time.js';
import { fold } from '../utils/text.js';

export interface NotesQuality {
  chars: number;
  minutes: number;
  /** Notes characters per minute of class: too low is a summary of a few minutes, too high is a copy */
  charsPerMinute: number;
  formulas: { total: number; broken: string[] };
  timeMarks: { total: number; outOfClass: number; perTenMinutes: number };
  /** Figures (percentages, decimals, 2+ digit numbers) in the notes that the transcript never says */
  figures: { total: number; unsupported: string[] };
  /** The most-repeated technical words of the class and how many of them the notes mention */
  coverage: { keyTerms: number; covered: number; ratio: number; missing: string[] };
  filler: { count: number; samples: string[] };
  structure: { headings: number; callouts: number; unbalancedMath: boolean };
  /** 0-100, higher is better. Only meaningful between two runs on the same class. */
  score: number;
  issues: string[];
}

const KEY_TERMS = 40;
const MIN_TERM_LENGTH = 6;
const MIN_TERM_COUNT = 3;
const STEM = 6;
/** Gerunds and 2nd-person plurals are speech (viendo, podeis), not terms of the subject */
const SPEECH_ENDING = /(?:ando|iendo|eis|ais|emos)$/;
/** Words that are frequent in any Spanish class and say nothing about its topic */
const COMMON = new Set(
  ('porque entonces tambien cuando donde aunque ademas ahora luego bueno vamos porque tenemos estamos podemos'
    + ' ejemplo digamos simplemente basicamente realmente totalmente evidentemente claramente tiempo manera'
    + ' forma cosas siempre nunca todavia despues antes mientras aquellos aquellas nosotros vosotros ustedes'
    + ' pregunta preguntas alguien alguno alguna algunos algunas ninguno ninguna cualquier mismo misma mismos'
    + ' estaba estaban estoy estais hacer haciendo hecho hacemos tienen tiene tenia pueden puede podria'
    + ' parece pasar verdad claro gracias perfecto vale hemos habia habria sobre entre hasta desde hacia'
    + ' segun durante mediante tambien ningun necesito necesitamos digo dijimos dicho decir queria quiero'
    + ' quieren quieres quedan queda quedar pongo ponemos poner mirar miramos miremos veamos vemos'
    + ' dentro fuera nuestro nuestra nuestros nuestras acuerdo cuales cuyo cuyos observe observa fijaros fijaos'
    + ' solamente muchisimo muchisima bastante sencillo sencilla poquito poquita escucha escuchar escuchais'
    + ' etcetera veremos cuenta apartado ultimo ultima hablar hablando hablamos recordar recordad realiza'
    + ' realizar utilizo utilizar supuesto segura seguro interes tienes teneis podeis queremos quiere'
    + ' veces primero primera segundo segunda tercero tercera siguiente anterior importante principal'
    + ' diferente distinto distinta parecido normal general concreto concreta particular obviamente'
    + ' practicamente exactamente directamente igualmente generalmente finalmente inicialmente').split(' ')
);
/** Spoken filler that is never content: interjections, "o sea", and "bueno/pues/este/digamos" used as a pause (before a comma) */
const FILLER = /(?:^|[\s.,;(])(eh+|ehm+|mmm+|o sea|(?:bueno|vale|pues|digamos|este|pues nada)(?=\s*[,…]|\.\.\.))(?=[\s.,;?!)…]|$)/gi;
const TIME_MARK = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function stripMath(text: string): { text: string; blocks: string[]; inline: string[]; unbalanced: boolean } {
  const blocks: string[] = [];
  const inline: string[] = [];
  let rest = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr: string) => { blocks.push(expr.trim()); return ' '; });
  rest = rest.replace(/(?<![\\$\d])\$([^\n$]{1,300}?)\$(?!\d)/g, (_, expr: string) => { inline.push(expr.trim()); return ' '; });
  // A lone "$$" left over means a block that was never closed
  const unbalanced = /\$\$/.test(rest);
  return { text: rest, blocks, inline, unbalanced };
}

function formulaBroken(expr: string, display: boolean): boolean {
  try {
    katex.renderToString(expr, { displayMode: display, throwOnError: true, strict: 'ignore', output: 'html' });
    return false;
  } catch {
    return true;
  }
}

/** Figures worth checking: percentages, decimals and numbers with 2+ digits (not list numbers or clock marks). */
export function figuresIn(text: string): string[] {
  const clean = text
    .replace(TIME_MARK, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ') // clock times and ranges: "18:00 a 20:00"
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ') // ISO dates
    .replace(/\b\d+[A-Za-zÁÉÍÓÚÑáéíóúñ]+\b/g, ' ') // course codes and units glued to letters: "02MUIN", "10k"
    .replace(/\b[A-Za-zÁÉÍÓÚÑáéíóúñ]+\d+\b/g, ' ') // "ISO9001", "M3"
    .replace(/^\s*\d+[.)]\s/gm, ' ')
    .replace(/^#{1,6}\s*\d+(?:\.\d+)*\.?\s/gm, ' ');
  const found = new Set<string>();
  for (const m of clean.matchAll(/\d+(?:[.,]\d+)?\s?%?/g)) {
    const raw = m[0].replace(/\s/g, '');
    const digits = raw.replace(/[^\d]/g, '');
    if (raw.includes('%') || /[.,]/.test(raw) || digits.length >= 2) found.add(raw.replace(',', '.'));
  }
  return [...found];
}

export function transcriptHasFigure(figure: string, haystack: string): boolean {
  const bare = figure.replace('%', '');
  const variants = new Set([bare, bare.replace('.', ','), bare.replace('.', ' ')]);
  // "1.000" in the notes may be "1000" or "mil" in the transcript, so thousands separators are ignored
  variants.add(bare.replace(/\./g, ''));
  // "80.000" may be said "80 mil"
  const thousands = /^(\d{1,3})\.000$/.exec(bare);
  if (thousands) variants.add(`${thousands[1]} mil`);
  return [...variants].some((v) => v && new RegExp(`(?<![\\d])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`).test(haystack));
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of fold(text).split(/[^a-z0-9ñ]+/)) if (w.length >= 4) out.add(w.slice(0, STEM));
  return out;
}

/** The technical words a class keeps coming back to, most frequent first. */
export function keyTermsOf(segments: TranscriptSegment[], limit = KEY_TERMS): string[] {
  const counts = new Map<string, { word: string; n: number }>();
  for (const s of segments) {
    for (const w of fold(s.text).split(/[^a-z0-9ñ]+/)) {
      if (w.length < MIN_TERM_LENGTH || COMMON.has(w) || /^\d/.test(w) || SPEECH_ENDING.test(w)) continue;
      const stem = w.slice(0, STEM);
      const cur = counts.get(stem);
      if (cur) { cur.n++; if (w.length < cur.word.length) cur.word = w; } else counts.set(stem, { word: w, n: 1 });
    }
  }
  return [...counts.values()].filter((c) => c.n >= MIN_TERM_COUNT).sort((a, b) => b.n - a.n).slice(0, limit).map((c) => c.word);
}

export function assessNotes(markdown: string, segments: TranscriptSegment[]): NotesQuality {
  const issues: string[] = [];
  const durationS = segments.length ? Math.max(...segments.map((s) => s.end)) : 0;
  const minutes = Math.max(durationS / 60, 0.1);
  const transcript = segments.map((s) => s.text).join(' ');

  // Formulas
  const math = stripMath(markdown);
  const broken = [
    ...math.blocks.filter((e) => formulaBroken(e, true)),
    ...math.inline.filter((e) => formulaBroken(e, false)),
  ];
  const totalFormulas = math.blocks.length + math.inline.length;
  if (broken.length) issues.push(`${broken.length} fórmula(s) que KaTeX no puede dibujar`);
  if (math.unbalanced) issues.push('Un bloque $$ sin cerrar');

  // Time marks
  const marks = [...markdown.matchAll(TIME_MARK)].map((m) => parseClock(m[1]!)).filter((n): n is number => n !== null);
  const outOfClass = durationS > 0 ? marks.filter((s) => s > durationS + 5).length : 0;
  if (outOfClass) issues.push(`${outOfClass} marca(s) de tiempo más allá del final de la clase`);

  // Figures
  const notesFigures = figuresIn(math.text);
  const unsupported = notesFigures.filter((f) => !transcriptHasFigure(f, transcript));
  if (unsupported.length) issues.push(`${unsupported.length} cifra(s) que la clase no dice: ${unsupported.slice(0, 5).join(', ')}`);

  // Coverage of the class's own vocabulary
  const terms = keyTermsOf(segments);
  const inNotes = stems(markdown);
  const missing = terms.filter((t) => !inNotes.has(fold(t).slice(0, STEM)));
  const ratio = terms.length ? (terms.length - missing.length) / terms.length : 1;
  if (terms.length && ratio < 0.6) issues.push(`Solo recoge ${Math.round(ratio * 100)} % del vocabulario clave de la clase`);

  // Filler
  const fillerHits = [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(FILLER)].map((m) => m[1]!.toLowerCase());
  if (fillerHits.length) issues.push(`${fillerHits.length} muletilla(s) sin quitar`);

  // Structure
  const headings = (markdown.match(/^#{1,6}\s/gm) ?? []).length;
  const callouts = (markdown.match(/^>\s*\[!\w+\]/gm) ?? []).length;

  const charsPerMinute = Math.round(markdown.length / minutes);
  if (segments.length && charsPerMinute < 120) issues.push(`Apuntes muy escasos (${charsPerMinute} caracteres por minuto de clase)`);
  if (marks.length === 0 && segments.length) issues.push('Sin marcas de tiempo: no se puede saltar al audio');

  // Score: each part is a share of 100, so a version that fixes one failure shows up
  const formulaPart = totalFormulas ? 1 - broken.length / totalFormulas : 1;
  const marksPart = marks.length ? 1 - outOfClass / marks.length : 0;
  const figuresPart = notesFigures.length ? 1 - unsupported.length / notesFigures.length : 1;
  const fillerPart = Math.max(0, 1 - fillerHits.length / 10);
  const densityPart = Math.min(1, charsPerMinute / 400);
  const score = Math.round(
    100 * (0.2 * formulaPart + 0.15 * marksPart + 0.2 * figuresPart + 0.25 * ratio + 0.1 * fillerPart + 0.1 * densityPart)
    - (math.unbalanced ? 5 : 0)
  );

  return {
    chars: markdown.length,
    minutes: Math.round(minutes * 10) / 10,
    charsPerMinute,
    formulas: { total: totalFormulas, broken },
    timeMarks: { total: marks.length, outOfClass, perTenMinutes: Math.round((marks.length / minutes) * 100) / 10 },
    figures: { total: notesFigures.length, unsupported },
    coverage: { keyTerms: terms.length, covered: terms.length - missing.length, ratio: Math.round(ratio * 100) / 100, missing },
    filler: { count: fillerHits.length, samples: [...new Set(fillerHits)].slice(0, 5) },
    structure: { headings, callouts, unbalancedMath: math.unbalanced },
    score: Math.max(0, Math.min(100, score)),
    issues,
  };
}

/** One line per class for the terminal. */
export function formatQuality(label: string, q: NotesQuality): string {
  const bad = q.formulas.broken.length;
  return `${String(q.score).padStart(3)}  ${label}  ·  ${q.charsPerMinute} c/min · vocab ${Math.round(q.coverage.ratio * 100)} % · `
    + `marcas ${q.timeMarks.total} · cifras ${q.figures.unsupported.length}/${q.figures.total} sin respaldo · fórmulas rotas ${bad}/${q.formulas.total} · muletillas ${q.filler.count}`;
}
