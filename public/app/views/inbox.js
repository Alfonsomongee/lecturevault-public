// Por revisar: changes the AI may not apply on its own (a locked course sheet, a date the transcript
// does not back, a date that changed between classes). Current vs proposed, the quote, and a decision.
import { api, html, mount, icon, msClock, fmtDate, courseChip, courseHref, toast, EVENT_KINDS } from '../util.js';
import { refreshMeta } from '../main.js';
import { eventRow, bindEventActions } from './events-ui.js';

const FIELDS = {
  overview_md: 'Descripción', teacher: 'Profesor', schedule: 'Horario', pass_rules: 'Reglas de aprobado',
  syllabus: 'Temario', resources: 'Recursos', grading: 'Evaluación',
};

/** Human label for a proposal target: "profile.schedule" → "Ficha · Horario". */
function targetLabel(p) {
  const profile = /^profile\.(\w+)$/.exec(p.target)?.[1];
  if (profile) return `Ficha · ${FIELDS[profile] || profile}`;
  const event = /^event:\d+\.(\w+)$/.exec(p.target)?.[1];
  if (event) return `${p.event ? p.event.title : 'Evento'} · ${event === 'date' ? 'Fecha' : event === 'time' ? 'Hora' : 'Título'}`;
  return p.target;
}

/** Values are text, ISO dates or JSON lists (syllabus, resources, grading). */
function value(p, v) {
  if (v === null || v === undefined || v === '') return html`<span class="muted">vacío</span>`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDate(v);
  if (v.startsWith('[')) {
    try {
      const list = JSON.parse(v);
      return html`<ul class="plain">${list.map((x) => html`<li>${typeof x === 'string' ? x : x.title ?? `${x.name}${x.weight_pct ? ` · ${x.weight_pct} %` : ''}`}</li>`)}</ul>`;
    } catch { /* plain text */ }
  }
  return v;
}

export async function renderInbox(root) {
  const [{ proposals }, { to_confirm: toConfirm }] = await Promise.all([api('/api/proposals?status=open'), api('/api/home?days=14')]);
  let adding = null; // proposal whose date is being added as a new event

  /** A class can give a true date for something else: this is what keeps it without losing the current one. */
  const isDateChange = (p) => /^event:\d+\.date$/.test(p.target);
  const newEventForm = (p) => html`<form class="form-row" data-new-event>
    <div class="field"><label for="pe-kind">Tipo</label><select class="input" id="pe-kind">${Object.entries(EVENT_KINDS).map(([k, v]) => html`<option value="${k}" ${k === p.event?.kind ? html`selected` : ''}>${v.label}</option>`)}</select></div>
    <div class="field grow"><label for="pe-title">Qué es lo del ${fmtDate(p.proposed_value)}</label><input class="input" id="pe-title" maxlength="200" required></div>
    <button class="btn primary" type="submit">Añadir</button><button class="btn" type="button" data-cancel-new>Cancelar</button></form>`;

  const draw = () => {
    mount(root, html`
      <h1 class="page-title">Por revisar</h1>
      <p class="page-sub">Cambios que la IA ha encontrado pero no puede aplicar sola. Escucha el momento y decide: nada se cambia sin ti.</p>
      ${proposals.length === 0 ? html`<div class="empty"><h3>Todo revisado</h3><p>Cuando una clase diga algo distinto de lo que ya tienes fijado, aparecerá aquí.</p></div>`
      : proposals.map((p) => html`<div class="item proposal" data-pid="${p.id}">
          <div class="body">
            <div class="tags">${courseChip(p.course)}<span class="tag">${targetLabel(p)}</span></div>
            <div class="diff">
              <div><span class="muted small">Ahora</span><div>${value(p, p.current_value)}</div></div>
              <div><span class="muted small">Propuesto</span><div><b>${value(p, p.proposed_value)}</b></div></div>
            </div>
            ${p.quote ? html`<q>${p.quote}</q>` : ''}
            <div class="meta">
              ${p.recording_id ? html`<a class="btn sm" href="#/r/${p.recording_id}?t=${Math.max(0, Math.floor(p.t_ms / 1000) - 3)}">${icon('play', 12)} ${msClock(p.t_ms)}</a><span>${p.recording_title || ''}</span>` : ''}
              <a class="muted small" href="${courseHref(p.course)}">Ver asignatura</a>
            </div>
            ${adding === p.id ? newEventForm(p) : ''}
          </div>
          <div class="acts">
            <button class="btn sm primary" data-decide="accept" type="button">${icon('check', 14)} ${isDateChange(p) ? 'Cambiar la fecha' : 'Aceptar'}</button>
            ${isDateChange(p) ? html`<button class="btn sm" data-add-event type="button">${icon('plus', 14)} Añadir como evento nuevo</button>` : ''}
            <button class="btn sm ghost" data-decide="reject" type="button">Rechazar</button>
          </div>
        </div>`)}
      ${toConfirm.filter((e) => !e.dismissed && !e.confirmed).length ? html`<h2 class="section">Fechas sin confirmar <span class="muted">${toConfirm.filter((e) => !e.dismissed && !e.confirmed).length}</span></h2>
        <p class="muted small" style="margin-bottom:6px">Se dijeron en clase pero no son seguras. Escucha el momento y confirma, corrige o descarta.</p>
        ${toConfirm.filter((e) => !e.dismissed && !e.confirmed).map((e) => eventRow(e))}` : ''}
    `);
  };

  draw();
  bindEventActions(root, toConfirm, () => { draw(); refreshMeta().catch(() => {}); });
  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-new-event]')) return;
    e.preventDefault();
    const p = proposals.find((x) => x.id === adding);
    try {
      await api(`/api/proposals/${p.id}/new-event`, { method: 'POST', body: { title: root.querySelector('#pe-title').value, kind: root.querySelector('#pe-kind').value } });
      proposals.splice(proposals.indexOf(p), 1);
      adding = null;
      toast('Evento añadido: la fecha que ya tenías no cambia');
      draw();
      refreshMeta().catch(() => {});
    } catch (err) { toast(err.message, 'err'); }
  });
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel-new]')) { adding = null; draw(); return; }
    const add = e.target.closest('[data-add-event]');
    if (add) {
      adding = Number(add.closest('[data-pid]').dataset.pid);
      draw();
      root.querySelector('#pe-title').focus();
      return;
    }
    const btn = e.target.closest('[data-decide]');
    if (!btn) return;
    const p = proposals.find((x) => x.id === Number(btn.closest('[data-pid]').dataset.pid));
    btn.disabled = true;
    try {
      await api(`/api/proposals/${p.id}/${btn.dataset.decide}`, { method: 'POST' });
      proposals.splice(proposals.indexOf(p), 1);
      toast(btn.dataset.decide === 'accept' ? 'Cambio aplicado' : 'Propuesta rechazada: no se volverá a preguntar');
      draw();
      refreshMeta().catch(() => {});
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });
}
