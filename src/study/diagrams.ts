/**
 * Charts and diagrams inside the notes. The model may write fenced blocks of three kinds, each a small JSON
 * spec that the browser draws as SVG (no code from the model ever runs):
 *
 *   ```plot   functions of x            {"xMin":-5,"xMax":5,"curves":[{"expr":"sin(x)/x"}]}
 *   ```chart  bar / line / pie          {"type":"bar","labels":["A","B"],"series":[{"name":"2024","values":[3,5]}]}
 *   ```flow   process or structure      {"nodes":[{"id":"a","label":"Inicio"}],"edges":[{"from":"a","to":"b"}]}
 *
 * The audio has no slides, so a chart the class never described would be made up. Every block is therefore
 * checked against what the range says: the numbers of a chart or a curve have to be said, and the labels of
 * a flow have to come from the class's own words. What fails is removed, with a warning, never kept.
 */

import { fold } from '../utils/text.js';
import { figuresIn, transcriptHasFigure } from './notes-quality.js';

export const DIAGRAM_KINDS = ['plot', 'chart', 'flow'] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

const MAX_DIAGRAMS_PER_RANGE = 3;
const MAX_TEXT = 60;
const MAX_TITLE = 90;
const MAX_CURVES = 4;
const MAX_POINTS = 24;
const MAX_CATEGORIES = 16;
const MAX_SERIES = 4;
const MAX_NODES = 14;
const MAX_EDGES = 24;
const MAX_EXPR = 200;
/** Share of flow labels that must reuse words of the range */
const MIN_FLOW_GROUNDED = 0.6;
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'ln', 'log', 'log10', 'log2', 'sqrt', 'abs', 'floor', 'ceil', 'sign', 'min', 'max', 'pow']);
const CONSTANTS = new Set(['pi', 'e', 'x']);

export interface DiagramResult {
  markdown: string;
  warnings: string[];
}

type Json = Record<string, unknown>;
class Reject extends Error {}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Syntax whitelist for an expression in x: only numbers, x, pi, e, the known functions and operators. */
export function expressionIsSafe(expr: string): boolean {
  if (!expr || expr.length > MAX_EXPR) return false;
  const src = expr.toLowerCase().replace(/[−–—]/g, '-').replace(/[·×⋅]/g, '*').replace(/π/g, 'pi').replace(/[²³]/g, '');
  if (!/^[0-9a-z_+\-*/^().,\s]*$/.test(src)) return false;
  let depth = 0;
  for (const ch of src) {
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const id of src.match(/[a-z_][a-z0-9_]*/g) ?? []) {
    if (!FUNCTIONS.has(id) && !CONSTANTS.has(id)) return false;
  }
  return true;
}

/** Every number written in the spec has to be one the range says. */
function assertSaid(values: (string | number)[], transcript: string, what: string): void {
  const unsaid = values.map((v) => String(v)).filter((v) => !transcriptHasFigure(v, transcript));
  if (unsaid.length > 0) throw new Reject(`${what} con cifras que la clase no dice (${[...new Set(unsaid)].slice(0, 3).join(', ')})`);
}

function cleanPlot(raw: Json, transcript: string): Json {
  const xMin = finite(raw['xMin']) ?? -10;
  const xMax = finite(raw['xMax']) ?? 10;
  if (!(xMin < xMax) || xMax - xMin > 1e6) throw new Reject('intervalo de x no válido');
  const yMin = finite(raw['yMin']);
  const yMax = finite(raw['yMax']);
  if ((yMin === null) !== (yMax === null) || (yMin !== null && yMax !== null && yMin >= yMax)) throw new Reject('intervalo de y no válido');

  const rawCurves = Array.isArray(raw['curves']) ? raw['curves'] : typeof raw['expr'] === 'string' ? [{ expr: raw['expr'], label: raw['label'] }] : [];
  const curves = rawCurves.filter(isObj).slice(0, MAX_CURVES).map((c) => {
    const expr = text(c['expr'], MAX_EXPR);
    if (!expressionIsSafe(expr)) throw new Reject(`expresión no válida «${expr.slice(0, 40)}»`);
    return { expr, label: text(c['label']) };
  });
  const points = (Array.isArray(raw['points']) ? raw['points'] : []).filter(isObj).slice(0, MAX_POINTS).flatMap((p) => {
    const x = finite(p['x']);
    const y = finite(p['y']);
    return x === null || y === null ? [] : [{ x, y, label: text(p['label']) }];
  });
  if (curves.length === 0 && points.length === 0) throw new Reject('sin curvas ni puntos');

  // Constants of the curves and coordinates of the points must come from the class (the plain 0-9 digits of
  // exponents and coefficients are too common to check; figuresIn only asks for 2+ digits, decimals and %)
  assertSaid([...curves.flatMap((c) => figuresIn(c.expr)), ...points.flatMap((p) => [p.x, p.y])], transcript, 'Gráfica');
  return {
    title: text(raw['title'], MAX_TITLE), xLabel: text(raw['xLabel']), yLabel: text(raw['yLabel']),
    xMin, xMax, ...(yMin !== null && yMax !== null ? { yMin, yMax } : {}), curves, points,
  };
}

function cleanChart(raw: Json, transcript: string): Json {
  const type = raw['type'] === 'line' || raw['type'] === 'pie' ? raw['type'] : 'bar';
  const labels = (Array.isArray(raw['labels']) ? raw['labels'] : []).slice(0, MAX_CATEGORIES).map((l) => text(l));
  if (labels.length < 2 || labels.some((l) => !l)) throw new Reject('menos de dos categorías con nombre');
  const series = (Array.isArray(raw['series']) ? raw['series'] : []).filter(isObj).slice(0, type === 'pie' ? 1 : MAX_SERIES).map((s) => {
    const values = (Array.isArray(s['values']) ? s['values'] : []).slice(0, labels.length);
    if (values.length !== labels.length || values.some((v) => finite(v) === null)) throw new Reject('series con valores que no son números o que no cuadran con las categorías');
    return { name: text(s['name']), values: values as number[] };
  });
  if (series.length === 0) throw new Reject('sin series');
  if (type === 'pie' && series[0]!.values.some((v) => v < 0)) throw new Reject('sector con valor negativo');
  assertSaid(series.flatMap((s) => s.values), transcript, 'Gráfico');
  return { type, title: text(raw['title'], MAX_TITLE), unit: text(raw['unit'], 12), labels, series };
}

function cleanFlow(raw: Json, transcript: string): Json {
  const nodes = (Array.isArray(raw['nodes']) ? raw['nodes'] : []).filter(isObj).slice(0, MAX_NODES).map((n) => ({
    id: text(n['id'], 20).replace(/[^A-Za-z0-9_]/g, ''),
    label: text(n['label'], 48),
    kind: n['kind'] === 'start' || n['kind'] === 'end' || n['kind'] === 'decision' ? n['kind'] : 'step',
  }));
  if (nodes.length < 2) throw new Reject('menos de dos nodos');
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!n.id || !n.label || ids.has(n.id)) throw new Reject('nodos sin id, sin texto o con id repetido');
    ids.add(n.id);
  }
  const seen = new Set<string>();
  const edges = (Array.isArray(raw['edges']) ? raw['edges'] : []).filter(isObj).slice(0, MAX_EDGES).flatMap((e) => {
    const from = text(e['from'], 20);
    const to = text(e['to'], 20);
    const key = `${from}>${to}`;
    if (!ids.has(from) || !ids.has(to) || from === to || seen.has(key)) return [];
    seen.add(key);
    return [{ from, to, label: text(e['label'], 24) }];
  });
  if (edges.length === 0) throw new Reject('sin conexiones válidas entre los nodos');

  // The steps of a process have to be the class's words, not the model's idea of the topic
  const said = new Set(fold(transcript).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  const grounded = nodes.filter((n) => fold(n.label).split(/[^a-z0-9ñ]+/).some((w) => w.length >= 5 && said.has(w.slice(0, 5)))).length;
  if (grounded / nodes.length < MIN_FLOW_GROUNDED) throw new Reject('diagrama cuyos pasos no salen de la clase');
  return { title: text(raw['title'], MAX_TITLE), direction: raw['direction'] === 'TD' ? 'TD' : 'LR', nodes, edges };
}

const CLEANERS: Record<DiagramKind, (raw: Json, transcript: string) => Json> = { plot: cleanPlot, chart: cleanChart, flow: cleanFlow };

/**
 * Check every ```plot / ```chart / ```flow block of a range's notes against the range's transcript.
 * A valid block is rewritten as clean canonical JSON; an invalid or surplus one is removed.
 */
export function validateDiagrams(markdown: string, transcript: string): DiagramResult {
  const warnings: string[] = [];
  let kept = 0;
  const out = markdown.replace(/^([ \t]*)```(plot|chart|flow)[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm, (_whole, _indent: string, kind: DiagramKind, body: string) => {
    try {
      if (kept >= MAX_DIAGRAMS_PER_RANGE) throw new Reject(`más de ${MAX_DIAGRAMS_PER_RANGE} por tramo`);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new Reject('JSON mal formado'); }
      if (!isObj(parsed)) throw new Reject('no es un objeto JSON');
      const clean = CLEANERS[kind](parsed, transcript);
      kept++;
      return `\`\`\`${kind}\n${JSON.stringify(clean)}\n\`\`\``;
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      warnings.push(`Se quitó un bloque «${kind}»: ${err.message}`);
      return '';
    }
  });
  return { markdown: out.replace(/\n{3,}/g, '\n\n'), warnings };
}
