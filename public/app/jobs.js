// "Generar con IA" runs in the server's background queue: this module queues classes, polls while
// anything is pending, shows the run in the sidebar and tells when each class is ready.
import { api, html, mount, toast, isTyping } from './util.js';
import { refreshMeta, renderRoute, view } from './main.js';

const POLL_MS = 2500;
let active = [];
let batch = null;
let watched = new Set(); // ids of jobs seen pending: when one leaves the list, it finished
let timer = null;

/** 'queued' | 'running' | null for a class, from the last poll. */
export function jobFor(recordingId) {
  return active.find((j) => j.recording_id === recordingId)?.status ?? null;
}
export const jobLabel = (status) => (status === 'running' ? 'Generando…' : 'En cola');

/** `steps` limits the run to some pipeline steps (e.g. ['notes', 'embeddings'] to rewrite only the notes). */
export async function enqueueJobs(ids, { force = false, steps } = {}) {
  const res = await api('/api/jobs', { method: 'POST', body: { ids, force, ...(steps ? { steps } : {}) } });
  apply(res);
  if (res.queued) toast(res.queued === 1 ? 'En cola: puedes seguir usando la app mientras se genera' : `${res.queued} clases en cola: puedes seguir usando la app`);
  else toast('Ya estaba en la cola');
  schedule();
  return res;
}

export async function cancelQueued() {
  const { cancelled } = await api('/api/jobs/cancel', { method: 'POST', body: {} });
  toast(cancelled ? `${cancelled} ${cancelled === 1 ? 'clase sacada' : 'clases sacadas'} de la cola` : 'No quedaba nada en cola');
  await poll();
}

/** One line per finished class, as the old synchronous button said it. */
function outcome(job) {
  const r = job.report;
  if (job.status === 'cancelled') return null;
  if (job.status === 'failed') return { err: true, text: `${job.title}: ${job.error}` };
  if (r?.errors?.length) return { err: true, text: `${job.title}: ${r.errors[0]}` };
  return {
    err: false,
    text: `Listo: «${r?.title || job.title}» · ${r?.alerts ?? 0} avisos, ${r?.flashcards ?? 0} tarjetas${r?.proposals ? ` · ${r.proposals} por revisar` : ''}`,
  };
}

function apply(data) {
  const ended = (data.finished || []).filter((j) => watched.has(j.id));
  active = data.active || [];
  batch = data.batch || null;
  watched = new Set([...[...watched].filter((id) => !ended.some((j) => j.id === id)), ...active.map((j) => j.id)]);
  drawJobs();
  if (ended.length) finished(ended);
}

function finished(jobs) {
  const lines = jobs.map(outcome).filter(Boolean);
  const errors = lines.filter((l) => l.err);
  if (lines.length === 1) toast(lines[0].text, lines[0].err ? 'err' : 'ok', 7000);
  else if (lines.length) toast(`${lines.length - errors.length} de ${lines.length} clases listas${errors.length ? ` · ${errors[0].text}` : ''}`, errors.length ? 'err' : 'ok', 8000);
  refreshMeta().catch(() => {});
  // Redraw the page only when it shows those classes and the student is not in the middle of writing
  const [route, id] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const shows = route === 'classes' || route === 'c' || route === '' || (route === 'r' && jobs.some((j) => j.recording_id === Number(id)));
  // Open editors (notes, ficha, an inline form) would lose what was typed
  const busy = isTyping() || view().querySelector('#editor, #profile-form, form.form-row');
  if (!shows) return;
  if (busy) { toast('Hay cambios en esta página: recárgala para verlos', 'ok', 6000); return; }
  const y = window.scrollY;
  renderRoute().then(() => window.scrollTo({ top: y }), () => {});
}

async function poll() {
  try {
    const since = Math.min(...watched, Infinity);
    apply(await api(`/api/jobs${Number.isFinite(since) ? `?since=${since}` : ''}`));
  } catch { /* server restarting: try again on the next tick */ }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = active.length || watched.size ? setTimeout(poll, POLL_MS) : null;
}

let drawn = '';

export function drawJobs() {
  const box = document.getElementById('side-jobs');
  if (!box) return;
  // Redraw only on change: a poll must not swap the cancel button under the pointer
  const key = JSON.stringify([active.map((j) => [j.id, j.status]), batch]);
  if (key === drawn) return;
  drawn = key;
  box.hidden = active.length === 0;
  if (!active.length) { box.replaceChildren(); return; }
  const running = active.find((j) => j.status === 'running');
  const queued = active.filter((j) => j.status === 'queued').length;
  const pct = batch && batch.total ? Math.round((batch.done / batch.total) * 100) : 0;
  mount(box, html`
    <div class="jobs-head"><span class="spinner sm" aria-hidden="true"></span>
      <span class="clip">Generando con IA${batch && batch.total > 1 ? html` · <b>${Math.min(batch.done + 1, batch.total)} de ${batch.total}</b>` : ''}</span></div>
    ${running ? html`<a class="clip small" href="#/r/${running.recording_id}" title="${running.title}">${running.title}</a>` : ''}
    ${batch && batch.total > 1 ? html`<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${batch.total}" aria-valuenow="${batch.done}"><i style="width:${pct}%"></i></div>` : ''}
    ${queued ? html`<button class="btn sm ghost" data-cancel-jobs type="button">Cancelar ${queued === 1 ? 'la que espera' : `las ${queued} que esperan`}</button>` : ''}`);
}

/** Boot: a run started before a reload (or by another tab) shows up and keeps being followed. */
export async function initJobs() {
  document.getElementById('side-jobs')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel-jobs]')) cancelQueued().catch((err) => toast(err.message, 'err'));
  });
  try {
    const data = await api('/api/jobs');
    for (const j of data.active || []) watched.add(j.id);
    apply(data);
    schedule();
  } catch { /* no server yet */ }
}
