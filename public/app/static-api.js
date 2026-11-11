// The friends' web has no server: this answers the app's API calls from the JSON files that
// `npm run export:web` saved from the dashboard's own server (src/export/static-site.ts).
// Nothing here can change the student's data; only this visitor's light/dark theme lives in localStorage.
import { runStaticSearch } from './static-search.js';

const DATA = '/data';
const cache = new Map();
const LS = 'lv:';

function load(key) {
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`${DATA}/${key}.json`).then((r) => {
        if (!r.ok) throw Object.assign(new Error('No disponible en esta web'), { status: r.status });
        return r.json();
      })
    );
    // A failed fetch is not remembered: it is retried next time
    cache.get(key).catch(() => cache.delete(key));
  }
  return cache.get(key);
}

const manifest = () => load('manifest');
const local = {
  get(name, fallback) {
    try { const v = localStorage.getItem(LS + name); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(name, value) {
    try { localStorage.setItem(LS + name, JSON.stringify(value)); } catch { /* private mode: not kept */ }
  },
};

const NO_COURSE = '__none__';
/** The server's course filter: absent → all; the "no course" token → classes without one. */
const courseParam = (params) => {
  if (!params.has('course')) return undefined;
  const c = params.get('course');
  return c === NO_COURSE ? '' : c;
};

async function courseKey(course) {
  const key = (await manifest()).courses[course];
  if (!key) throw Object.assign(new Error('Asignatura no encontrada'), { status: 404 });
  return key;
}

const readOnly = () => Object.assign(new Error('Esta web es de solo lectura: los cambios se hacen en el panel de LectureVault'), { status: 405 });

async function get(path, params) {
  const p = path.replace(/^\/api\//, '').replace(/\/$/, '');
  const parts = p.split('/').map(decodeURIComponent);
  const [head, a, b] = parts;

  switch (head) {
    case 'settings':
      return { settings: { theme: local.get('theme', 'system'), course: '' } };
    case 'meta':
      return load('meta');
    case 'stats':
      return (await load('meta')).stats;
    case 'pending':
      return { pending: [] };
    case 'jobs':
      return { jobs: [], batch: null };
    case 'recordings': {
      if (!a) {
        const data = await load('recordings');
        const course = courseParam(params);
        return course === undefined ? data : { ...data, recordings: data.recordings.filter((r) => (r.course ?? '') === course) };
      }
      if (!b) return load(`rec/${a}`);
      if (b === 'segments') return load(`seg/${a}`);
      if (b === 'export') return load(`export/${a}`);
      break;
    }
    case 'courses': {
      const key = await courseKey(a);
      if (!b) return load(`course/${key}`);
      if (b === 'theory') return load(`theory/${key}`);
      if (b === 'export') return load(`course-export/${key}`);
      if (b === 'questions') return load(`questions/${key}`);
      if (b === 'exam-attempts') return { attempts: local.get(`attempts:${a}`, []) };
      break;
    }
    case 'exam-bank':
      return load('exam-bank');
    case 'deliverables':
      if (a && !b) return load(`deliverable/${a}`);
      break;
    case 'exams':
      if (a && !b) return load(`exam/${a}`);
      break;
    case 'events': {
      const { events } = await load('events');
      const course = courseParam(params);
      const from = params.get('from');
      const to = params.get('to');
      return {
        events: events.filter((e) =>
          (course === undefined || e.course === course) &&
          (!from || !e.date || e.date >= from) &&
          (!to || !e.date || e.date <= to)),
      };
    }
    // The weekly-load strip is not published: the calendar draws without it
    case 'workload':
      return { weeks: [] };
    case 'search': {
      const q = (params.get('q') || '').trim().slice(0, 200);
      if (!q) return { query: '', corrected: [], hits: [] };
      return runStaticSearch(q, {
        course: courseParam(params),
        recordingId: params.has('recording') ? Number(params.get('recording')) : undefined,
        limit: 60,
      });
    }
    case 'palette': {
      const q = (params.get('q') || '').trim();
      if (q.length < 2) return { classes: [], events: [], tasks: [], hits: [] };
      const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ');
      const needle = fold(q);
      const has = (...texts) => texts.some((t) => t && fold(t).includes(needle));
      const today = new Date().toLocaleDateString('sv-SE');
      const [{ recordings }, { events }, search] = await Promise.all([load('recordings'), load('events'), runStaticSearch(q, { limit: 5 })]);
      return {
        classes: recordings.filter((r) => has(r.display_title, r.title)).slice(0, 6)
          .map((r) => ({ id: r.id, title: r.display_title || r.title, course: r.course, class_number: r.class_number })),
        events: events.filter((e) => has(e.title, e.course))
          .sort((x, y) => Number((x.date ?? '9') < today) - Number((y.date ?? '9') < today) || (x.date ?? '9').localeCompare(y.date ?? '9'))
          .slice(0, 5),
        tasks: [],
        hits: search.hits,
      };
    }
    default:
      break;
  }
  throw Object.assign(new Error('No disponible en esta web'), { status: 404 });
}

/** The app's api() on the static web. */
export async function staticApi(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const url = new URL(path, location.origin);
  if (method === 'GET') return get(url.pathname, url.searchParams);

  if (url.pathname === '/api/settings' && method === 'PUT') {
    const body = options.body ?? {};
    if (typeof body.theme === 'string') local.set('theme', body.theme);
    return get('/api/settings', new URLSearchParams());
  }
  // Practice attempts are the visitor's own: they stay in this browser
  const attempts = url.pathname.match(/^\/api\/courses\/([^/]+)\/exam-attempts$/);
  if (attempts && method === 'POST') {
    const course = decodeURIComponent(attempts[1]);
    const items = (options.body ?? {}).items ?? [];
    const total = items.length;
    const correct = Math.round(items.reduce((sum, i) => sum + i.score, 0) * 100) / 100;
    const attempt = { id: Date.now(), course, total, correct, items, created_at: new Date().toISOString() };
    local.set(`attempts:${course}`, [attempt, ...local.get(`attempts:${course}`, [])].slice(0, 30));
    return { attempt };
  }
  throw readOnly();
}

/** When the data of this web was exported (shown in the footer). */
export async function exportedAt() {
  return (await manifest()).exportedAt;
}
