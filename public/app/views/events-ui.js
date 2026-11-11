// Calendar event row + actions shared by Inicio, Calendario and the course page.
import { api, html, icon, eventChip, courseChip, msClock, fmtDate, relativeDay, daysUntil, toast, confirmDialog, READ_ONLY } from '../util.js';

/** One event: kind, course, date with countdown, where it was said, and confirm / dismiss / date edit. */
export function eventRow(e, { withCourse = true, compact = false } = {}) {
  const late = e.date && !e.dismissed && daysUntil(e.date) < 0;
  const doubtful = !e.confirmed && (e.confidence === 'low' || !e.date);
  return html`<div class="item ev ${e.dismissed ? 'is-done' : ''}" data-eid="${e.id}">
    <div class="body">
      <div class="tags">${eventChip(e.kind)}${withCourse && e.course ? courseChip(e.course) : ''}
        ${e.date ? html`<span class="tag ${late ? 'tag-red' : ''}">${fmtDate(e.date)}${e.time ? ` · ${e.time}` : ''}</span><span class="muted small">${relativeDay(e.date)}</span>`
          : html`<span class="tag tag-yellow">Sin fecha</span>`}
        ${e.source === 'lms' ? html`<span class="tag tag-green" title="Del calendario oficial del campus">Universidad</span>`
          : e.source === 'user' ? (e.recording_id ? html`<span class="tag">Editado</span>` : html`<span class="tag">Manual</span>`)
          : e.confirmed ? html`<span class="tag tag-green" title="${e.external_uid ? 'También está en el calendario oficial del campus' : ''}">Confirmado</span>` : doubtful ? html`<span class="tag tag-red">Dudoso</span>` : ''}
        ${e.dismissed ? html`<span class="muted small">Descartado</span>` : ''}</div>
      <div class="txt" style="margin-top:4px">${e.title}</div>
      ${!compact && e.quote ? html`<q>${e.quote}</q>` : ''}
      ${e.recording_id ? html`<div class="meta">
        <a class="btn sm" href="#/r/${e.recording_id}?t=${Math.max(0, Math.floor(e.t_ms / 1000) - 3)}">${icon('play', 12)} ${msClock(e.t_ms)}</a>
        ${e.recording_title ? html`<span>${e.recording_title}</span>` : ''}</div>` : ''}
    </div>
    ${READ_ONLY ? '' : html`<div class="acts">
      ${e.dismissed ? html`<button class="btn sm" data-ev="restore" type="button">Restaurar</button>`
        : html`${e.confirmed ? '' : html`<button class="btn sm" data-ev="confirm" type="button">Confirmar</button>`}
               <button class="btn sm ghost" data-ev="dismiss" type="button">${e.source === 'user' && !e.recording_id ? 'Borrar' : 'Descartar'}</button>`}
      <label class="sr-only" for="ed${e.id}">Fecha</label>
      <input class="input" id="ed${e.id}" data-ev="date" type="date" value="${e.date || ''}" style="height:24px;font-size:12.5px">
    </div>`}
  </div>`;
}

/** Wire the actions of every eventRow inside `container`. `events` is updated in place; `onChange` re-renders. */
export function bindEventActions(container, events, onChange) {
  const find = (el) => events.find((x) => x.id === Number(el.closest('[data-eid]')?.dataset.eid));
  container.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-ev]');
    if (!btn) return;
    const e = find(btn);
    if (!e) return;
    try {
      if (btn.dataset.ev === 'dismiss' && e.source === 'user' && !e.recording_id) {
        if (!(await confirmDialog('Borrar este evento', { confirm: 'Borrar', danger: true }))) return;
        await api(`/api/events/${e.id}`, { method: 'DELETE' });
        events.splice(events.indexOf(e), 1);
      } else {
        const patch = { confirm: { confirmed: true }, dismiss: { dismissed: true }, restore: { dismissed: false } }[btn.dataset.ev];
        Object.assign(e, (await api(`/api/events/${e.id}`, { method: 'PATCH', body: patch })).event);
      }
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
  container.addEventListener('change', async (ev) => {
    if (ev.target.dataset.ev !== 'date') return;
    const e = find(ev.target);
    if (!e) return;
    try {
      Object.assign(e, (await api(`/api/events/${e.id}`, { method: 'PATCH', body: { date: ev.target.value || null, confirmed: !!ev.target.value } })).event);
      toast('Fecha guardada');
      onChange();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/** Local YYYY-MM-DD helpers for the grids (no time zone drift: dates are built at local midnight). */
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDaysIso = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
export const mondayOf = (iso) => addDaysIso(iso, -((dateOf(iso).getDay() + 6) % 7));
export const todayIso = () => isoOf(new Date());
const shortDay = (iso) => dateOf(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const LOAD_LABEL = { none: 'Libre', light: 'Ligera', busy: 'Cargada', critical: 'Crítica' };

/** "Semana del 2 al 8 nov: 1 examen y 1 entrega" */
function weekTitle(w) {
  const list = w.events.map((e) => e.title).join(' · ');
  return `Semana del ${shortDay(w.start)} al ${shortDay(w.end)}: ${LOAD_LABEL[w.level].toLowerCase()}${list ? ` (${list})` : ''}`;
}

/** The coming weeks as bars coloured by load; clicking one opens it in the week view (`data-week`). */
export function loadStrip(weeks) {
  return html`<div class="load-strip" role="list" aria-label="Carga de las próximas semanas">
    ${weeks.map((w) => html`<button class="load-week load-${w.level}" type="button" role="listitem" data-week="${w.start}" title="${weekTitle(w)}" aria-label="${weekTitle(w)}">
      <span class="bar" style="--h:${Math.min(100, 12 + w.score * 14)}%"></span><span class="lbl">${shortDay(w.start)}</span></button>`)}
  </div>
  <p class="muted small load-legend"><span class="load-dot load-busy"></span> cargada <span class="load-dot load-critical"></span> crítica: un examen y una entrega, o más</p>`;
}

/** Seven days from `start` (a Monday), every event of each day. Clicking an event calls `data-pick`. */
export function weekGrid(events, start) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(start, i));
  const today = todayIso();
  const title = `${shortDay(days[0])} – ${shortDay(days[6])}`;
  return html`
    <div class="cal-head"><h2>Semana del ${title}</h2>
      <button class="btn sm icon" data-wk="prev" type="button" aria-label="Semana anterior" style="transform:scaleX(-1)">${icon('chevron', 14)}</button>
      <button class="btn sm" data-wk="now" type="button">Esta semana</button>
      <button class="btn sm icon" data-wk="next" type="button" aria-label="Semana siguiente">${icon('chevron', 14)}</button></div>
    <div class="week-grid">${days.map((d) => {
      const mine = events.filter((e) => e.date === d && !e.dismissed);
      const label = dateOf(d).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' });
      return html`<div class="week-day ${d === today ? 'today' : ''}"><div class="week-dow">${label}</div>
        ${mine.length ? mine.map((e) => html`<button class="cal-ev ev-${e.kind}" type="button" data-pick="${e.id}" title="${e.title}">${e.time ? html`<b>${e.time}</b> ` : ''}${e.title}</button>`)
          : html`<span class="muted small">—</span>`}</div>`;
    })}</div>`;
}

/**
 * Month grid of events; `offset` months from the current one. Clicking an event calls `data-pick`.
 * `load` maps a week's Monday to its load level: busy and critical weeks are marked.
 */
export function monthGrid(events, offset, load = new Map(), today = new Date()) {
  const base = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const first = (base.getDay() + 6) % 7;
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const byDay = new Map();
  for (const e of events) if (e.date && !e.dismissed) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  const now = isoOf(today);
  const cells = [];
  for (let i = 0; i < Math.ceil((first + daysInMonth) / 7) * 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), 1 - first + i);
    cells.push({ d, iso: isoOf(d), other: d.getMonth() !== base.getMonth() });
  }
  const levelOf = (i) => load.get(cells[i - (i % 7)].iso) || 'none';
  const title = base.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return html`
    <div class="cal-head"><h2>${title.charAt(0).toUpperCase() + title.slice(1)}</h2>
      <button class="btn sm icon" data-cal="prev" type="button" aria-label="Mes anterior" style="transform:scaleX(-1)">${icon('chevron', 14)}</button>
      <button class="btn sm" data-cal="now" type="button">Hoy</button>
      <button class="btn sm icon" data-cal="next" type="button" aria-label="Mes siguiente">${icon('chevron', 14)}</button></div>
    <div class="cal-grid">
      ${['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => html`<div class="cal-dow">${d}</div>`)}
      ${cells.map((c, i) => html`<div class="cal-day ${c.other ? 'other' : ''} ${c.iso === now ? 'today' : ''} wk-${levelOf(i)}"><b>${c.d.getDate()}</b>
        ${(byDay.get(c.iso) || []).slice(0, 3).map((e) => html`<button class="cal-ev ev-${e.kind}" type="button" data-pick="${e.id}" title="${e.title}">${e.title}</button>`)}
        ${(byDay.get(c.iso) || []).length > 3 ? html`<span class="muted small">+${byDay.get(c.iso).length - 3}</span>` : ''}</div>`)}
    </div>`;
}
