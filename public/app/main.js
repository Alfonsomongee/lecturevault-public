// App shell: state, hash router, sidebar, global search. Preferences live in the server database.
import { api, html, mount, icon, courseLabel, courseCode, courseTag, courseHref, NO_COURSE, toast, isTyping, READ_ONLY } from './util.js';
import { renderLibrary } from './views/library.js';
import { renderHome } from './views/home.js';
import { renderCalendar } from './views/calendar.js';
import { renderInbox } from './views/inbox.js';
import { renderCourse } from './views/course.js';
import { renderRecording } from './views/recording.js';
import { renderSearch } from './views/search.js';
import { renderStudy } from './views/study.js';
import { renderExams } from './views/exams.js';
import { renderAsk } from './views/ask.js';
import { renderSettings } from './views/settings.js';
import { openPalette } from './views/palette.js';
import { initJobs } from './jobs.js';
import { initCapture } from './capture.js';

export const state = {
  courses: [],
  catalog: [],
  stats: {},
  pending: 0,
  proposals: 0,
  ai: false,
  course: '',
  theme: 'system',
};
export const view = () => document.getElementById('view');
/** Cards in one review session: a number you can finish instead of the whole backlog. */
export const REVIEW_SESSION = 20;

// ── preferences (stored in SQLite via /api/settings) ───────
function applyTheme() {
  if (state.theme === 'light' || state.theme === 'dark') document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
}
export async function setTheme(theme) {
  state.theme = theme;
  applyTheme();
  await api('/api/settings', { method: 'PUT', body: { theme } }).catch((e) => toast(e.message, 'err'));
}
export function setCourse(course) {
  state.course = course || '';
  if (!READ_ONLY) api('/api/settings', { method: 'PUT', body: { course: state.course } }).catch(() => {});
  drawChrome();
  renderRoute();
}

/** Single place where sidebar/nav data is updated (the library view feeds it from its own fetch). */
export function applyMeta(data) {
  state.courses = data.courses || [];
  state.catalog = data.catalog || [];
  state.stats = data.stats || {};
  state.pending = data.pending ?? state.pending;
  state.proposals = data.proposals ?? state.proposals;
  state.ai = !!data.ai;
  if (state.course && state.course !== NO_COURSE && !state.courses.some((c) => c.course === state.course) && !state.catalog.some((c) => c.label === state.course)) state.course = '';
  drawChrome();
}
/** Light endpoint: counts and courses only, not the whole library. */
export async function refreshMeta() {
  applyMeta(await api('/api/meta'));
}

function parseHash() {
  const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

/** The only places of the read-only friends' web (the rest opens Clases). */
const READ_ONLY_ROUTES = ['r', 'c', 'search', 'calendar', 'exams'];

let cleanup = null;
export function onLeave(fn) { cleanup = fn; }

export async function renderRoute() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  // The old Agenda (per-class alerts) became Calendario; each class keeps its alerts in «Más › Avisos»
  if (!READ_ONLY && location.hash.startsWith('#/agenda')) history.replaceState(null, '', '#/calendar');
  const { parts, params } = parseHash();
  // Fresh container each time: listeners bound by a view die with the old node
  const old = view();
  const root = old.cloneNode(false);
  old.replaceWith(root);
  let name = parts[0] || '';
  // The friends' web shows classes, subjects, exams, search and the calendar (no home, flashcards review or ask)
  if (READ_ONLY && !READ_ONLY_ROUTES.includes(name)) name = 'classes';
  root.innerHTML = '<div class="loading"><div class="spinner" role="progressbar" aria-label="Cargando"></div></div>';
  drawNav(name);
  try {
    if (name === 'r' && parts[1]) await renderRecording(root, Number(parts[1]), params);
    else if (name === 'c' && parts[1]) await renderCourse(root, decodeURIComponent(parts[1]), params);
    else if (name === 'classes') await renderLibrary(root);
    else if (name === 'calendar') await renderCalendar(root, params);
    else if (name === 'inbox') await renderInbox(root);
    else if (name === 'search') await renderSearch(root, params);
    else if (name === 'exams') await renderExams(root, parts[1] ? decodeURIComponent(parts[1]) : '', params);
    else if (name === 'study') await renderStudy(root);
    else if (name === 'ask') await renderAsk(root, params);
    else if (name === 'settings') { root.classList.add('wide'); await renderSettings(root); }
    else await renderHome(root);
  } catch (err) {
    mount(root, html`<div class="empty"><h3>No se pudo cargar</h3><p>${err.message}</p><a class="btn" href="#/">${READ_ONLY ? 'Ver todas las clases' : 'Volver al inicio'}</a></div>`);
  }
  window.scrollTo({ top: 0 });
}

function drawNav(active) {
  const s = state.stats;
  if (READ_ONLY) {
    const isClasses = (!active || active === 'classes' || active === 'r' || active === 'search') && !state.course;
    mount(document.getElementById('nav'), html`
      <a href="#/classes" ${isClasses ? html`aria-current="page"` : ''} data-all-classes>
        ${icon('library')}<span class="clip">Todas las clases</span>${s.transcribed ? html`<span class="count">${s.transcribed}</span>` : ''}
      </a>
      <a href="#/calendar" ${active === 'calendar' ? html`aria-current="page"` : ''}>${icon('calendar')}<span class="clip">Calendario</span></a>
      <a href="#/exams" ${active === 'exams' ? html`aria-current="page"` : ''}>${icon('exam')}<span class="clip">Exámenes</span></a>`);
    return;
  }
  const items = [
    ['', 'home', 'Inicio', null, false],
    ['calendar', 'calendar', 'Calendario', null, false],
    ['inbox', 'inbox', 'Por revisar', state.proposals || null, true],
    ['classes', 'library', 'Clases', state.pending ? state.pending : null, false],
    ['exams', 'exam', 'Exámenes', null, false],
    ['study', 'cards', 'Repaso', Math.min(s.flashcardsDue || 0, REVIEW_SESSION) || null, true],
    ['ask', 'chat', 'Preguntar', null, false],
  ];
  const current = (route) => active === route || (route === 'classes' && (active === 'r' || active === 'search'));
  mount(document.getElementById('nav'), html`${items.map(([route, ico, label, n, hot]) => html`
    <a href="#/${route}" ${current(route) ? html`aria-current="page"` : ''}>
      ${icon(ico)}<span class="clip">${label}</span>${n ? html`<span class="count ${hot ? 'alert' : ''}">${n}</span>` : ''}
    </a>`)}`);
}

function drawChrome() {
  const { parts } = parseHash();
  const active = READ_ONLY && !READ_ONLY_ROUTES.includes(parts[0] || '') ? 'classes' : (parts[0] || '');
  drawNav(active);
  const openCourse = parts[0] === 'c' && parts[1] ? decodeURIComponent(parts[1]) : null;
  const counts = new Map(state.courses.map((c) => [c.course, c.count]));
  // Catalog subjects always show (even with 0 classes), then any other course; each one opens its page
  const known = new Set(state.catalog.map((c) => c.label));
  const entries = [
    ...state.catalog.map((c) => ({ value: c.label, n: counts.get(c.label) || 0 })),
    ...state.courses.filter((c) => c.course && !known.has(c.course)).map((c) => ({ value: c.course, n: c.count })),
  ];
  mount(document.getElementById('side-courses'), html`
    ${entries.map((e) => html`<a href="${courseHref(e.value)}" data-course="${e.value}" title="${e.value}" ${openCourse === e.value ? html`aria-current="page"` : ''}>
      <span class="dot tag-${courseTag(e.value)}" aria-hidden="true"></span><span class="clip"><b>${courseCode(e.value)}</b> ${e.value.split(' ').slice(1).join(' ')}</span><span class="count">${e.n}</span></a>`)}
    ${counts.get('') ? html`<a href="#/classes" data-course="${NO_COURSE}" ${READ_ONLY && !openCourse && state.course === NO_COURSE ? html`aria-current="page"` : ''}><span class="dot" aria-hidden="true"></span><span class="clip">${courseLabel('')}</span><span class="count">${counts.get('')}</span></a>` : ''}`);
  mount(document.getElementById('side-foot'), html`
    <a href="#" data-palette title="${READ_ONLY ? 'Buscar o saltar a cualquier clase o asignatura' : 'Ir a cualquier sitio escribiendo'}">${icon('search')}<span class="clip">${READ_ONLY ? 'Buscar / Ir a…' : 'Ir a…'}</span><span class="count"><kbd>Ctrl K</kbd></span></a>
    ${READ_ONLY
      ? html`<a href="#" data-theme-cycle title="Cambiar entre claro, oscuro y el del sistema">${icon('contrast')}<span class="clip">Tema: ${THEME_NAMES[state.theme] ?? 'Auto'}</span></a>
        ${state.exportedAt ? html`<div class="side-updated muted small">Actualizado ${state.exportedAt}</div>` : ''}`
      : html`<a href="#/settings" ${parts[0] === 'settings' ? html`aria-current="page"` : ''}>${icon('settings')}<span class="clip">Ajustes</span></a>`}`);
}

const THEME_NAMES = { system: 'Auto', light: 'Claro', dark: 'Oscuro' };
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' };

if (READ_ONLY) {
  document.getElementById('nav').addEventListener('click', (e) => {
    if (!e.target.closest('[data-all-classes]')) return;
    state.course = '';
    if (location.hash === '#/classes') {
      drawChrome();
      renderRoute();
    }
  });
  document.querySelector('.workspace')?.addEventListener('click', () => {
    state.course = '';
    if (!location.hash || location.hash === '#/' || location.hash === '#/classes') {
      drawChrome();
      renderRoute();
    }
  });
}

// Opening a course also makes it the filter for Clases, Repaso and Preguntar
document.getElementById('side-courses').addEventListener('click', (e) => {
  const link = e.target.closest('[data-course]');
  if (!link) return;
  state.course = link.dataset.course;
  if (!READ_ONLY) api('/api/settings', { method: 'PUT', body: { course: state.course } }).catch(() => {});
  else if (link.dataset.course === NO_COURSE && location.hash === '#/classes') {
    drawChrome();
    renderRoute();
  }
});
addEventListener('hashchange', drawChrome);

// Phone: the sidebar is a drawer under the top bar; it closes when a place is chosen
const sidebar = document.getElementById('sidebar');
const menuToggle = document.getElementById('menu-toggle');
function setMenu(open) {
  sidebar.classList.toggle('open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Cerrar el menú' : 'Abrir el menú');
}
menuToggle.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
addEventListener('hashchange', () => setMenu(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('open')) setMenu(false); });
document.addEventListener('click', (e) => { if (sidebar.classList.contains('open') && !sidebar.contains(e.target)) setMenu(false); });
document.getElementById('side-foot').addEventListener('click', async (e) => {
  if (e.target.closest('[data-theme-cycle]')) {
    e.preventDefault();
    await setTheme(NEXT_THEME[state.theme] ?? 'system');
    drawChrome();
    return;
  }
  if (!e.target.closest('[data-palette]')) return;
  e.preventDefault();
  openPalette();
});

// Global search: type anywhere, results update as you type
const input = document.getElementById('global-search');
mount(document.getElementById('search-ico'), icon('search', 14));
let timer;
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  go(`#/search?q=${encodeURIComponent(input.value.trim())}`);
});
input.addEventListener('input', () => {
  clearTimeout(timer);
  // On a phone the field is inside the drawer, over the results: there the search runs on Enter
  if (matchMedia('(max-width: 900px)').matches) return;
  timer = setTimeout(() => {
    const q = input.value.trim();
    if (q.length >= 2) history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`), renderRoute();
  }, 220);
});
export function go(hash) { if (location.hash === hash) renderRoute(); else location.hash = hash; }

// "/" types in the sidebar search; Ctrl+K opens the palette from anywhere, even from a text field
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  } else if (e.key === '/' && !isTyping()) {
    e.preventDefault();
    input.focus();
    input.select();
  }
});
addEventListener('hashchange', renderRoute);

(async function boot() {
  try {
    const { settings } = await api('/api/settings');
    state.theme = settings.theme || 'system';
    state.course = settings.course || '';
    applyTheme();
    if (READ_ONLY) {
      const { exportedAt } = await import('./static-api.js');
      const when = new Date(await exportedAt());
      state.exportedAt = when.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ', ' + when.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    }
    await refreshMeta();
    if (!READ_ONLY) {
      await initJobs();
      await initCapture();
    }
  } catch (err) {
    toast(READ_ONLY ? `No se pudieron cargar los datos: ${err.message}` : `No se pudo conectar con el servidor: ${err.message}`, 'err', 8000);
  }
  await renderRoute();
  // The dashboard's counts change while it works; the friends' web only changes with a new deploy
  if (!READ_ONLY) setInterval(() => { refreshMeta().catch(() => {}); }, 60000);
  // The friends' web can be installed and opens the classes already seen without connection (sw.js)
  if (READ_ONLY && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
