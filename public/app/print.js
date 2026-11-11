// The page the server prints to PDF (/print.html?kind=class&id=… or ?kind=course&course=…). It uses the same
// Markdown renderer as the app, so the PDF shows callouts and formulas exactly as the app does.
import { api, renderMarkdown, fmtDate, duration } from './util.js';

const params = new URLSearchParams(location.search);
const root = document.getElementById('doc');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function prose(markdown) {
  const box = el('div', 'prose');
  box.append(...renderMarkdown(markdown).childNodes);
  return box;
}

function header(kicker, title, meta, extraClass) {
  const head = el('header', extraClass ? `doc-head ${extraClass}` : 'doc-head');
  if (kicker) head.append(el('div', 'doc-kicker', kicker));
  head.append(el('h1', 'doc-title', title));
  if (meta) head.append(el('div', 'doc-meta', meta));
  return head;
}

async function drawClass(id) {
  const d = await api(`/api/recordings/${encodeURIComponent(id)}/export`);
  document.title = d.title;
  root.append(
    header(d.course, d.title, [fmtDate(d.date), duration(d.duration_seconds)].filter((x) => x && x !== '—').join(' · ')),
    prose(d.markdown)
  );
}

async function drawCourse(course) {
  const d = await api(`/api/courses/${encodeURIComponent(course)}/export`);
  document.title = `${d.course} · Apuntes de teoría`;
  const classes = d.topics.reduce((n, t) => n + t.classes.length, 0);
  root.append(header(d.course, 'Apuntes de teoría', `${d.topics.length} ${d.topics.length === 1 ? 'tema' : 'temas'} · ${classes} ${classes === 1 ? 'clase' : 'clases'} · ${fmtDate(new Date())}`, 'cover'));

  const toc = el('section', 'contents');
  toc.append(el('h2', '', 'Contenido'));
  const list = el('ol');
  for (const t of d.topics) {
    const item = el('li', '', t.topic);
    const sub = el('ul');
    for (const c of t.classes) sub.append(el('li', '', c.title));
    item.append(sub);
    list.append(item);
  }
  toc.append(list);
  root.append(toc);
  if (d.without_notes.length) root.append(el('p', 'doc-note', `Sin apuntes, no incluidas: ${d.without_notes.join(' · ')}`));

  d.topics.forEach((t, i) => {
    const chapter = el('section', 'chapter');
    chapter.append(el('div', 'chapter-kicker', `Capítulo ${i + 1}`), el('h1', 'chapter-title', t.topic));
    for (const c of t.classes) {
      const klass = el('section', 'klass');
      klass.append(el('h2', '', c.title), el('div', 'klass-meta', fmtDate(c.date)), prose(c.markdown));
      chapter.append(klass);
    }
    root.append(chapter);
  });
}

(async () => {
  try {
    if (params.get('kind') === 'class') await drawClass(params.get('id') || '');
    else if (params.get('kind') === 'course') await drawCourse(params.get('course') || '');
    else throw new Error('Falta "kind" (class o course)');
    await document.fonts.ready; // KaTeX fonts must be in before the page is printed
  } catch (err) {
    document.body.dataset.error = err.message || 'No se pudo preparar el documento';
  }
  document.body.dataset.ready = '1';
  // Opened from the friends' web (no server prints there): the browser's own dialog saves it as PDF
  if (params.get('print') === '1' && !document.body.dataset.error) setTimeout(() => window.print(), 300);
})();
