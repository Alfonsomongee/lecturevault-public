// Clases: pending captures (with the command to run) and the recordings grouped by subject.
// On the friends' read-only web, it shows transcribed classes in subject cards with summaries and topic pills.
import { api, html, mount, icon, duration, fmtDate, courseLabel, courseChip, courseHref, NO_COURSE, toast, copyText, fold, titleOf, READ_ONLY } from '../util.js';
import { state, applyMeta, refreshMeta, renderRoute, setCourse } from '../main.js';
import { courseFilter, bindCourseFilter } from './course-filter.js';
import { enqueueJobs, jobFor, jobLabel } from '../jobs.js';
import { startCapture, dismissCapture, captureStatus, captureRunning, captureProblem, captureItem, itemLabel } from '../capture.js';

let query = '';
let showIgnored = false;

/** What went wrong in the last capture, if anything: a clean run needs no panel (the class just leaves the list). */
function lastCapture() {
  const s = captureStatus();
  if (!s || s.running || !s.items.length) return '';
  const failed = s.items.filter((i) => i.state === 'failed');
  if (!failed.length && !s.error && !s.cancelled) return '';
  const done = s.items.length - failed.length;
  return html`<div class="capture-result" role="alert">
    <div class="head"><b>${s.cancelled ? 'Captura cancelada: las clases siguen pendientes' : `Última captura: ${done} de ${s.items.length} ${s.items.length === 1 ? 'lista' : 'listas'}`}</b>
      <button class="btn sm ghost" data-capture-dismiss type="button">Cerrar</button></div>
    ${s.error && !s.cancelled ? html`<p style="margin:6px 0 0">${s.error}</p>` : ''}
    ${!s.cancelled && failed.length ? html`<ul>${failed.map((i) => html`<li><b>${i.title}</b>: ${i.error}</li>`)}</ul>` : ''}
    ${s.log.length ? html`<details><summary>Ver el detalle</summary><pre>${s.log.slice(-40).join('\n')}</pre></details>` : ''}
  </div>`;
}

function materials(r) {
  return html`<div class="tags">
    ${r.has_audio ? html`<span class="tag">Audio</span>` : ''}
    ${r.has_notes ? html`<span class="tag tag-green">Apuntes</span>` : ''}
    ${r.has_notes && !r.analysis_version ? html`<span class="tag tag-yellow" title="Aún no clasificada por tramos: no aparece en ficha, trabajos ni calendario">Sin analizar</span>` : ''}
    ${r.alert_count ? html`<span class="tag tag-orange">${r.alert_count} ${r.alert_count === 1 ? 'aviso' : 'avisos'}</span>` : ''}
    ${r.flashcard_count ? html`<span class="tag tag-blue">${r.flashcard_count} ${r.flashcard_count === 1 ? 'tarjeta' : 'tarjetas'}</span>` : ''}
  </div>`;
}

function readonlyMaterials(r) {
  return html`<div class="tags class-tags">
    ${r.has_notes ? html`<span class="tag tag-green">Apuntes</span>` : ''}
    <span class="tag">Transcripción</span>
    ${r.flashcard_count ? html`<span class="tag tag-blue">${r.flashcard_count} ${r.flashcard_count === 1 ? 'tarjeta' : 'tarjetas'}</span>` : ''}
    ${r.has_audio ? html`<span class="tag">Audio</span>` : ''}
  </div>`;
}

/** «Parte 2 de 2» when the campus recorded the session in several pieces (otherwise two rows read as the same class) */
function partTag(r) {
  return r.session_parts > 1 ? html`<span class="tag" title="Sesión grabada en ${r.session_parts} partes">Parte ${r.session_part} de ${r.session_parts}</span>` : '';
}

function readonlyRow(r) {
  return html`<tr class="class-row">
    <td class="name">
      <div class="class-title-row">
        <a class="class-link" href="#/r/${r.id}">${titleOf(r)}</a>
        ${r.topic ? html`<span class="topic-pill">${r.topic}</span>` : ''}
        ${partTag(r)}
      </div>
      ${r.summary ? html`<div class="summary-line">${r.summary}</div>` : ''}
    </td>
    <td class="date hide-sm">${fmtDate(r.class_date || r.created_at)}</td>
    <td class="num hide-sm">${duration(r.duration_seconds)}</td>
    <td class="mat-cell">${readonlyMaterials(r)}</td>
  </tr>`;
}

async function renderReadOnlyLibrary(root) {
  const courseQs = state.course ? `course=${encodeURIComponent(state.course)}` : '';
  const data = await api(`/api/recordings${courseQs ? `?${courseQs}` : ''}`);
  applyMeta(data);
  const q = fold(query);
  const all = data.recordings.filter((r) => r.segment_count > 0);
  const rs = all.filter((r) => !q || fold(titleOf(r)).includes(q) || fold(r.title).includes(q) || fold(r.summary || '').includes(q));

  const groups = new Map();
  for (const r of rs) {
    if (!groups.has(r.course)) groups.set(r.course, []);
    groups.get(r.course).push(r);
  }
  const withNotes = all.filter((r) => r.has_notes).length;
  const totalCards = all.reduce((acc, r) => acc + (r.flashcard_count || 0), 0);

  mount(root, html`
    <header class="hero-header">
      <h1 class="page-title">${state.course ? courseLabel(state.course) : 'Clases y Transcripciones'}</h1>
      <div class="stat-pills">
        <span class="stat-pill"><b>${all.length}</b> ${all.length === 1 ? 'clase transcrita' : 'clases transcritas'}</span>
        <span class="stat-pill"><b>${withNotes}</b> con apuntes y resumen</span>
        ${totalCards ? html`<span class="stat-pill"><b>${totalCards}</b> tarjetas de estudio</span>` : ''}
      </div>
    </header>

    <div class="toolbar filter-bar">
      <label class="sr-only" for="filter">Filtrar por título o resumen</label>
      <input class="input filter-input" id="filter" type="search" placeholder="Filtrar por título, tema o palabra clave…" value="${query}">
      ${courseFilter('lib-course')}
    </div>

    ${rs.length === 0 ? html`
      <div class="empty"><h3>No se encontraron clases</h3>
        <p>${q ? 'Prueba con otro término o selecciona «Todas las asignaturas».' : `Aún no hay clases publicadas${state.course ? ' de esta asignatura' : ''}.`}</p></div>`
    : [...groups.entries()].map(([course, items]) => {
      const restName = course ? course.split(' ').slice(1).join(' ') : '';
      return html`
      <section class="course-card">
        <div class="course-card-head">
          <div class="course-card-title">
            ${course ? html`<a href="${courseHref(course)}" class="course-head-link">${courseChip(course)} <span>${restName || course}</span></a>` : html`<span>${courseLabel(course)}</span>`}
            <span class="course-count-badge">${items.length} ${items.length === 1 ? 'clase' : 'clases'}</span>
          </div>
          ${course ? html`<a class="course-go-link" href="${courseHref(course)}">Ver asignatura y teoría →</a>` : ''}
        </div>
        <table class="db classes readonly-classes"><thead><tr>
          <th>Clase y resumen</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th>Contenido</th></tr></thead>
          <tbody>${items.map(readonlyRow)}</tbody></table>
      </section>`;
    })}
  `);

  bindCourseFilter(root);
  const filterInput = root.querySelector('#filter');
  filterInput.addEventListener('input', (e) => {
    query = e.target.value;
    renderReadOnlyLibrary(root);
    const nextInput = root.querySelector('#filter');
    if (nextInput) {
      nextInput.focus();
      nextInput.setSelectionRange(query.length, query.length);
    }
  });
}

function row(r) {
  return html`<tr>
    <td class="sel"><input type="checkbox" data-sel="${r.id}" aria-label="Seleccionar ${titleOf(r)}"></td>
    <td class="name"><a href="#/r/${r.id}">${titleOf(r)}</a> ${partTag(r)}${r.summary ? html`<div class="summary-line">${r.summary}</div>` : ''}</td>
    <td class="date hide-sm">${fmtDate(r.class_date || r.created_at)}</td>
    <td class="num hide-sm">${duration(r.duration_seconds)}</td>
    <td>${materials(r)}</td>
    <td class="acts">${jobFor(r.id) ? html`<button class="btn sm" type="button" disabled>${jobLabel(jobFor(r.id))}</button>`
      : (!r.has_notes || !r.analysis_version) && state.ai
      ? html`<button class="btn sm" data-process="${r.id}" type="button" title="${r.has_notes ? 'Clasifica la clase por tramos y la enruta a ficha, trabajos, exámenes y calendario; los apuntes que ya tiene se conservan' : ''}">Generar con IA</button>` : ''}</td>
  </tr>`;
}

function pendingRow(p) {
  const item = captureItem(p.id); // in the capture running now
  const blocked = captureRunning() || !!captureProblem();
  return html`<tr>
    <td class="name">${p.title}</td>
    <td class="hide-sm"><span class="muted small">${p.course ? p.course.split(' ')[0] : ''}</span></td>
    <td class="date hide-sm">${fmtDate(p.created_at)}</td>
    <td class="num hide-sm">${duration(p.duration_seconds)}</td>
    <td class="acts">${item
      ? html`<span class="muted small" data-capture-state="${p.id}">${itemLabel(item)}</span>`
      : html`<button class="btn sm primary" data-capture="${p.id}" type="button" ${blocked ? 'disabled' : ''} title="${captureRunning() ? 'Hay una captura en marcha' : 'Abre el navegador, graba el audio y lo transcribe'}">Grabar y transcribir</button>`}
      <button class="btn sm ghost" data-copy="${p.command}" type="button" title="Copiar el comando para hacerlo desde la terminal" aria-label="Copiar el comando de ${p.title}">${icon('copy', 14)}</button>
      <button class="btn sm ghost" data-ignore="${p.id}" type="button" title="No capturarla: desaparece de pendientes y de la captura en lote">Ignorar</button></td>
  </tr>`;
}

export async function renderLibrary(root) {
  if (READ_ONLY) return renderReadOnlyLibrary(root);
  const courseQs = state.course ? `course=${encodeURIComponent(state.course)}` : '';
  const [data, pendingData] = await Promise.all([
    api(`/api/recordings${courseQs ? `?${courseQs}` : ''}`),
    api('/api/pending'),
  ]);
  applyMeta({ ...data, pending: pendingData.pending.length });
  const q = fold(query);
  const all = data.recordings.filter((r) => r.segment_count > 0);
  const rs = all.filter((r) => !q || fold(titleOf(r)).includes(q) || fold(r.title).includes(q));
  const inCourse = (p) => !state.course || (state.course === NO_COURSE ? !p.course : p.course === state.course);
  const pending = pendingData.pending.filter(inCourse);
  const ignored = (pendingData.ignored || []).filter(inCourse);
  // The course filter sticks, so pending classes of other subjects can be out of sight without any hint
  const elsewhere = pendingData.pending.length - pending.length;

  const groups = new Map();
  for (const r of rs) {
    if (!groups.has(r.course)) groups.set(r.course, []);
    groups.get(r.course).push(r);
  }
  const withNotes = all.filter((r) => r.has_notes).length;

  mount(root, html`
    <h1 class="page-title">${state.course ? courseLabel(state.course) : 'Clases'}</h1>
    <p class="page-sub">${all.length ? `${all.length} ${all.length === 1 ? 'clase' : 'clases'} capturadas, ${withNotes} con apuntes.` : 'Todavía no hay clases capturadas.'}${pending.length ? ` ${pending.length} pendientes de capturar.` : ''}</p>

    <div class="toolbar">
      <label class="sr-only" for="filter">Filtrar por nombre</label>
      <input class="input" id="filter" type="search" placeholder="Filtrar por nombre" value="${query}" style="width:240px">
      ${courseFilter('lib-course')}
      <span class="spacer"></span>
      <button class="btn" data-ingest type="button" title="Importar las transcripciones de data/transcripts">Importar transcripciones</button>
    </div>

    <div class="bulk" id="bulk" hidden>
      <span><b id="bulk-n">0</b> seleccionadas</span>
      <label class="sr-only" for="bulk-course">Asignatura destino</label>
      <input class="input" id="bulk-course" list="bulk-dl" placeholder="Asignatura o número (03)" maxlength="120">
      <datalist id="bulk-dl">${[...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])].map((c) => html`<option value="${c}"></option>`)}</datalist>
      <button class="btn primary sm" id="bulk-go" type="button">Mover a asignatura</button>
      <button class="btn ghost sm" id="bulk-none" type="button">Quitar asignatura</button>
    </div>

    ${lastCapture()}
    ${elsewhere ? html`<p class="capture-note" data-pending-elsewhere>${elsewhere === 1 ? 'Hay 1 clase pendiente de capturar' : `Hay ${elsewhere} clases pendientes de capturar`} en otras asignaturas, y este filtro ${elsewhere === 1 ? 'la oculta' : 'las oculta'}.
      <button class="btn sm" data-all-courses type="button">Ver todas las asignaturas</button></p>` : ''}
    ${pending.length ? html`
      <h2 class="section">Pendientes de capturar <span class="muted">${pending.length}</span></h2>
      <p class="muted small" style="margin-bottom:8px">«Grabar y transcribir» abre el navegador del campus, graba el audio a 4× y sin sonido, lo transcribe y prepara los apuntes. Puedes seguir usando LectureVault mientras tanto. Si el campus pide iniciar sesión, hazlo en la ventana que se abre.</p>
      ${captureProblem() ? html`<p class="capture-note">${captureProblem()}</p>` : ''}
      <div class="capture-actions">
        <button class="btn primary" data-capture-all type="button" ${captureRunning() || captureProblem() ? 'disabled' : ''}>Grabar y transcribir ${pending.length === 1 ? 'la clase' : `todas (${Math.min(pending.length, 50)})`}</button>
        <details><summary class="muted small">Hacerlo desde la terminal</summary>
          <div class="cmd" style="margin-top:6px"><code>${pendingData.batch}</code>
            <button class="btn sm" data-copy="${pendingData.batch}" type="button">${icon('copy', 14)} Copiar</button></div></details>
      </div>
      <table class="db pending"><thead><tr><th>Nombre</th><th class="hide-sm">Asignatura</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th></th></tr></thead>
        <tbody>${pending.map(pendingRow)}</tbody></table>` : ''}
    ${ignored.length ? html`<button class="btn sm ghost" id="show-ignored" type="button" aria-expanded="${showIgnored}" style="margin-top:8px">${showIgnored ? 'Ocultar las ignoradas' : `Ver ${ignored.length} ${ignored.length === 1 ? 'ignorada' : 'ignoradas'}`}</button>
      ${showIgnored ? html`<table class="db pending ignored"><tbody>${ignored.map((p) => html`<tr>
        <td class="name muted">${p.title}</td>
        <td class="hide-sm"><span class="muted small">${p.course ? p.course.split(' ')[0] : ''}</span></td>
        <td class="date hide-sm">${fmtDate(p.created_at)}</td>
        <td class="acts"><button class="btn sm" data-unignore="${p.id}" type="button">Recuperar</button></td></tr>`)}</tbody></table>` : ''}` : ''}

    ${rs.length === 0 && !pending.length ? html`
      <div class="empty"><h3>No hay clases</h3>
        <p>Sincroniza la lista de Collab2 con <code>npm run sync</code> para ver aquí lo que falta por capturar, o importa transcripciones que ya tengas.</p></div>`
    : [...groups.entries()].map(([course, items]) => html`
      <h2 class="section">${courseLabel(course)} <span class="muted">${items.length}</span></h2>
      <table class="db classes"><thead><tr>
        <th class="sel"><input type="checkbox" data-sel-all aria-label="Seleccionar todas"></th>
        <th>Nombre</th><th class="hide-sm">Fecha</th><th class="hide-sm">Duración</th><th>Material</th><th></th></tr></thead>
        <tbody>${items.map(row)}</tbody></table>`)}
  `);

  bindCourseFilter(root);
  root.querySelector('[data-all-courses]')?.addEventListener('click', () => setCourse(''));
  root.querySelector('#filter').addEventListener('input', (e) => {
    query = e.target.value;
    renderLibrary(root);
  });
  root.querySelector('#show-ignored')?.addEventListener('click', () => { showIgnored = !showIgnored; renderLibrary(root); });
  root.querySelectorAll('[data-ignore], [data-unignore]').forEach((b) => b.addEventListener('click', async () => {
    const ignore = 'ignore' in b.dataset;
    b.disabled = true;
    try {
      await api(`/api/recordings/${b.dataset.ignore || b.dataset.unignore}`, { method: 'PATCH', body: { ignored: ignore } });
      toast(ignore ? 'Clase ignorada: ya no aparece en pendientes' : 'Clase recuperada');
      await refreshMeta(); await renderLibrary(root);
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  }));
  const capture = async (button, body) => {
    button.disabled = true;
    try {
      await startCapture(body);
      await renderLibrary(root);
    } catch (err) { toast(err.message, 'err', 8000); button.disabled = false; }
  };
  root.querySelectorAll('[data-capture]').forEach((b) => b.addEventListener('click', () => capture(b, { ids: [Number(b.dataset.capture)] })));
  // The ones listed here (the course filter applies), oldest class first
  root.querySelector('[data-capture-all]')?.addEventListener('click', (e) =>
    capture(e.currentTarget, { ids: [...pending].reverse().slice(0, 50).map((p) => p.id) }));
  root.querySelector('[data-capture-dismiss]')?.addEventListener('click', async () => {
    try { await dismissCapture(); await renderLibrary(root); } catch (err) { toast(err.message, 'err'); }
  });
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    toast((await copyText(b.dataset.copy)) ? 'Comando copiado' : 'No se pudo copiar', 'ok');
  }));
  root.querySelector('[data-ingest]')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { result } = await api('/api/ingest', { method: 'POST', body: {} });
      toast(`Importadas ${result.created + result.linked} clases, ${result.importedNotes} apuntes`);
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
  });
  root.querySelectorAll('[data-process]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await enqueueJobs([Number(b.dataset.process)]);
      b.textContent = jobLabel(jobFor(Number(b.dataset.process)) || 'queued');
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  }));

  // Bulk selection
  const bulk = root.querySelector('#bulk');
  if (!bulk) return;
  const selected = () => [...root.querySelectorAll('[data-sel]:checked')].map((b) => Number(b.dataset.sel));
  const syncBulk = () => { const n = selected().length; bulk.hidden = n === 0; root.querySelector('#bulk-n').textContent = String(n); };
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-sel-all]')) e.target.closest('table').querySelectorAll('[data-sel]').forEach((b) => { b.checked = e.target.checked; });
    if (e.target.matches('[data-sel], [data-sel-all]')) syncBulk();
  });
  const assign = async (course) => {
    try {
      const res = await api('/api/recordings/assign', { method: 'POST', body: { ids: selected(), course } });
      toast(`${res.updated} clase(s) movidas a ${res.course || 'sin asignatura'}`);
      await refreshMeta(); await renderRoute();
    } catch (err) { toast(err.message, 'err'); }
  };
  root.querySelector('#bulk-go').addEventListener('click', () => {
    const v = root.querySelector('#bulk-course').value.trim();
    if (v) assign(v); else toast('Escribe o elige una asignatura', 'err');
  });
  root.querySelector('#bulk-none').addEventListener('click', () => assign(NO_COURSE));
}
