// Calendario: every campus event as an agenda list, a week or a month, filtered by course and kind, with
// the load of the coming weeks, the "Sin fecha" list (what has no date never reaches a calendar), manual
// events, .ics export and a webcal subscription.
import { api, html, mount, icon, EVENT_KINDS, isoParts, toast, copyText, READ_ONLY } from '../util.js';
import { state, refreshMeta } from '../main.js';
import { eventRow, bindEventActions, monthGrid, weekGrid, loadStrip, mondayOf, addDaysIso, todayIso } from './events-ui.js';

const STRIP_WEEKS = 12;
let mode = 'list';
let monthOffset = 0;
let weekStart = null; // Monday shown in the week view
let kindFilter = '';
let showDone = false;
let showPast = false;
let showClasses = false; // the timetable runs to a hundred classes: the agenda lists what is due
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** `fixedCourse` embeds the calendar in a course page (no course filter shown). */
export async function renderCalendar(root, params, { fixedCourse = null } = {}) {
  let course = fixedCourse ?? params?.get('course') ?? '';
  // #/calendar?week=YYYY-MM-DD (Inicio's critical-week notice) opens that week
  const askedWeek = params?.get('week');
  if (askedWeek && /^\d{4}-\d{2}-\d{2}$/.test(askedWeek)) { mode = 'week'; weekStart = mondayOf(askedWeek); }
  const courses = [...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])];
  const events = []; // updated in place: the row actions hold this array
  const loadByWeek = new Map(); // Monday → load level, for the month grid
  let strip = [];
  let subscribeOpen = false;

  const courseQs = () => (course ? `&course=${encodeURIComponent(course)}` : '');
  const loadWeeks = async (from, weeks) => {
    const { weeks: list } = await api(`/api/workload?from=${from}&weeks=${weeks}${courseQs()}`);
    for (const w of list) loadByWeek.set(w.start, w.level);
    return list;
  };
  /** The month on screen, from the Monday of its first week. */
  const loadMonth = () => {
    const first = new Date(new Date().getFullYear(), new Date().getMonth() + monthOffset, 1);
    return loadWeeks(mondayOf(`${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`), 6);
  };
  const loadLoad = async () => {
    loadByWeek.clear();
    strip = await loadWeeks(todayIso(), STRIP_WEEKS);
    if (mode === 'month') await loadMonth();
  };
  const load = async () => {
    const qs = new URLSearchParams({ dismissed: '1', ...(course ? { course } : {}) });
    const [list] = await Promise.all([api(`/api/events?${qs}`), loadLoad()]);
    events.splice(0, events.length, ...list.events);
  };

  const draw = () => {
    const live = events.filter((e) => (showDone || !e.dismissed) && (!kindFilter || e.kind === kindFilter));
    const dated = live.filter((e) => e.date);
    const undated = live.filter((e) => !e.date);
    // The agenda starts today; what is past stays one click away
    const past = dated.filter((e) => e.date < todayIso());
    const months = new Map();
    const agendaDated = dated.filter((x) => showClasses || kindFilter === 'session' || x.kind !== 'session');
    for (const e of showPast ? agendaDated : agendaDated.filter((x) => x.date >= todayIso())) {
      const key = cap(isoParts(e.date).date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }));
      if (!months.has(key)) months.set(key, []);
      months.get(key).push(e);
    }
    // The friends' web publishes one feed with every subject, at its own address on the internet
    const ics = READ_ONLY ? '/calendar.ics' : `/api/calendar.ics${course ? `?course=${encodeURIComponent(course)}` : ''}`;
    const webcal = READ_ONLY ? `webcal://${location.host}/calendar.ics` : `webcal://${location.host}/api/calendar.ics?subscribe=1${courseQs()}`;
    const httpsFeed = `${location.origin}/calendar.ics`;

    mount(root, html`
      ${fixedCourse ? '' : html`<h1 class="page-title">Calendario</h1>
        <p class="page-sub">${READ_ONLY ? 'Entregas, exámenes y sesiones de todas las asignaturas. Lo que viene del calendario oficial lleva la etiqueta «Universidad»; lo dicho en clase, su cita y su minuto.' : 'Entregas, exámenes y sesiones de todas las asignaturas. Lo dudoso lleva su cita y su minuto: escúchalo antes de confirmarlo.'}</p>`}
      <div class="toolbar">
        <div class="seg-ctl" role="group" aria-label="Vista">${[['list', 'Agenda'], ['week', 'Semana'], ['month', 'Mes']].map(([k, l]) => html`<button type="button" data-mode="${k}" aria-pressed="${mode === k}">${l}</button>`)}</div>
        ${fixedCourse ? '' : html`<label class="sr-only" for="cal-course">Asignatura</label>
          <select class="input" id="cal-course"><option value="">Todas las asignaturas</option>${courses.map((c) => html`<option value="${c}" ${c === course ? html`selected` : ''}>${c}</option>`)}</select>`}
        <label class="sr-only" for="cal-kind">Tipo</label>
        <select class="input" id="cal-kind"><option value="">Todos los tipos</option>${Object.entries(EVENT_KINDS).map(([k, v]) => html`<option value="${k}" ${k === kindFilter ? html`selected` : ''}>${v.label}</option>`)}</select>
        ${READ_ONLY ? '' : html`<label class="follow"><input type="checkbox" id="cal-done" ${showDone ? html`checked` : ''}> Descartados</label>`}
        ${mode === 'list' ? html`<label class="follow"><input type="checkbox" id="cal-classes" ${showClasses ? html`checked` : ''}> Clases</label>` : ''}
        <span class="spacer"></span>
        ${READ_ONLY ? '' : html`<button class="btn" id="ev-new" type="button">${icon('plus', 14)} Nuevo evento</button>`}
        <button class="btn ${subscribeOpen ? 'primary' : ''}" id="ev-subscribe" type="button" aria-expanded="${subscribeOpen}">${icon('calendar', 14)} Suscribirse</button>
        <a class="btn" href="${ics}" download title="Para importar en Google Calendar u Outlook">${icon('download', 14)} .ics</a>
      </div>
      ${subscribeOpen && READ_ONLY ? html`<div class="note-banner subscribe" id="sub-panel">
        <p><b>Suscríbete una vez y tu calendario se actualiza solo</b> con todas las asignaturas cada vez que se publica una clase.</p>
        <div class="cmd"><code>${httpsFeed}</code><button class="btn sm" data-copy-sub="${httpsFeed}" type="button">${icon('copy', 14)} Copiar</button></div>
        <a class="btn sm primary" href="${webcal}">Abrir en mi app de calendario</a>
        <ul class="muted small">
          <li><b>Google Calendar</b>: Otros calendarios › + › Desde URL, y pega la dirección.</li>
          <li><b>iPhone y Apple Calendar</b>: «Abrir en mi app de calendario», o Archivo › Nueva suscripción a calendario.</li>
          <li><b>Outlook</b>: Agregar calendario › Suscribirse desde la web, y pega la dirección.</li>
        </ul></div>`
      : subscribeOpen ? html`<div class="note-banner subscribe" id="sub-panel">
        <p><b>Suscríbete una vez y tu calendario se actualiza solo</b> mientras el servidor esté encendido${fixedCourse || course ? ' (solo esta asignatura)' : ''}.</p>
        <div class="cmd"><code>${webcal}</code><button class="btn sm" data-copy-sub="${webcal}" type="button">${icon('copy', 14)} Copiar</button></div>
        <a class="btn sm primary" href="${webcal}">Abrir en mi app de calendario</a>
        <ul class="muted small">
          <li><b>Apple Calendar</b>: Archivo › Nueva suscripción a calendario, y pega la dirección.</li>
          <li><b>Outlook de escritorio</b>: Agregar calendario › Desde Internet, y pega la dirección.</li>
          <li><b>Google Calendar</b> no puede leer un servidor de tu ordenador: descarga el <a href="${ics}" download>.ics</a> e impórtalo (Configuración › Importar y exportar). Al volver a importarlo, las fechas se actualizan sin duplicarse.</li>
        </ul>
        <p class="muted small">Los avisos (días antes de cada fecha) se cambian en <a href="#/settings">Ajustes</a>.</p></div>` : ''}
      <div id="ev-form"></div>
      ${strip.some((w) => w.level !== 'none') ? loadStrip(strip) : ''}

      ${live.length === 0 ? html`<div class="empty"><h3>Sin eventos</h3><p>${READ_ONLY ? 'Todavía no hay fechas.' : 'Al generar con IA una clase, sus fechas aparecen aquí. También puedes añadirlas a mano.'}</p></div>`
      : mode === 'month' ? html`${monthGrid(live, monthOffset, loadByWeek)}<div id="ev-detail" style="margin-top:20px"></div>`
      : mode === 'week' ? html`${weekGrid(live, weekStart || mondayOf(todayIso()))}<div id="ev-detail" style="margin-top:20px"></div>`
      : html`${past.length ? html`<button class="btn sm ghost" id="cal-past" type="button" style="margin-top:12px">${showPast ? 'Ocultar las fechas pasadas' : `Ver ${past.length} ${past.length === 1 ? 'fecha pasada' : 'fechas pasadas'}`}</button>` : ''}
        ${[...months.entries()].map(([m, items]) => html`<h2 class="section">${m}</h2>${items.map((e) => eventRow(e, { withCourse: !fixedCourse }))}`)}`}

      ${undated.length ? html`<h2 class="section">Sin fecha <span class="muted">${undated.length}</span></h2>
        <p class="muted small" style="margin-bottom:6px">Se dijeron en clase pero sin un día claro.${READ_ONLY ? '' : ' Pon la fecha cuando la sepas y pasarán al calendario.'}</p>
        ${undated.map((e) => eventRow(e, { withCourse: !fixedCourse }))}` : ''}
    `);

    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
      mode = b.dataset.mode;
      if (mode === 'month') await loadMonth().catch(() => {});
      draw();
    }));
    root.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => { mode = 'week'; weekStart = b.dataset.week; draw(); }));
    root.querySelectorAll('[data-wk]').forEach((b) => b.addEventListener('click', () => {
      const current = weekStart || mondayOf(todayIso());
      weekStart = b.dataset.wk === 'now' ? mondayOf(todayIso()) : addDaysIso(current, b.dataset.wk === 'next' ? 7 : -7);
      draw();
    }));
    root.querySelector('#ev-subscribe').addEventListener('click', () => { subscribeOpen = !subscribeOpen; draw(); });
    root.querySelector('[data-copy-sub]')?.addEventListener('click', async (e) => {
      toast((await copyText(e.currentTarget.dataset.copySub)) ? 'Dirección copiada' : 'No se pudo copiar');
    });
    root.querySelector('#cal-course')?.addEventListener('change', async (e) => { course = e.target.value; await load(); draw(); });
    root.querySelector('#cal-kind').addEventListener('change', (e) => { kindFilter = e.target.value; draw(); });
    root.querySelector('#cal-classes')?.addEventListener('change', (e) => { showClasses = e.target.checked; draw(); });
    root.querySelector('#cal-past')?.addEventListener('click', () => { showPast = !showPast; draw(); });
    root.querySelector('#cal-done')?.addEventListener('change', (e) => { showDone = e.target.checked; draw(); });
    root.querySelectorAll('[data-cal]').forEach((b) => b.addEventListener('click', async () => {
      monthOffset = b.dataset.cal === 'now' ? 0 : monthOffset + (b.dataset.cal === 'next' ? 1 : -1);
      await loadMonth().catch(() => {});
      draw();
    }));
    root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      mount(root.querySelector('#ev-detail'), eventRow(events.find((x) => x.id === Number(b.dataset.pick)), { withCourse: !fixedCourse }));
    }));
    root.querySelector('#ev-new')?.addEventListener('click', () => {
      mount(root.querySelector('#ev-form'), html`<form class="form-row" id="ev-create">
        ${fixedCourse ? '' : html`<div class="field"><label for="ne-course">Asignatura</label><select class="input" id="ne-course" required>${courses.map((c) => html`<option value="${c}" ${c === course ? html`selected` : ''}>${c}</option>`)}</select></div>`}
        <div class="field"><label for="ne-kind">Tipo</label><select class="input" id="ne-kind">${Object.entries(EVENT_KINDS).map(([k, v]) => html`<option value="${k}">${v.label}</option>`)}</select></div>
        <div class="field grow"><label for="ne-title">Título</label><input class="input" id="ne-title" maxlength="200" required></div>
        <div class="field"><label for="ne-date">Fecha</label><input class="input" id="ne-date" type="date"></div>
        <div class="field"><label for="ne-time">Hora</label><input class="input" id="ne-time" type="time"></div>
        <button class="btn primary" type="submit">Añadir</button><button class="btn" type="button" id="ne-cancel">Cancelar</button></form>`);
      root.querySelector('#ne-title').focus();
      root.querySelector('#ne-cancel').onclick = () => { root.querySelector('#ev-form').innerHTML = ''; };
      root.querySelector('#ev-create').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const { event } = await api('/api/events', {
            method: 'POST',
            body: {
              course: fixedCourse ?? root.querySelector('#ne-course').value,
              kind: root.querySelector('#ne-kind').value,
              title: root.querySelector('#ne-title').value,
              date: root.querySelector('#ne-date').value || null,
              time: root.querySelector('#ne-time').value || null,
            },
          });
          events.push(event);
          events.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
          toast('Evento añadido');
          await loadLoad().catch(() => {});
          draw();
        } catch (err) { toast(err.message, 'err'); }
      };
    });
  };

  await load();
  draw();
  // A confirmed, re-dated or discarded event changes the load of its week
  bindEventActions(root, events, () => {
    draw();
    loadLoad().then(draw, () => {});
    refreshMeta().catch(() => {});
  });
}
