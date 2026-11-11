// "Grabar y transcribir": the server captures pending classes in a child process (the same flow as the
// terminal). This module starts it, follows it while it runs (sidebar) and says how it went when it ends.
// It also owns the "+" in the top right corner: a class the student picks in the campus themselves.
// (The "+" is created here, not in index.html: the read-only web for friends copies index.html and never runs this.)
import { api, html, mount, toast, isTyping, icon, confirmDialog, NO_COURSE } from './util.js';
import { refreshMeta, renderRoute, view, state } from './main.js';

const POLL_MS = 2000;
let status = null; // last answer of GET /api/capture
let wasRunning = false;
let timer = null;

const STAGE_LABEL = {
  queued: 'En cola', opening: 'Abriendo la clase', waiting: 'Esperando a que abras la clase', recording: 'Grabando',
  converting: 'Preparando el audio', transcribing: 'Transcribiendo', studying: 'Preparando apuntes', done: 'Lista', failed: 'Con error',
};
// How far along the whole flow a class is at each stage (recording fills 5%-50% as the video plays)
const WEIGHT = { queued: 0, opening: 0.02, waiting: 0.03, converting: 0.5, transcribing: 0.6, studying: 0.9, done: 1, failed: 1 };

export const captureStatus = () => status;
export const captureRunning = () => !!status?.running;
/** Why a capture cannot start (e.g. no Python environment), or null. */
export const captureProblem = () => status?.problem || null;
/** The class's entry in the capture running now, or null. */
export const captureItem = (id) => (status?.running ? status.items.find((i) => i.id === id) ?? null : null);

export function itemLabel(item) {
  if (item.state === 'opening' && status?.live) return 'Abriendo el campus';
  return item.state === 'recording' ? `Grabando ${item.percent ?? 0}%` : STAGE_LABEL[item.state] || '';
}

function fraction(item) {
  return item.state === 'recording' ? 0.05 + 0.45 * ((item.percent ?? 0) / 100) : WEIGHT[item.state] ?? 0;
}
const overall = (s) => (s.items.length ? s.items.reduce((sum, i) => sum + fraction(i), 0) / s.items.length : 0);

/** `{ ids: [...] }` for chosen classes. Throws the server's explanation when it cannot start. */
export async function startCapture(body) {
  apply(await api('/api/capture', { method: 'POST', body }));
  toast('Grabando: se abre una ventana del navegador y puedes seguir usando LectureVault', 'ok', 6000);
}

/** `{ course, date?, speed }`: a class chosen in the campus. Throws the server's explanation when it cannot start. */
export async function startLiveCapture(body) {
  apply(await api('/api/capture/live', { method: 'POST', body }));
  toast('Se abre el campus en otra ventana: abre la clase, ponla en marcha y pulsa «Empezar a grabar»', 'ok', 9000);
}

/** The ENTER of the terminal flow: starts the recording while it waits, stops and saves while it records. */
export async function enterCapture() {
  apply(await api('/api/capture/enter', { method: 'POST', body: {} }));
}

export async function cancelCapture() {
  apply(await api('/api/capture/cancel', { method: 'POST', body: {} }));
}

/** Close the notice of a finished run. */
export async function dismissCapture() {
  apply(await api('/api/capture/dismiss', { method: 'POST', body: {} }));
}

function apply(next) {
  const ended = wasRunning && !next.running;
  status = next;
  wasRunning = !!next.running;
  drawCapture();
  if (ended) finished(next);
  schedule();
}

function finished(s) {
  const done = s.items.filter((i) => i.state === 'done');
  const failed = s.items.filter((i) => i.state === 'failed');
  if (s.cancelled) toast('Captura cancelada: las clases siguen pendientes', 'ok', 6000);
  else if (failed.length || s.error) {
    const why = failed[0] ? `${failed[0].title}: ${failed[0].error}` : s.error;
    toast(`${done.length} de ${s.items.length} listas · ${why}`, 'err', 12000);
  } else toast(done.length === 1 ? `Lista: «${done[0].title}» grabada y transcrita` : `${done.length} clases grabadas y transcritas`, 'ok', 8000);

  refreshMeta().catch(() => {});
  const route = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
  const shows = route === 'classes' || route === 'c' || route === '';
  // Open editors would lose what was typed
  const busy = isTyping() || view().querySelector('#editor, #profile-form, form.form-row');
  if (!shows || busy) return;
  const y = window.scrollY;
  renderRoute().then(() => window.scrollTo({ top: y }), () => {});
}

async function poll() {
  try {
    apply(await api('/api/capture'));
  } catch {
    schedule(); // server restarting: try again on the next tick
  }
}

function schedule() {
  clearTimeout(timer);
  timer = status?.running ? setTimeout(poll, POLL_MS) : null;
}

let drawn = '';

export function drawCapture() {
  const s = status;
  // Live labels of the rows in Clases, without redrawing the page
  if (s?.running) {
    for (const i of s.items) document.querySelector(`[data-capture-state="${i.id}"]`)?.replaceChildren(document.createTextNode(itemLabel(i)));
  }
  const box = document.getElementById('side-capture');
  if (!box) return;
  // Redraw only on change: a poll must not swap the cancel button under the pointer
  const key = JSON.stringify(s?.running ? [s.live, s.items.map((i) => [i.id, i.state, i.percent])] : null);
  if (key === drawn) return;
  drawn = key;
  box.hidden = !s?.running;
  if (!s?.running) { box.replaceChildren(); return; }

  const finishedN = s.items.filter((i) => i.state === 'done' || i.state === 'failed').length;
  const current = s.items.find((i) => !['queued', 'done', 'failed'].includes(i.state)) ?? s.items.find((i) => i.state === 'queued');
  const pct = Math.round(overall(s) * 100);
  // A live capture ("+") needs the student: first to say the class is playing, later (optionally) to stop it
  const waiting = s.live && current?.state === 'waiting';
  const recording = s.live && current?.state === 'recording';
  mount(box, html`
    <div class="jobs-head"><span class="spinner sm" aria-hidden="true"></span>
      <span class="clip">${s.live ? 'Grabando una clase' : 'Grabando y transcribiendo'}${s.items.length > 1 ? html` · <b>${Math.min(finishedN + 1, s.items.length)} de ${s.items.length}</b>` : ''}</span></div>
    ${current ? html`<span class="clip small" title="${current.title}">${current.title}</span><span class="muted small">${itemLabel(current)}</span>` : ''}
    ${waiting ? html`<span class="small">Abre la clase en la ventana del campus y ponla en marcha. Cuando se esté reproduciendo, empieza.</span>
      <button class="btn sm primary" data-capture-enter="start" type="button">Empezar a grabar</button>` : ''}
    ${recording ? html`<button class="btn sm" data-capture-enter="stop" type="button" title="Detiene la grabación aquí y transcribe lo grabado">Parar y guardar</button>` : ''}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <button class="btn sm ghost" data-cancel-capture type="button">Cancelar captura</button>`);
}

/** The dialog behind the "+": which subject the class is, when it was (optional) and how fast to record. */
function chooseLiveClass() {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `<form method="dialog">
      <p class="modal-title">Grabar y transcribir una clase</p>
      <p class="modal-detail">Elige la asignatura. Se abrirá el campus en otra ventana: abre allí la clase, ponla en marcha y vuelve aquí para pulsar «Empezar a grabar». Se graba sin sonido y puedes seguir usando LectureVault.</p>
      <div class="live-form">
        <div class="field"><label for="live-course">Asignatura</label><select class="input" id="live-course" required></select></div>
        <div class="field"><label for="live-date">Fecha de la clase (opcional)</label><input class="input" id="live-date" type="date">
          <span class="field-note">Si la sabes, ponla: ayuda a situar las fechas que se digan en clase («el viernes»).</span></div>
        <div class="field"><label for="live-speed">Velocidad de grabación</label>
          <select class="input" id="live-speed"><option value="1">1× (tiempo real)</option><option value="2" selected>2× (la mitad de tiempo)</option></select></div>
      </div>
      <div class="modal-actions"><button class="btn" value="no" formnovalidate>Cancelar</button><button class="btn primary" value="yes">Abrir el campus</button></div></form>`;

    const courses = [...new Set([...state.catalog.map((c) => c.label), ...state.courses.map((c) => c.course).filter(Boolean)])];
    const course = dlg.querySelector('#live-course');
    course.append(new Option('Elige la asignatura…', ''));
    for (const c of courses) course.append(new Option(c, c));
    // The subject open in the sidebar is the likely one
    if (state.course && state.course !== NO_COURSE && courses.includes(state.course)) course.value = state.course;
    const date = dlg.querySelector('#live-date');
    date.max = new Date().toLocaleDateString('sv-SE'); // today, YYYY-MM-DD in local time: a class cannot be in the future

    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'yes';
      const choice = ok ? { course: course.value, ...(date.value ? { date: date.value } : {}), speed: Number(dlg.querySelector('#live-speed').value) } : null;
      dlg.remove();
      resolve(choice);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

async function newClass() {
  if (captureRunning()) return toast('Ya hay una captura en marcha: espera a que termine o cancélala.', 'err', 6000);
  if (captureProblem()) return toast(captureProblem(), 'err', 9000);
  const choice = await chooseLiveClass();
  if (!choice) return;
  try {
    await startLiveCapture(choice);
  } catch (err) {
    toast(err.message, 'err', 9000);
  }
}

/** Boot: a capture started before a reload (or from another tab) shows up and keeps being followed. */
export async function initCapture() {
  const box = document.getElementById('side-capture');
  box?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cancel-capture]')) cancelCapture().catch((err) => toast(err.message, 'err'));
    const enter = e.target.closest('[data-capture-enter]');
    if (!enter) return;
    // "Parar y guardar" takes the place of "Empezar a grabar": a click that was meant for the first one must not cut the class
    if (enter.dataset.captureEnter === 'stop' && !(await confirmDialog('Parar la grabación', {
      confirm: 'Parar y guardar',
      detail: 'Se guarda y se transcribe lo grabado hasta ahora. La clase no se puede retomar: para grabarla entera habría que empezar de nuevo.',
    }))) return;
    enter.disabled = true; // the same key starts and stops: one press per stage
    enterCapture().catch((err) => toast(err.message, 'err'));
  });

  if (!document.getElementById('new-class')) {
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.id = 'new-class';
    fab.type = 'button';
    fab.title = 'Grabar y transcribir una clase';
    fab.setAttribute('aria-label', 'Grabar y transcribir una clase');
    mount(fab, html`${icon('plus', 20)}`);
    fab.addEventListener('click', newClass);
    document.body.append(fab);
  }

  try {
    apply(await api('/api/capture'));
  } catch { /* no server yet */ }
}
