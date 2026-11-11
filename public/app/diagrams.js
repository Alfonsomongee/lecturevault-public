// Draws the ```plot, ```chart and ```flow blocks of the notes as SVG. The specs are JSON the server already
// validated; this still treats them as untrusted: everything is built with createElementNS/textContent (never
// innerHTML), numbers are re-checked, and a block that cannot be drawn stays a plain code block with a message.

import { compile, sample } from './expr.js';

const NS = 'http://www.w3.org/2000/svg';
const KINDS = ['plot', 'chart', 'flow'];
const SERIES_CLASSES = ['s0', 's1', 's2', 's3'];

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const fmt = (v) => {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e+', 'e');
  return String(Number(v.toPrecision(4)));
};

/** About `count` round tick values covering [min, max] (1, 2, 5 × 10^n steps). */
export function niceTicks(min, max, count = 6) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : Number(t.toPrecision(12)));
  return ticks;
}

function frame(width, height, label) {
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'dg-svg', role: 'img', 'aria-label': label || 'Gráfico', preserveAspectRatio: 'xMidYMid meet' });
  root.append(svg('title', {}, label || 'Gráfico'));
  return root;
}

function legend(root, items, x, y) {
  let cx = x;
  items.forEach((item, i) => {
    if (!item.name) return;
    const g = svg('g', { class: `dg-legend ${SERIES_CLASSES[i % 4]}` });
    g.append(svg('rect', { x: cx, y: y - 8, width: 12, height: 4, rx: 2, class: 'dg-swatch' }), svg('text', { x: cx + 17, y: y - 2, class: 'dg-label' }, item.name));
    root.append(g);
    cx += 28 + item.name.length * 6.2;
  });
}

// ── plot ────────────────────────────────────────────────────────────────────

function buildPlot(spec) {
  const W = 640, H = 380;
  const m = { l: 56, r: 18, t: spec.title ? 38 : 18, b: spec.xLabel ? 52 : 38 };
  const xMin = num(spec.xMin, -10), xMax = num(spec.xMax, 10);
  if (!(xMin < xMax)) throw new Error('Intervalo de x no válido');

  const curves = (Array.isArray(spec.curves) ? spec.curves : []).slice(0, 4).map((c, i) => {
    const fn = compile(String(c.expr || ''));
    return { fn, label: String(c.label || ''), cls: SERIES_CLASSES[i % 4], pts: sample(fn, xMin, xMax, 480) };
  });
  const points = (Array.isArray(spec.points) ? spec.points : []).slice(0, 24).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  let yMin, yMax;
  if (Number.isFinite(spec.yMin) && Number.isFinite(spec.yMax)) { yMin = spec.yMin; yMax = spec.yMax; }
  else {
    // Trim the extremes so an asymptote (1/x, tan x) does not flatten the rest of the curve
    const ys = curves.flatMap((c) => c.pts.filter(Boolean).map((p) => p.y)).concat(points.map((p) => p.y)).sort((a, b) => a - b);
    if (ys.length === 0) throw new Error('La función no tiene valores en ese intervalo');
    const lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.ceil(ys.length * 0.98) - 1];
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    yMin = lo - pad; yMax = hi + pad;
  }
  if (!(yMin < yMax)) { yMin -= 1; yMax += 1; }

  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const X = (x) => m.l + ((x - xMin) / (xMax - xMin)) * pw;
  const Y = (y) => m.t + (1 - (y - yMin) / (yMax - yMin)) * ph;
  const clampY = (y) => Math.max(m.t - 40, Math.min(m.t + ph + 40, Y(y)));

  const root = frame(W, H, spec.title || `Gráfica de ${curves.map((c) => c.label || 'una función').join(', ')}`);
  if (spec.title) root.append(svg('text', { x: W / 2, y: 22, class: 'dg-title', 'text-anchor': 'middle' }, spec.title));
  const clip = svg('clipPath', { id: `dgc${Math.random().toString(36).slice(2, 8)}` });
  clip.append(svg('rect', { x: m.l, y: m.t, width: pw, height: ph }));
  root.append(svg('defs', {}, undefined));
  root.lastChild.append(clip);

  for (const t of niceTicks(xMin, xMax, 7)) {
    root.append(svg('line', { x1: X(t), x2: X(t), y1: m.t, y2: m.t + ph, class: 'dg-grid' }), svg('text', { x: X(t), y: m.t + ph + 16, class: 'dg-tick', 'text-anchor': 'middle' }, fmt(t)));
  }
  for (const t of niceTicks(yMin, yMax, 6)) {
    root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: Y(t), y2: Y(t), class: 'dg-grid' }), svg('text', { x: m.l - 8, y: Y(t) + 4, class: 'dg-tick', 'text-anchor': 'end' }, fmt(t)));
  }
  root.append(svg('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'dg-box' }));
  const axisX = yMin <= 0 && yMax >= 0 ? Y(0) : null, axisY = xMin <= 0 && xMax >= 0 ? X(0) : null;
  if (axisX !== null) root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: axisX, y2: axisX, class: 'dg-axis' }));
  if (axisY !== null) root.append(svg('line', { x1: axisY, x2: axisY, y1: m.t, y2: m.t + ph, class: 'dg-axis' }));
  if (spec.xLabel) root.append(svg('text', { x: m.l + pw / 2, y: H - 8, class: 'dg-label', 'text-anchor': 'middle' }, spec.xLabel));
  if (spec.yLabel) root.append(svg('text', { x: 14, y: m.t + ph / 2, class: 'dg-label', 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ph / 2})` }, spec.yLabel));

  const plot = svg('g', { 'clip-path': `url(#${clip.id})` });
  for (const c of curves) {
    // Break the line at gaps and at jumps taller than the plot (asymptotes)
    let d = '', pen = false, prev = null;
    for (const p of c.pts) {
      if (!p || (prev && Math.abs(Y(p.y) - Y(prev.y)) > ph * 1.5)) { pen = false; prev = p; if (!p) continue; }
      d += `${pen ? 'L' : 'M'}${X(p.x).toFixed(1)} ${clampY(p.y).toFixed(1)}`;
      pen = true; prev = p;
    }
    if (d) plot.append(svg('path', { d, class: `dg-line ${c.cls}` }));
  }
  root.append(plot);
  for (const p of points) {
    const g = svg('g', { class: 'dg-point' });
    g.append(svg('circle', { cx: X(p.x), cy: Y(p.y), r: 4 }), svg('title', {}, `${p.label ? p.label + ': ' : ''}(${fmt(p.x)}, ${fmt(p.y)})`));
    if (p.label) g.append(svg('text', { x: X(p.x) + 7, y: Y(p.y) - 7, class: 'dg-label' }, String(p.label)));
    root.append(g);
  }
  legend(root, curves.map((c) => ({ name: c.label })), m.l + 8, m.t + 16);

  // Hover: a guide that follows the pointer and reads the value of each curve
  const guide = svg('g', { class: 'dg-guide', visibility: 'hidden' });
  const vline = svg('line', { y1: m.t, y2: m.t + ph });
  const readout = svg('text', { x: m.l + pw - 6, y: m.t + 14, class: 'dg-readout', 'text-anchor': 'end' });
  const dots = curves.map((c) => svg('circle', { r: 4, class: `dg-dot ${c.cls}` }));
  guide.append(vline, readout, ...dots);
  const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', class: 'dg-hit' });
  const move = (ev) => {
    const box = root.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * W;
    const x = Math.max(xMin, Math.min(xMax, xMin + ((sx - m.l) / pw) * (xMax - xMin)));
    vline.setAttribute('x1', X(x)); vline.setAttribute('x2', X(x));
    const ys = curves.map((c, i) => {
      let y; try { y = c.fn(x); } catch { y = NaN; }
      const ok = Number.isFinite(y) && y >= yMin && y <= yMax;
      dots[i].setAttribute('visibility', ok ? 'visible' : 'hidden');
      if (ok) { dots[i].setAttribute('cx', X(x)); dots[i].setAttribute('cy', Y(y)); }
      return y;
    });
    readout.textContent = `x = ${fmt(x)}${ys.length ? ' · ' + ys.map((y) => `y = ${fmt(y)}`).join(' · ') : ''}`;
    guide.setAttribute('visibility', 'visible');
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => guide.setAttribute('visibility', 'hidden'));
  root.append(guide, hit);
  return root;
}

// ── chart ───────────────────────────────────────────────────────────────────

function buildChart(spec) {
  const labels = (Array.isArray(spec.labels) ? spec.labels : []).slice(0, 16).map(String);
  const series = (Array.isArray(spec.series) ? spec.series : []).slice(0, 4).map((s) => ({ name: String(s.name || ''), values: (Array.isArray(s.values) ? s.values : []).map((v) => num(v)) }));
  if (labels.length < 2 || series.length === 0 || series.some((s) => s.values.length !== labels.length)) throw new Error('Datos incompletos');
  const unit = spec.unit ? String(spec.unit) : '';
  const type = spec.type === 'line' || spec.type === 'pie' ? spec.type : 'bar';
  const label = spec.title || 'Gráfico de datos';
  if (type === 'pie') return buildPie(spec, labels, series[0], unit, label);

  const W = 640, H = 360;
  const m = { l: 56, r: 18, t: spec.title ? 38 : 18, b: 54 };
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi, 6);
  const yMin = Math.min(lo, ticks[0]), yMax = Math.max(hi, ticks[ticks.length - 1]) || 1;
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * ph;
  const band = pw / labels.length;

  const root = frame(W, H, label);
  if (spec.title) root.append(svg('text', { x: W / 2, y: 22, class: 'dg-title', 'text-anchor': 'middle' }, spec.title));
  for (const t of ticks) root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: Y(t), y2: Y(t), class: 'dg-grid' }), svg('text', { x: m.l - 8, y: Y(t) + 4, class: 'dg-tick', 'text-anchor': 'end' }, fmt(t) + (unit && t !== 0 ? '' : '')));
  root.append(svg('line', { x1: m.l, x2: m.l + pw, y1: Y(0), y2: Y(0), class: 'dg-axis' }));
  labels.forEach((l, i) => {
    const short = l.length > 14 && labels.length > 6 ? l.slice(0, 13) + '…' : l;
    root.append(svg('text', { x: m.l + band * (i + 0.5), y: m.t + ph + 18, class: 'dg-tick', 'text-anchor': 'middle' }, short));
  });
  if (unit) root.append(svg('text', { x: 14, y: m.t + ph / 2, class: 'dg-label', 'text-anchor': 'middle', transform: `rotate(-90 14 ${m.t + ph / 2})` }, unit));

  if (type === 'bar') {
    const gap = Math.min(18, band * 0.25), bw = (band - gap) / series.length;
    series.forEach((s, si) => s.values.forEach((v, i) => {
      const x = m.l + band * i + gap / 2 + bw * si;
      const g = svg('g', { class: `dg-bar ${SERIES_CLASSES[si % 4]}` });
      g.append(svg('rect', { x, y: Math.min(Y(v), Y(0)), width: Math.max(1, bw - 2), height: Math.abs(Y(v) - Y(0)), rx: 3 }), svg('title', {}, `${labels[i]}${s.name ? ' · ' + s.name : ''}: ${fmt(v)}${unit ? ' ' + unit : ''}`));
      if (labels.length <= 8 && series.length <= 2) g.append(svg('text', { x: x + bw / 2 - 1, y: (v >= 0 ? Y(v) - 5 : Y(v) + 14), class: 'dg-value', 'text-anchor': 'middle' }, fmt(v)));
      root.append(g);
    }));
  } else {
    series.forEach((s, si) => {
      const cls = SERIES_CLASSES[si % 4];
      const xs = s.values.map((_, i) => m.l + band * (i + 0.5));
      root.append(svg('path', { d: s.values.map((v, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${Y(v).toFixed(1)}`).join(''), class: `dg-line ${cls}` }));
      s.values.forEach((v, i) => {
        const g = svg('g', { class: `dg-dot-group ${cls}` });
        g.append(svg('circle', { cx: xs[i], cy: Y(v), r: 4.5, class: 'dg-dot' }), svg('title', {}, `${labels[i]}${s.name ? ' · ' + s.name : ''}: ${fmt(v)}${unit ? ' ' + unit : ''}`));
        root.append(g);
      });
    });
  }
  if (series.length > 1 || series[0].name) legend(root, series, m.l + 8, H - 8);
  return root;
}

function buildPie(spec, labels, serie, unit, label) {
  const W = 640, H = 340;
  const total = serie.values.reduce((a, v) => a + Math.max(0, v), 0);
  if (!(total > 0)) throw new Error('Sin datos positivos');
  const cx = 190, cy = spec.title ? 188 : 170, r = 120;
  const root = frame(W, H, label);
  if (spec.title) root.append(svg('text', { x: W / 2, y: 22, class: 'dg-title', 'text-anchor': 'middle' }, spec.title));
  let angle = -Math.PI / 2;
  serie.values.forEach((v, i) => {
    const share = Math.max(0, v) / total;
    if (share <= 0) return;
    const a2 = angle + share * 2 * Math.PI;
    const big = share > 0.5 ? 1 : 0;
    const pt = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
    const d = share >= 0.9999 ? `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0` : `M${cx} ${cy}L${pt(angle)}A${r} ${r} 0 ${big} 1 ${pt(a2)}Z`;
    const g = svg('g', { class: `dg-slice c${i % 8}` });
    g.append(svg('path', { d }), svg('title', {}, `${labels[i]}: ${fmt(v)}${unit ? ' ' + unit : ''} (${(share * 100).toFixed(1)} %)`));
    root.append(g);
    angle = a2;
  });
  labels.forEach((l, i) => {
    const y = 70 + i * 22;
    const g = svg('g', { class: `dg-slice c${i % 8}` });
    g.append(svg('rect', { x: 360, y: y - 10, width: 12, height: 12, rx: 3 }));
    // With a % unit the value already is the share: do not say it twice
    const share = `${((Math.max(0, serie.values[i]) / total) * 100).toFixed(0)} %`;
    root.append(g, svg('text', { x: 380, y, class: 'dg-label' }, `${l}: ${fmt(serie.values[i])}${unit ? ' ' + unit : ''}${unit.trim() === '%' ? '' : ` · ${share}`}`));
  });
  return root;
}

// ── flow ────────────────────────────────────────────────────────────────────

function wrap(label, width = 22) {
  const lines = [];
  let line = '';
  for (const word of String(label).split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function buildFlow(spec) {
  const nodes = (Array.isArray(spec.nodes) ? spec.nodes : []).slice(0, 14).map((n) => ({ id: String(n.id), kind: ['start', 'end', 'decision'].includes(n.kind) ? n.kind : 'step', lines: wrap(n.label) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = (Array.isArray(spec.edges) ? spec.edges : []).slice(0, 24).filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  if (nodes.length < 2 || edges.length === 0) throw new Error('Diagrama incompleto');
  const horizontal = spec.direction !== 'TD';

  // Layers: longest path from the sources, ignoring edges that point back up the DFS (loops)
  const out = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.from === n.id)]));
  const state = new Map(), forward = [];
  const dfs = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      if (state.get(e.to) === 1) continue; // back edge
      forward.push(e);
      if (!state.has(e.to)) dfs(e.to);
    }
    state.set(id, 2);
  };
  const hasIncoming = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!hasIncoming.has(n.id) && !state.has(n.id)) dfs(n.id);
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) for (const e of forward) layer.set(e.to, Math.max(layer.get(e.to), layer.get(e.from) + 1));

  for (const n of nodes) {
    const textW = Math.max(...n.lines.map((l) => l.length), 4) * 7 + 28;
    n.w = n.kind === 'decision' ? Math.min(textW * 1.45, 230) : Math.min(Math.max(textW, 84), 190);
    n.h = (n.kind === 'decision' ? 1.7 : 1) * (22 + n.lines.length * 16);
    n.layer = layer.get(n.id);
  }
  const layers = [];
  for (const n of nodes) (layers[n.layer] = layers[n.layer] || []).push(n);
  const GAP_LAYER = horizontal ? 54 : 40, GAP_NODE = 22, PAD = 24, TOP = spec.title ? 30 : 0;
  const crossOf = (l) => l.reduce((a, n) => a + (horizontal ? n.h : n.w), 0) + GAP_NODE * (l.length - 1);
  const maxCross = Math.max(...layers.filter(Boolean).map(crossOf));
  let along = PAD;
  layers.forEach((l) => {
    if (!l) return;
    const thickness = Math.max(...l.map((n) => (horizontal ? n.w : n.h)));
    let across = PAD + (maxCross - crossOf(l)) / 2;
    for (const n of l) {
      const cross = horizontal ? n.h : n.w;
      const mainStart = along + (thickness - (horizontal ? n.w : n.h)) / 2;
      n.x = horizontal ? mainStart : across;
      n.y = horizontal ? across : mainStart;
      across += cross + GAP_NODE;
    }
    along += thickness + GAP_LAYER;
  });
  const W = horizontal ? along - GAP_LAYER + PAD : maxCross + PAD * 2;
  const H = (horizontal ? maxCross + PAD * 2 : along - GAP_LAYER + PAD) + TOP;
  for (const n of nodes) n.y += TOP;

  const root = frame(Math.max(W, 200), Math.max(H, 120), spec.title || 'Diagrama de proceso');
  const defs = svg('defs');
  const marker = svg('marker', { id: 'dg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(svg('path', { d: 'M0 0L10 5L0 10z', class: 'dg-arrowhead' }));
  defs.append(marker);
  root.append(defs);
  if (spec.title) root.append(svg('text', { x: W / 2, y: 20, class: 'dg-title', 'text-anchor': 'middle' }, spec.title));

  const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    const back = a.layer >= b.layer;
    const ca = center(a), cb = center(b);
    let p0, p1, c0, c1;
    if (!back) {
      p0 = horizontal ? { x: a.x + a.w, y: ca.y } : { x: ca.x, y: a.y + a.h };
      p1 = horizontal ? { x: b.x, y: cb.y } : { x: cb.x, y: b.y };
      const k = ((horizontal ? p1.x - p0.x : p1.y - p0.y)) / 2;
      c0 = horizontal ? { x: p0.x + k, y: p0.y } : { x: p0.x, y: p0.y + k };
      c1 = horizontal ? { x: p1.x - k, y: p1.y } : { x: p1.x, y: p1.y - k };
    } else {
      // Loops go around the top (or the right side when the flow runs downwards)
      p0 = horizontal ? { x: ca.x, y: a.y } : { x: a.x + a.w, y: ca.y };
      p1 = horizontal ? { x: cb.x, y: b.y } : { x: b.x + b.w, y: cb.y };
      const bulge = 46;
      c0 = horizontal ? { x: p0.x, y: Math.min(p0.y, p1.y) - bulge } : { x: Math.max(p0.x, p1.x) + bulge, y: p0.y };
      c1 = horizontal ? { x: p1.x, y: Math.min(p0.y, p1.y) - bulge } : { x: Math.max(p0.x, p1.x) + bulge, y: p1.y };
    }
    root.append(svg('path', { d: `M${p0.x} ${p0.y}C${c0.x} ${c0.y} ${c1.x} ${c1.y} ${p1.x} ${p1.y}`, class: 'dg-edge', 'marker-end': 'url(#dg-arrow)' }));
    if (e.label) {
      const t = 0.5, mx = (1 - t) ** 3 * p0.x + 3 * (1 - t) ** 2 * t * c0.x + 3 * (1 - t) * t * t * c1.x + t ** 3 * p1.x;
      const my = (1 - t) ** 3 * p0.y + 3 * (1 - t) ** 2 * t * c0.y + 3 * (1 - t) * t * t * c1.y + t ** 3 * p1.y;
      const text = String(e.label), w = text.length * 6.4 + 10;
      root.append(svg('rect', { x: mx - w / 2, y: my - 9, width: w, height: 16, rx: 4, class: 'dg-edge-bg' }), svg('text', { x: mx, y: my + 3.5, class: 'dg-edge-label', 'text-anchor': 'middle' }, text));
    }
  }
  for (const n of nodes) {
    const g = svg('g', { class: `dg-node ${n.kind}` });
    const { x, y } = center(n);
    if (n.kind === 'decision') g.append(svg('polygon', { points: `${x},${n.y} ${n.x + n.w},${y} ${x},${n.y + n.h} ${n.x},${y}` }));
    else g.append(svg('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'step' ? 7 : n.h / 2 }));
    n.lines.forEach((line, i) => g.append(svg('text', { x, y: y + (i - (n.lines.length - 1) / 2) * 16 + 4.5, 'text-anchor': 'middle' }, line)));
    root.append(g);
  }
  return root;
}

// ── hydrate ─────────────────────────────────────────────────────────────────

const BUILDERS = { plot: buildPlot, chart: buildChart, flow: buildFlow };

/** Replace the diagram code blocks inside `root` by their drawing; a block that cannot be drawn keeps its code and says why. */
export function hydrateDiagrams(root) {
  for (const kind of KINDS) {
    for (const code of root.querySelectorAll(`pre > code.language-${kind}`)) {
      const pre = code.parentElement;
      const figure = document.createElement('figure');
      figure.className = `dg dg-${kind}`;
      try {
        const spec = JSON.parse(code.textContent || '');
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('No es un objeto JSON');
        figure.append(BUILDERS[kind](spec));
        pre.replaceWith(figure);
      } catch (err) {
        const note = document.createElement('p');
        note.className = 'dg-error muted small';
        note.textContent = `No se pudo dibujar ${kind === 'flow' ? 'este diagrama' : 'esta gráfica'}: ${err.message}`;
        pre.before(note);
      }
    }
  }
  return root;
}
