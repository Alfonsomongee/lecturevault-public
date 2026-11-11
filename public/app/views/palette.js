// Command palette (Ctrl+K): jump anywhere by typing. Sections and courses are matched here; classes, dates,
// tasks and transcript lines come from /api/palette. Enter opens the selected row, Esc closes.
import { api, html, mount, icon, fold, msClock, highlight, courseCode, courseHref, relativeDay, titleOf, READ_ONLY } from '../util.js';
import { state, go } from '../main.js';

const PLACES = READ_ONLY
  ? [['Todas las clases', '#/classes', 'library'], ['Exámenes: banco y práctica', '#/exams', 'exam']]
  : [
      ['Inicio', '#/', 'home'],
      ['Calendario', '#/calendar', 'calendar'],
      ['Por revisar', '#/inbox', 'inbox'],
      ['Clases', '#/classes', 'library'],
      ['Exámenes: banco y práctica', '#/exams', 'exam'],
      ['Repaso', '#/study', 'cards'],
      ['Preguntar', '#/ask', 'chat'],
      ['Ajustes', '#/settings', 'settings'],
    ];
const COURSE_TABS = READ_ONLY
  ? [['teoria', 'Teoría'], ['sesiones', 'Sesiones'], ['ficha', 'Temario y Ficha'], ['trabajos', 'Trabajos'], ['examenes', 'Exámenes']]
  : [['ficha', 'Ficha'], ['notas', 'Notas'], ['trabajos', 'Trabajos'], ['examenes', 'Exámenes'], ['teoria', 'Teoría']];

let dialog = null;

function courses() {
  const known = new Set(state.catalog.map((c) => c.label));
  return [...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter((c) => c && !known.has(c))];
}

/** Rows that need no server: sections, courses and their tabs. Every word of the query has to appear. */
function localRows(q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => fold(text).includes(w));
  const rows = PLACES.filter(([label]) => hit(label)).map(([label, href, ico]) => ({ group: 'Ir a', label, href, ico }));
  for (const c of courses()) {
    if (hit(c)) rows.push({ group: 'Asignaturas', label: c, href: courseHref(c), ico: 'library' });
    if (words.length) {
      for (const [tab, label] of COURSE_TABS) {
        if (hit(`${c} ${label}`) && !hit(c)) rows.push({ group: 'Asignaturas', label: `${label} · ${c}`, href: courseHref(c, tab), ico: 'chevron' });
      }
    }
  }
  return rows;
}

function remoteRows(q, data) {
  const rows = [];
  for (const r of data.classes) {
    rows.push({ group: 'Clases', label: titleOf(r), sub: courseCode(r.course), href: `#/r/${r.id}`, ico: 'play' });
  }
  for (const e of data.events) {
    rows.push({ group: 'Fechas', label: e.title, sub: `${courseCode(e.course)}${e.date ? ` · ${relativeDay(e.date)}` : ' · sin fecha'}`, href: courseHref(e.course, e.exam_id ? 'examenes' : e.deliverable_id ? 'trabajos' : 'calendario'), ico: 'calendar' });
  }
  for (const t of data.tasks) {
    rows.push({ group: 'Tareas', label: t.text, sub: courseCode(t.course), href: `#/r/${t.recording_id}?t=${Math.max(0, Math.floor(t.t_ms / 1000) - 3)}`, ico: 'check' });
  }
  for (const h of data.hits) {
    rows.push({ group: 'En las clases', snippet: h.snippet, sub: `${h.recordingTitle} · ${msClock(h.startMs)}`, href: `#/r/${h.recordingId}?t=${Math.floor(h.startMs / 1000)}&tab=${h.source === 'notes' ? 'notes' : 'transcript'}`, ico: 'search' });
  }
  rows.push({ group: 'Más', label: `Buscar «${q}» en todas las clases`, href: `#/search?q=${encodeURIComponent(q)}`, ico: 'search' });
  if (!READ_ONLY) rows.push({ group: 'Más', label: `Preguntar «${q}»`, href: `#/ask?q=${encodeURIComponent(q)}`, ico: 'chat' });
  return rows;
}

export function openPalette() {
  if (dialog) { dialog.querySelector('input').select(); return; }
  dialog = document.createElement('dialog');
  dialog.className = 'modal palette';
  dialog.setAttribute('aria-label', 'Ir a');
  const placeholder = READ_ONLY ? 'Ir a una asignatura, clase o buscar en las clases…' : 'Ir a una asignatura, clase, fecha o buscar en las clases…';
  dialog.innerHTML = `<input class="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
      placeholder="${placeholder}" maxlength="120" autocomplete="off" spellcheck="false">
    <div class="palette-list" id="palette-list" role="listbox"></div>
    <div class="palette-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> moverse</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> cerrar</span></div>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('.palette-list');
  let rows = [];
  let active = 0;
  let seq = 0;
  let timer;

  const draw = () => {
    let group = '';
    mount(list, html`${rows.length ? rows.map((r, i) => {
      const head = r.group !== group ? html`<div class="palette-group" role="presentation">${(group = r.group)}</div>` : '';
      return html`${head}<a class="palette-row" id="pal-${i}" role="option" href="${r.href}" aria-selected="${i === active}" data-i="${i}">
        ${icon(r.ico, 14)}<span class="palette-main">${r.snippet ? html`<span class="snippet">${highlight(r.snippet)}</span>` : r.label}</span>
        ${r.sub ? html`<span class="palette-sub">${r.sub}</span>` : ''}</a>`;
    }) : html`<p class="muted small palette-empty">Sin resultados.</p>`}`);
    input.setAttribute('aria-activedescendant', rows.length ? `pal-${active}` : '');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  const update = () => {
    const q = input.value.trim();
    rows = localRows(q);
    active = 0;
    draw();
    clearTimeout(timer);
    if (q.length < 2) return;
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const data = await api(`/api/palette?q=${encodeURIComponent(q)}`);
        if (mine !== seq || !dialog) return; // a newer query is on its way
        rows = [...localRows(q), ...remoteRows(q, data)];
        draw();
      } catch { /* the local rows stay */ }
    }, 120);
  };

  const close = () => dialog?.close();
  const open = (i) => {
    const r = rows[i];
    if (!r) return;
    if (READ_ONLY && r.href === '#/classes') state.course = '';
    close();
    go(r.href);
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(active);
    }
  });
  list.addEventListener('click', (e) => {
    const a = e.target.closest('[data-i]');
    if (!a) return;
    e.preventDefault();
    open(Number(a.dataset.i));
  });
  // A click on the backdrop lands on the dialog itself
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); dialog = null; });

  dialog.showModal();
  update();
}
