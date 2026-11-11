// Inicio: answers "what do I have to do?": overdue, the next milestones whatever their distance, the critical
// weeks ahead, what the last classes asked for, today's review and what needs a decision; then one card per course.
import { api, html, mount, icon, clock, msClock, relativeDay, daysUntil, isoParts, courseChip, courseHref, courseCode, eventChip, toast, READ_ONLY } from '../util.js';
import { refreshMeta, REVIEW_SESSION } from '../main.js';
import { eventRow, bindEventActions } from './events-ui.js';

const SECONDS_PER_CARD = 30;
/** A position this early is a click on play, not somewhere you left off. */
const MIN_RESUME_SECONDS = 60;

const shortDate = (iso) => isoParts(iso).date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

/** Where a milestone is explained: its deliverable or exam, else the moment it was said. */
function milestoneHref(e) {
  if (e.deliverable_id) return `${courseHref(e.course, 'trabajos')}&d=${e.deliverable_id}`;
  if (e.exam_id) return `${courseHref(e.course, 'examenes')}&x=${e.exam_id}`;
  if (e.recording_id) return `#/r/${e.recording_id}?t=${Math.max(0, Math.floor(e.t_ms / 1000) - 3)}`;
  return '#/calendar';
}

const milestone = (e) => html`<a class="milestone ${daysUntil(e.date) <= 7 ? 'soon' : ''}" href="${milestoneHref(e)}">
  <span class="when"><b>${shortDate(e.date)}</b> · ${relativeDay(e.date)}${e.time ? ` · ${e.time}` : ''}</span>
  <span class="what">${e.title}</span>
  <span class="tags">${courseChip(e.course)}${eventChip(e.kind)}${!e.confirmed && e.source === 'ai' ? html`<span class="muted small">sin confirmar</span>` : ''}</span>
</a>`;

const task = (t) => html`<li class="task ${t.done ? 'is-done' : ''}" data-tid="${t.id}">
  <label><input type="checkbox" data-task-done ${t.done ? html`checked` : ''}> <span>${t.text}</span></label>
  <span class="task-meta">${courseChip(t.course)}
    <a class="muted small" href="#/r/${t.recording_id}?t=${Math.max(0, Math.floor(t.t_ms / 1000) - 3)}" title="${t.quote}">${t.class_number ? `Clase ${t.class_number} · ` : ''}${msClock(t.t_ms)}</a>
    <button class="btn sm ghost icon" data-task-dismiss type="button" aria-label="Quitar: ${t.text}" title="No es una tarea">${icon('x', 12)}</button></span>
</li>`;

export async function renderHome(root) {
  const data = await api('/api/home?days=14');
  const overdue = data.overdue.filter((e) => !e.dismissed);
  const toDecide = data.proposals + data.to_confirm.length;
  const dueNow = Math.min(data.flashcards_due, REVIEW_SESSION);
  const minutes = Math.max(1, Math.round((dueNow * SECONDS_PER_CARD) / 60));
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

  let olderOpen = false;
  // What the last class of each course asked comes first; a class that asked for nothing leaves that course empty
  const latestClass = new Map(data.courses.map((c) => [c.course, c.latest_recording_id]));
  const isCurrent = (t) => latestClass.get(t.course) === t.recording_id;

  const draw = () => {
    const current = data.tasks.filter(isCurrent);
    const older = data.tasks.filter((t) => !isCurrent(t));
    mount(root, html`
      <h1 class="page-title">Inicio</h1>
      <p class="page-sub">${today.charAt(0).toUpperCase() + today.slice(1)}</p>

      ${overdue.length ? html`<h2 class="section late">Vencido <span class="muted">${overdue.length}</span></h2>${overdue.map((e) => eventRow(e, { compact: true }))}` : ''}

      <h2 class="section">Próximos hitos<span class="spacer"></span><a class="btn sm" href="#/calendar">${icon('calendar', 14)} Calendario</a></h2>
      ${data.milestones.length ? html`<div class="milestones">${data.milestones.map(milestone)}</div>`
        : html`<div class="empty"><p>Sin entregas ni exámenes a la vista.${READ_ONLY ? '' : ' Al generar con IA una clase, sus fechas aparecen aquí.'}</p></div>`}
      ${data.heavy_weeks.slice(0, 2).map((w) => html`<a class="note-banner heavy-week" href="#/calendar?week=${w.start}">
        <span><b>Semana crítica del ${shortDate(w.start)} al ${shortDate(w.end)}</b> (${relativeDay(w.start)}): ${w.summary}${w.courses.length > 1 ? ` de ${w.courses.map(courseCode).join(', ')}` : ''}.</span>
        <span class="muted small">Ver la semana</span></a>`)}

      <h2 class="section">Antes de la próxima clase ${current.length ? html`<span class="muted">${current.filter((t) => !t.done).length}</span>` : ''}</h2>
      ${data.next_session ? html`<p class="muted small">Próxima sesión: ${courseCode(data.next_session.course)}, ${shortDate(data.next_session.date)} (${relativeDay(data.next_session.date)})</p>` : ''}
      ${current.length ? html`<ul class="tasks">${current.map(task)}</ul>`
        : html`<p class="muted small">Nada pendiente de lo que se ha pedido en clase.</p>`}
      ${older.length ? html`<details class="older-tasks" ${olderOpen ? html`open` : ''}><summary class="muted small">De clases anteriores (${older.filter((t) => !t.done).length})</summary><ul class="tasks">${older.map(task)}</ul></details>` : ''}

      <div class="quick">
        ${data.flashcards_due ? html`<a class="quick-item" href="#/study">${icon('cards', 16)}<span><b>Repaso: ${dueNow} tarjetas</b><br><span class="muted small">unos ${minutes} min${data.flashcards_due > dueNow ? ` · ${data.flashcards_due} pendientes en total` : ''}</span></span></a>`
          : html`<a class="quick-item" href="#/study">${icon('cards', 16)}<span><b>Repaso al día</b><br><span class="muted small">Sin tarjetas pendientes</span></span></a>`}
        ${toDecide && !READ_ONLY ? html`<a class="quick-item" href="#/inbox">${icon('inbox', 16)}<span><b>${toDecide} ${toDecide === 1 ? 'dato por decidir' : 'datos por decidir'}</b><br><span class="muted small">${data.proposals ? `${data.proposals} ${data.proposals === 1 ? 'cambio propuesto' : 'cambios propuestos'} · ` : ''}${data.to_confirm.length} ${data.to_confirm.length === 1 ? 'fecha sin confirmar' : 'fechas sin confirmar'}</span></span></a>` : ''}
        ${!READ_ONLY && data.continue && data.continue.seconds >= MIN_RESUME_SECONDS ? html`<a class="quick-item" href="#/r/${data.continue.id}?t=${data.continue.seconds}">${icon('play', 16)}<span><b>Seguir escuchando</b><br><span class="muted small">${data.continue.title} · ${clock(data.continue.seconds)}</span></span></a>` : ''}
      </div>

      ${data.courses.length ? html`<h2 class="section">Asignaturas</h2><div class="cards">${data.courses.map((c) => html`
        <a class="card" href="${courseHref(c.course)}">
          <div class="tags">${courseChip(c.course)}${c.locked ? html`<span class="muted small" title="Ficha fijada">${icon('lock', 12)}</span>` : ''}</div>
          <div class="card-title">${c.course.split(' ').slice(1).join(' ') || c.course}</div>
          <div class="card-next">${c.next ? html`<span>${c.next.title}</span> <span class="muted small">${relativeDay(c.next.date)}</span>` : html`<span class="muted small">Sin fechas próximas</span>`}</div>
          <div class="card-stats muted small">${c.classes} ${c.classes === 1 ? 'clase' : 'clases'} · ${c.deliverables_open} ${c.deliverables_open === 1 ? 'trabajo' : 'trabajos'}${c.flashcards_due ? ` · ${c.flashcards_due} tarjetas` : ''}</div>
        </a>`)}</div>` : ''}
    `);
  };

  draw();
  bindEventActions(root, overdue, () => { draw(); refreshMeta().catch(() => {}); });

  const find = (el) => data.tasks.find((t) => t.id === Number(el.closest('[data-tid]').dataset.tid));
  root.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-task-done]')) return;
    olderOpen = !!e.target.closest('.older-tasks');
    const t = find(e.target);
    try {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { done: e.target.checked } });
      t.done = e.target.checked ? 1 : 0; // stays visible, struck through, so a slip can be undone
      draw();
    } catch (err) { toast(err.message, 'err'); e.target.checked = !e.target.checked; }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-task-dismiss]');
    if (!b) return;
    olderOpen = !!b.closest('.older-tasks');
    const t = find(b);
    try {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { dismissed: true } });
      data.tasks.splice(data.tasks.indexOf(t), 1);
      draw();
    } catch (err) { toast(err.message, 'err'); }
  });
}
