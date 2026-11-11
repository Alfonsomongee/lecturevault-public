// Asignatura: Ficha (fixed sheet), Teoría (classes by syllabus block), Trabajos and Exámenes (one card per
// entity with everything said about it in any class), Calendario and every session.
// On the friends' read-only web: Teoría, Sesiones, Temario y Ficha, Trabajos and Exámenes (no calendar, materials or grades).
import {
  api, html, mount, icon, msClock, fmtDate, relativeDay, daysUntil, duration, courseChip, courseHref, titleOf,
  eventChip, SESSION_KINDS, toast, confirmDialog, renderMarkdown, downloadPdf, READ_ONLY,
} from '../util.js';
import { state, refreshMeta, renderRoute } from '../main.js';
import { renderCalendar } from './calendar.js';
import { enqueueJobs, jobFor, jobLabel } from '../jobs.js';
import { renderGrades } from './grades.js';

const TABS = READ_ONLY
  ? [['teoria', 'Teoría'], ['sesiones', 'Sesiones'], ['ficha', 'Temario y Ficha'], ['trabajos', 'Trabajos'], ['examenes', 'Exámenes']]
  : [['ficha', 'Ficha'], ['teoria', 'Teoría'], ['materiales', 'Materiales'], ['trabajos', 'Trabajos'], ['examenes', 'Exámenes'], ['notas', 'Notas'], ['calendario', 'Calendario'], ['sesiones', 'Sesiones']];
const KB = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const STATUS = { todo: 'Pendiente', doing: 'En curso', done: 'Entregado' };
const MENTION_KINDS = { requirement: 'Requisito', syllabus: 'Temario', format: 'Formato', date: 'Fecha', tip: 'Consejo', grading: 'Evaluación' };

const listen = (recordingId, tMs, label = msClock(tMs)) =>
  html`<a class="btn sm" href="#/r/${recordingId}?t=${Math.max(0, Math.floor(tMs / 1000) - 3)}">${icon('play', 12)} ${label}</a>`;

const countdown = (date) => date
  ? html`<span class="tag ${daysUntil(date) < 0 ? 'tag-red' : ''}">${fmtDate(date)}</span> <span class="muted small">${relativeDay(date)}</span>`
  : html`<span class="tag tag-yellow">Sin fecha</span>`;

/** "Clase 3 · 12:40 ▶": what was said, by whom-class and when. */
function mentionItem(m) {
  return html`<div class="item"><div class="body">
    <div class="tags"><span class="tag">${MENTION_KINDS[m.kind] || m.kind}</span>${m.confidence === 'low' ? html`<span class="tag tag-red">Dudoso</span>` : ''}</div>
    <div class="txt" style="margin-top:4px">${m.text}</div>
    ${m.quote ? html`<q>${m.quote}</q>` : ''}
    <div class="meta">${listen(m.recording_id, m.t_ms, `${m.class_number ? `Clase ${m.class_number} · ` : ''}${msClock(m.t_ms)}`)}<span>${m.recording_title || ''}</span></div>
  </div></div>`;
}

/** Nested grading table: parents with their parts underneath. */
function gradingTable(items) {
  if (!items.length) return html`<p class="muted small">${READ_ONLY ? 'Sin criterios de evaluación registrados.' : 'Sin criterios de evaluación todavía.'}</p>`;
  const children = (id) => items.filter((g) => g.parent_id === id);
  const row = (g, depth) => html`<tr><td style="padding-left:${8 + depth * 18}px">${g.name}${g.source === 'user' ? html` <span class="tag">Manual</span>` : ''}</td>
    <td class="num">${g.weight_pct !== null ? `${g.weight_pct} %` : '—'}</td><td class="num">${g.min_grade !== null ? `≥ ${g.min_grade}` : ''}</td>
    <td class="acts">${g.recording_id ? listen(g.recording_id, g.t_ms) : ''}</td></tr>${children(g.id).map((c) => row(c, depth + 1))}`;
  return html`<table class="db"><thead><tr><th>Criterio</th><th>Peso</th><th>Mínimo</th><th></th></tr></thead>
    <tbody>${items.filter((g) => !g.parent_id || !items.some((p) => p.id === g.parent_id)).map((g) => row(g, 0))}</tbody></table>`;
}

/** A captured class the session analysis has not run on yet: it feeds nothing in the campus. */
const unanalysed = (s) => s.segment_count > 0 && !s.analysis_version;
const processButton = (s) => {
  if (!state.ai) return '';
  const job = jobFor(s.id);
  return job ? html`<button class="btn sm" type="button" disabled>${jobLabel(job)}</button>`
    : html`<button class="btn sm" data-process="${s.id}" type="button">Generar con IA</button>`;
};

export async function renderCourse(root, course, params) {
  const data = await api(`/api/courses/${encodeURIComponent(course)}`);
  // Materials appear once the daily agent has listed them on the campus (dashboard only)
  const tabs = READ_ONLY ? TABS : TABS.filter(([k]) => k !== 'materiales' || data.materials > 0);
  let tab = tabs.some(([k]) => k === params.get('tab')) ? params.get('tab') : (READ_ONLY ? 'teoria' : 'ficha');
  let editing = false;
  const pendingAnalysis = data.sessions.filter(unanalysed);
  const waiting = pendingAnalysis.filter((s) => !jobFor(s.id));

  const header = () => html`
    <div class="crumbs"><a href="${READ_ONLY ? '#/classes' : '#/'}">${READ_ONLY ? 'Clases' : 'Inicio'}</a> / <span>Asignaturas</span></div>
    <h1 class="page-title">${courseChip(course)} ${course.split(' ').slice(1).join(' ') || course}</h1>
    <p class="page-sub">${data.sessions.length} ${data.sessions.length === 1 ? (READ_ONLY ? 'clase transcrita' : 'sesión') : (READ_ONLY ? 'clases transcritas' : 'sesiones')} · ${data.deliverables.length} ${data.deliverables.length === 1 ? 'trabajo' : 'trabajos'} · ${data.exams.length} ${data.exams.length === 1 ? 'examen' : 'exámenes'}
      ${!READ_ONLY && data.proposals.length ? html` · <a href="#/inbox"><b>${data.proposals.length} por revisar</b></a>` : ''}</p>
    ${pendingAnalysis.length && !READ_ONLY ? html`<div class="note-banner">
      <span><b>${pendingAnalysis.length} ${pendingAnalysis.length === 1 ? 'clase sin analizar' : 'clases sin analizar'}.</b>
        Hasta que se generen con IA no aportan ficha, trabajos, exámenes ni fechas a esta asignatura.</span>
      ${state.ai ? (waiting.length ? html`<button class="btn sm primary" data-process-all type="button">Generar con IA${waiting.length > 1 ? ` (${waiting.length})` : ''}</button>`
        : html`<span class="muted small">En la cola de IA: puedes seguir usando la app.</span>`)
        : html`<span class="muted small">Configura GEMINI_API_KEY en .env para hacerlo.</span>`}
    </div>` : ''}
    <div class="tabs" role="tablist" aria-label="Apartados de la asignatura">
      ${tabs.map(([k, label]) => html`<button class="tab" role="tab" data-tab="${k}" aria-selected="${k === tab}">${label}${
        k === 'trabajos' && data.deliverables.length ? html`<span class="n">${READ_ONLY ? data.deliverables.length : data.deliverables.filter((d) => d.status !== 'done').length}</span>` : ''}</button>`)}
    </div>
    <div class="tab-body" id="panel" role="tabpanel"></div>`;

  const panel = () => root.querySelector('#panel');

  // ── Ficha ──
  const drawFicha = () => {
    const p = data.profile;
    const keyDates = [...data.exams.map((x) => ({ ...x.next, label: x.title, kind: 'exam' })), ...data.deliverables.map((d) => ({ ...d.next, label: d.title, kind: 'deadline' }))]
      .filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
    if (editing) {
      mount(panel(), html`<form id="profile-form" class="stack">
        <div class="field"><label for="pf-teacher">Profesor</label><input class="input" id="pf-teacher" maxlength="120" value="${p?.teacher || ''}"></div>
        <div class="field"><label for="pf-schedule">Horario</label><input class="input" id="pf-schedule" maxlength="200" value="${p?.schedule || ''}"></div>
        <div class="field"><label for="pf-overview">Descripción</label><textarea class="input" id="pf-overview" rows="4" maxlength="5000">${p?.overview_md || ''}</textarea></div>
        <div class="field"><label for="pf-pass">Reglas de aprobado</label><input class="input" id="pf-pass" maxlength="500" value="${p?.pass_rules || ''}"></div>
        <div class="field"><label for="pf-syllabus">Temario (un tema por línea)</label><textarea class="input" id="pf-syllabus" rows="5">${(p?.syllabus || []).map((s) => `${s.n}. ${s.title}`).join('\n')}</textarea></div>
        <div class="field"><label for="pf-resources">Recursos (uno por línea)</label><textarea class="input" id="pf-resources" rows="3">${(p?.resources || []).join('\n')}</textarea></div>
        <div class="toolbar"><button class="btn primary" type="submit">Guardar</button><button class="btn" type="button" id="pf-cancel">Cancelar</button></div>
      </form>`);
      panel().querySelector('#pf-cancel').onclick = () => { editing = false; drawFicha(); };
      panel().querySelector('#profile-form').onsubmit = async (e) => {
        e.preventDefault();
        const v = (id) => panel().querySelector(id).value;
        const syllabus = v('#pf-syllabus').split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
          const m = /^(\d{1,2})\s*[.:)\-–]\s*(.+)$/.exec(l);
          return m ? { n: Number(m[1]), title: m[2] } : { n: i + 1, title: l };
        });
        try {
          const { profile } = await api(`/api/courses/${encodeURIComponent(course)}/profile`, {
            method: 'PUT',
            body: { teacher: v('#pf-teacher'), schedule: v('#pf-schedule'), overview_md: v('#pf-overview'), pass_rules: v('#pf-pass'), syllabus, resources: v('#pf-resources').split('\n').map((l) => l.trim()).filter(Boolean) },
          });
          data.profile = profile; editing = false; toast('Ficha guardada'); drawFicha();
        } catch (err) { toast(err.message, 'err'); }
      };
      return;
    }
    mount(panel(), html`
      ${READ_ONLY ? '' : html`<div class="toolbar" style="margin-top:0">
        ${p?.locked ? html`<span class="tag tag-green">${icon('lock', 12)} Ficha fijada</span><span class="muted small">Los cambios que diga la IA llegan a «Por revisar».</span>`
          : html`<span class="tag tag-yellow">Sin fijar</span><span class="muted small">${p ? 'Revísala y fíjala: a partir de entonces la IA solo podrá proponer cambios.' : 'Se creará al generar con IA la clase de presentación.'}</span>`}
        <span class="spacer"></span>
        <button class="btn sm" id="pf-edit" type="button">${icon('edit', 14)} Editar</button>
        ${p ? html`<button class="btn sm ${p.locked ? '' : 'primary'}" id="pf-lock" type="button">${icon(p.locked ? 'unlock' : 'lock', 14)} ${p.locked ? 'Desbloquear' : 'Revisar y fijar ficha'}</button>` : ''}
      </div>`}
      ${p ? html`<dl class="props">
        <dt>Profesor</dt><dd>${p.teacher || html`<span class="muted">—</span>`}</dd>
        <dt>Horario</dt><dd>${p.schedule || html`<span class="muted">—</span>`}</dd>
        <dt>Aprobado</dt><dd>${p.pass_rules || html`<span class="muted">—</span>`}</dd>
        ${p.source_recording_id ? html`<dt>Fuente</dt><dd>${listen(p.source_recording_id, 0, 'Clase de presentación')}</dd>` : ''}
      </dl>
      ${p.overview_md ? html`<p style="margin:12px 0">${p.overview_md}</p>` : ''}` : ''}

      ${READ_ONLY && p?.syllabus.length ? html`<h2 class="section">Temario</h2><ol class="plain-ol">${p.syllabus.map((s) => html`<li value="${s.n}">${s.title}</li>`)}</ol>` : ''}

      <h2 class="section">Evaluación<span class="spacer"></span>${data.grading.length && !READ_ONLY ? html`<a class="btn sm" href="${courseHref(course, 'notas')}">Calcular mi nota</a>` : ''}</h2>${gradingTable(data.grading)}

      ${!READ_ONLY || keyDates.length ? html`
        <h2 class="section">${READ_ONLY ? 'Fechas mencionadas en clase' : 'Fechas clave'}</h2>
        ${keyDates.length ? html`<table class="db"><tbody>${keyDates.map((e) => html`<tr><td>${/^(examen|entrega)\b/i.test(e.label) ? '' : eventChip(e.kind)} ${e.label}</td><td class="num">${countdown(e.date)}</td>
          <td class="acts">${e.recording_id ? listen(e.recording_id, e.t_ms) : ''}</td></tr>`)}</tbody></table>`
          : html`<p class="muted small">Sin fechas todavía.</p>`}` : ''}

      ${!READ_ONLY && p?.syllabus.length ? html`<h2 class="section">Temario</h2><ol class="plain-ol">${p.syllabus.map((s) => html`<li value="${s.n}">${s.title}</li>`)}</ol>` : ''}
      ${p?.resources.length ? html`<h2 class="section">Recursos</h2><div class="tags">${p.resources.map((r) => html`<span class="tag">${r}</span>`)}</div>` : ''}
      ${data.mentions.length ? html`<h2 class="section">${READ_ONLY ? 'Comentado en clase sobre la asignatura' : 'Lo que se ha dicho de la asignatura'} <span class="muted">${data.mentions.length}</span></h2>${data.mentions.map(mentionItem)}` : ''}
    `);
    if (READ_ONLY) return;
    panel().querySelector('#pf-edit').onclick = () => { editing = true; drawFicha(); };
    const lockBtn = panel().querySelector('#pf-lock');
    if (lockBtn) lockBtn.onclick = async () => {
      const locking = !p.locked;
      if (locking && !(await confirmDialog('Fijar la ficha', { confirm: 'Fijar', detail: 'La IA ya no podrá cambiarla: lo que diga en clases posteriores llegará como propuesta a «Por revisar». Tú puedes seguir editándola.' }))) return;
      try {
        data.profile = (await api(`/api/courses/${encodeURIComponent(course)}/profile/lock`, { method: 'POST', body: { locked: locking } })).profile;
        toast(locking ? 'Ficha fijada' : 'Ficha desbloqueada'); drawFicha();
      } catch (err) { toast(err.message, 'err'); }
    };
  };

  // ── Teoría ──
  const drawTeoria = async () => {
    const { groups } = await api(`/api/courses/${encodeURIComponent(course)}/theory`);
    mount(panel(), groups.length ? html`<div class="toolbar"><button class="btn sm" id="th-pdf" type="button" title="${READ_ONLY ? 'Imprimir o guardar un único PDF con los apuntes de teoría de todos los temas' : 'Un solo PDF con los apuntes de teoría de todos los temas, en orden'}">${icon('download', 14)} PDF de toda la teoría</button></div>
      ${groups.map((g) => html`
      <h2 class="section">${g.topic || 'Sin tema asignado'} <span class="muted">${g.classes.length}</span></h2>
      ${g.classes.map((c) => !READ_ONLY && unanalysed(c) ? html`<div class="item">
        <div class="body">
          <a class="txt" href="#/r/${c.id}">${titleOf(c)}</a>
          ${c.summary ? html`<div class="summary-line">${c.summary}</div>` : ''}
          <div class="meta"><span>${fmtDate(c.class_date || c.created_at)}</span><span>${duration(c.duration_seconds)}</span>
            <span class="tag tag-yellow">Sin analizar</span></div>
        </div>
        <div class="acts" style="opacity:1">${processButton(c)}</div></div>`
      : html`<a class="item link" href="#/r/${c.id}">
        <div class="body">
          <div class="txt">${titleOf(c)}</div>
          ${c.summary ? html`<div class="summary-line">${c.summary}</div>` : ''}
          <div class="meta"><span>${fmtDate(c.class_date || c.created_at)}</span><span>${duration(c.duration_seconds)}</span>
            ${c.session_kind && c.session_kind !== 'theory' ? html`<span class="tag">${SESSION_KINDS[c.session_kind]}</span>` : ''}
            ${c.highlights ? html`<span>${c.highlights} momentos clave</span>` : ''}${!READ_ONLY && c.flashcards_due ? html`<span>${c.flashcards_due} tarjetas hoy</span>` : ''}</div>
          ${c.theory_sections.length && c.session_kind !== 'theory' ? html`<div class="muted small" style="margin-top:4px">${READ_ONLY ? 'Tramos de teoría' : 'Solo teoría'}: ${c.theory_sections.map((s) => `${msClock(s.start_ms)}–${msClock(s.end_ms)} ${s.heading}`).join(' · ')}</div>` : ''}
        </div></a>`)}`)}`
      : html`<div class="empty"><p>${READ_ONLY ? 'Aún no hay clases de teoría en esta asignatura.' : 'Aún no hay clases de teoría. Las clases aparecen aquí al importarlas; tras generarlas con IA se agrupan por tema.'}</p></div>`);
    panel().querySelector('#th-pdf')?.addEventListener('click', (e) => downloadPdf(`/api/courses/${encodeURIComponent(course)}/pdf`, e.currentTarget));
  };

  // ── Materiales (the subject's files on the campus, by folder) ──
  const drawMateriales = async () => {
    const m = await api(`/api/courses/${encodeURIComponent(course)}/materials`);
    const groups = new Map();
    const put = (trail, row) => { const k = trail.join(' › ') || 'Contenido'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); };
    m.files.forEach((f, n) => put(f.path, { kind: 'file', f, n }));
    for (const it of m.items) if (it.kind === 'link' && it.url) put(it.path, { kind: 'link', it });
    const open = (row) => row.f.local
      ? html`<a class="btn sm" href="/api/courses/${encodeURIComponent(course)}/materials/file/${row.n}" target="_blank" rel="noopener">${icon('download', 14)} Abrir</a>`
      : m.courseUrl ? html`<a class="btn sm" href="${m.courseUrl}" target="_blank" rel="noopener noreferrer">Abrir en el campus</a>` : '';
    mount(panel(), groups.size ? html`
      <p class="muted small" style="margin:0 0 6px">Lo que la asignatura tiene en el campus${m.updatedAt ? `, revisado el ${fmtDate(m.updatedAt)}` : ''}.</p>
      ${[...groups.entries()].map(([folder, rows]) => html`<h2 class="section">${folder} <span class="muted">${rows.length}</span></h2>
        ${rows.map((row) => row.kind === 'file' ? html`<div class="item"><div class="body">
            <div class="txt">${row.f.title !== row.f.fileName ? row.f.title : row.f.fileName}</div>
            <div class="meta"><span>${row.f.fileName}</span>${row.f.bytes ? html`<span>${KB(row.f.bytes)}</span>` : ''}${row.f.modified ? html`<span>${fmtDate(row.f.modified)}</span>` : ''}</div></div>
            <div class="acts" style="opacity:1">${open(row)}</div></div>`
          : html`<div class="item"><div class="body"><div class="txt">${row.it.title}</div><div class="meta"><span>Enlace</span></div></div>
            <div class="acts" style="opacity:1"><a class="btn sm" href="${row.it.url}" target="_blank" rel="noopener noreferrer">Abrir</a></div></div>`)}`)}`
      : html`<div class="empty"><p>Sin materiales todavía.</p></div>`);
  };

  // ── Trabajos / Exámenes ──
  const drawEntities = async (type, fromClick = false) => {
    const list = type === 'deliverable' ? data.deliverables : data.exams;
    const open = Number(params.get(type === 'deliverable' ? 'd' : 'x')) || (READ_ONLY ? (list[0]?.id ?? null) : null);
    mount(panel(), list.length ? html`<div class="cards">${list.map((e) => html`
      <button class="card ${open === e.id ? 'is-open' : ''}" type="button" data-entity="${e.id}">
        <div class="tags">${type === 'deliverable' ? (READ_ONLY ? eventChip('deadline') : html`<span class="tag ${e.status === 'done' ? 'tag-green' : e.status === 'doing' ? 'tag-blue' : ''}">${STATUS[e.status]}</span>`) : eventChip('exam')}
          ${e.weight_pct !== null ? html`<span class="tag">${e.weight_pct} %</span>` : ''}</div>
        <div class="card-title">${e.title}</div>
        ${READ_ONLY ? (e.next?.date ? html`<div class="card-next">${countdown(e.next.date)}</div>` : '') : html`<div class="card-next">${countdown(e.next?.date)}</div>`}
        <div class="card-stats muted small">${[e.format, e.group_size ? `Grupos: ${e.group_size}` : '', e.mentions ? `${e.mentions} ${e.mentions === 1 ? (READ_ONLY ? 'mención' : 'indicación') : (READ_ONLY ? 'menciones' : 'indicaciones')}` : ''].filter(Boolean).join(' · ')}</div>
      </button>`)}</div><div id="entity-detail"></div>`
      : html`<div class="empty"><p>${type === 'deliverable' ? (READ_ONLY ? 'Sin trabajos registrados en las clases.' : 'Sin trabajos todavía. Se crean al generar con IA las clases donde se explican.') : (READ_ONLY ? 'Sin exámenes registrados en las clases.' : 'Sin exámenes todavía.')}</p></div>`);
    panel().querySelectorAll('[data-entity]').forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.entity);
      history.replaceState(null, '', `${courseHref(course, tab)}&${type === 'deliverable' ? 'd' : 'x'}=${id}`);
      params.set(type === 'deliverable' ? 'd' : 'x', String(id));
      await drawEntities(type, true);
    }));
    if (open && list.some((e) => e.id === open)) await drawDetail(type, open, { scroll: !READ_ONLY || fromClick });
  };

  const drawDetail = async (type, id, { scroll = true } = {}) => {
    const d = await api(`/api/${type === 'deliverable' ? 'deliverables' : 'exams'}/${id}`);
    const entity = d.deliverable || d.exam;
    const requirements = d.mentions.filter((m) => m.kind === 'requirement' || m.kind === 'format');
    const box = panel().querySelector('#entity-detail');
    mount(box, html`<section class="detail">
      <h2 class="section">${entity.title}<span class="spacer"></span>
        ${type === 'deliverable' && !READ_ONLY ? html`<label class="sr-only" for="dl-status">Estado</label>
          <select class="input" id="dl-status">${Object.entries(STATUS).map(([k, v]) => html`<option value="${k}" ${k === entity.status ? html`selected` : ''}>${v}</option>`)}</select>` : ''}</h2>
      ${entity.description ? html`<p>${entity.description}</p>` : ''}
      <dl class="props">
        ${entity.format ? html`<dt>Formato</dt><dd>${entity.format}</dd>` : ''}
        ${entity.group_size ? html`<dt>Grupos</dt><dd>${entity.group_size}</dd>` : ''}
        ${d.grading.length ? html`<dt>Peso</dt><dd>${d.grading.map((g) => `${g.name}${g.weight_pct !== null ? ` · ${g.weight_pct} %` : ''}`).join(', ')}</dd>` : ''}
      </dl>
      ${READ_ONLY ? '' : html`
        <h3 class="bucket">Fechas</h3>
        ${d.events.length ? d.events.map((e) => html`<div class="item"><div class="body"><div class="tags">${eventChip(e.kind)} ${countdown(e.date)}${e.time ? html`<span class="muted small">${e.time}</span>` : ''}
          ${e.confirmed ? html`<span class="tag tag-green">Confirmado</span>` : ''}</div><div class="txt">${e.title}</div>
          ${e.recording_id ? html`<div class="meta">${listen(e.recording_id, e.t_ms)}<span>${e.recording_title || ''}</span></div>` : ''}</div></div>`)
          : html`<p class="muted small">Sin fechas.</p>`}
        ${type === 'deliverable' && requirements.length ? html`<h3 class="bucket">Checklist</h3>
          <ul class="checklist">${requirements.map((m) => html`<li><label><input type="checkbox" data-check="${m.id}"> ${m.text}</label></li>`)}</ul>` : ''}`}
      ${READ_ONLY ? html`
        ${d.sections.length ? html`<h3 class="bucket">Tramos de clase dedicados a ${type === 'exam' ? 'este examen' : 'este trabajo'}</h3>
          ${d.sections.map((s, i) => html`<div class="item"><div class="body"><div class="txt">${s.heading}</div>
            ${s.gist ? html`<div class="muted small">${s.gist}</div>` : ''}
            <div class="meta">${listen(s.recording_id, s.start_ms, `${msClock(s.start_ms)}–${msClock(s.end_ms)}`)}<span>${s.recording_title}</span>
            ${s.session_kind === 'project' ? html`<span class="tag tag-blue">Sesión dedicada</span>` : ''}</div>
            ${s.markdown?.trim() ? html`<details class="range-notes" data-i="${i}" open><summary class="small">Apuntes del tramo</summary><div class="prose"></div></details>` : ''}</div></div>`)}` : ''}
        <h3 class="bucket">${type === 'exam' ? 'Qué entra y qué se dijo en clase' : 'Todo lo que se dijo en clase'} <span class="muted">${d.mentions.length}</span></h3>
        ${d.mentions.length ? d.mentions.map(mentionItem) : html`<p class="muted small">Nada registrado todavía.</p>`}`
      : html`
        <h3 class="bucket">${type === 'exam' ? 'Qué entra y cómo es' : 'Todo lo que se dijo'} <span class="muted">${d.mentions.length}</span></h3>
        ${d.mentions.length ? d.mentions.map(mentionItem) : html`<p class="muted small">Nada todavía.</p>`}
        ${d.sections.length ? html`<h3 class="bucket">Tramos de clase sobre ${type === 'exam' ? 'este examen' : 'este trabajo'}</h3>
          ${d.sections.map((s, i) => html`<div class="item"><div class="body"><div class="txt">${s.heading}</div>
            ${s.gist ? html`<div class="muted small">${s.gist}</div>` : ''}
            <div class="meta">${listen(s.recording_id, s.start_ms, `${msClock(s.start_ms)}–${msClock(s.end_ms)}`)}<span>${s.recording_title}</span>
            ${s.session_kind === 'project' ? html`<span class="tag tag-blue">Sesión dedicada</span>` : ''}</div>
            ${s.markdown?.trim() ? html`<details class="range-notes" data-i="${i}"><summary class="small">Apuntes del tramo</summary><div class="prose"></div></details>` : ''}</div></div>`)}` : ''}`}
    </section>`);
    // The notes of a range are rendered when it is opened; their time marks jump to that class
    box.querySelectorAll('details.range-notes').forEach((el) => {
      const s = d.sections[Number(el.dataset.i)];
      const renderIn = () => {
        const prose = el.querySelector('.prose');
        if (el.open && prose && !prose.hasChildNodes()) prose.replaceChildren(...renderMarkdown(s.markdown).childNodes);
      };
      if (el.open) renderIn();
      el.addEventListener('toggle', renderIn);
      el.addEventListener('click', (e) => {
        const stamp = e.target.closest('button.ts');
        if (stamp) location.hash = `#/r/${s.recording_id}?t=${Math.max(0, Number(stamp.dataset.t) - 3)}`;
      });
    });
    if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (READ_ONLY) return;
    // Ticked requirements are user state, stored in the database like everything else
    box.querySelectorAll('[data-check]').forEach((c) => {
      c.checked = (d.checklist || []).includes(Number(c.dataset.check));
      c.addEventListener('change', async () => {
        const ids = [...box.querySelectorAll('[data-check]:checked')].map((x) => Number(x.dataset.check));
        try { await api(`/api/deliverables/${id}/checklist`, { method: 'PUT', body: { done: ids } }); }
        catch (err) { toast(err.message, 'err'); }
      });
    });
    box.querySelector('#dl-status')?.addEventListener('change', async (e) => {
      try {
        const { deliverable } = await api(`/api/deliverables/${id}`, { method: 'PATCH', body: { status: e.target.value } });
        Object.assign(data.deliverables.find((x) => x.id === id), deliverable);
        toast(`Marcado como ${STATUS[deliverable.status].toLowerCase()}`);
        refreshMeta().catch(() => {});
        drawEntities('deliverable');
      } catch (err) { toast(err.message, 'err'); }
    });
  };

  // ── Sesiones ──
  const drawSesiones = () => {
    if (READ_ONLY) {
      mount(panel(), data.sessions.length ? html`<table class="db"><thead><tr><th>Nº</th><th>Clase y resumen</th><th class="hide-sm">Fecha</th><th class="hide-sm">Tipo</th><th class="hide-sm">Duración</th></tr></thead>
        <tbody>${data.sessions.map((s) => html`<tr><td class="num">${s.class_number ?? ''}</td>
          <td class="name"><a href="#/r/${s.id}">${titleOf(s)}</a>${s.summary ? html`<div class="summary-line">${s.summary}</div>` : ''}</td>
          <td class="date hide-sm">${fmtDate(s.class_date || s.created_at)}</td>
          <td class="hide-sm">${s.session_kind ? html`<span class="tag">${SESSION_KINDS[s.session_kind]}</span>` : ''}</td>
          <td class="num hide-sm">${duration(s.duration_seconds)}</td></tr>`)}</tbody></table>`
        : html`<div class="empty"><p>Sin sesiones.</p></div>`);
      return;
    }
    mount(panel(), data.sessions.length ? html`<table class="db"><thead><tr><th>Nº</th><th>Clase</th><th class="hide-sm">Fecha</th><th class="hide-sm">Tipo</th><th class="hide-sm">Duración</th><th></th></tr></thead>
      <tbody>${data.sessions.map((s) => html`<tr><td class="num">${s.class_number ?? ''}</td>
        <td class="name">${s.segment_count ? html`<a href="#/r/${s.id}">${titleOf(s)}</a>${s.summary ? html`<div class="summary-line">${s.summary}</div>` : ''}` : html`${titleOf(s)} <span class="muted small">sin capturar</span>`}</td>
        <td class="date hide-sm">${fmtDate(s.class_date || s.created_at)}${s.class_date ? '' : html` <span class="muted small" title="Fecha de transcripción, no de la clase">?</span>`}</td>
        <td class="hide-sm">${s.session_kind ? html`<span class="tag">${SESSION_KINDS[s.session_kind]}</span>` : unanalysed(s) ? html`<span class="tag tag-yellow">Sin analizar</span>` : ''}</td>
        <td class="num hide-sm">${duration(s.duration_seconds)}</td>
        <td class="acts">${unanalysed(s) ? processButton(s) : ''}</td></tr>`)}</tbody></table>`
      : html`<div class="empty"><p>Sin sesiones.</p></div>`);
  };

  const drawTab = async () => {
    root.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'ficha') drawFicha();
    else if (tab === 'teoria') await drawTeoria();
    else if (tab === 'materiales') await drawMateriales();
    else if (tab === 'trabajos') await drawEntities('deliverable');
    else if (tab === 'examenes') await drawEntities('exam');
    else if (tab === 'notas') await renderGrades(panel(), course, { passRules: data.profile?.pass_rules || '' });
    else if (tab === 'calendario') await renderCalendar(panel(), null, { fixedCourse: course });
    else drawSesiones();
  };

  mount(root, header());

  // "Generar con IA" for one class or for every unanalysed one: queued on the server, which runs them in order
  if (!READ_ONLY) {
    root.addEventListener('click', async (e) => {
      const one = e.target.closest('[data-process]');
      const all = e.target.closest('[data-process-all]');
      if (!one && !all) return;
      const ids = one ? [Number(one.dataset.process)] : waiting.map((s) => s.id);
      (one || all).disabled = true;
      try {
        await enqueueJobs(ids);
        await renderRoute();
      } catch (err) { toast(err.message, 'err', 8000); (one || all).disabled = false; }
    });
  }

  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    editing = false;
    history.replaceState(null, '', courseHref(course, tab));
    // The calendar binds listeners to the panel: give each tab a fresh one
    const fresh = panel().cloneNode(false);
    panel().replaceWith(fresh);
    drawTab().catch((err) => toast(err.message, 'err'));
  });
  await drawTab();
}
