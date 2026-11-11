// Exámenes: the question bank of every subject (true/false, multiple choice, short and long answers written from
// the transcripts) and a practice exam built from it. On the friends' web the bank is the same, read-only, and the
// practice runs in the browser: its history stays in that browser.
import { api, html, mount, icon, msClock, courseChip, fmtDate, toast, confirmDialog, READ_ONLY } from '../util.js';
import { state, onLeave } from '../main.js';
import { KIND_ORDER, KIND_LABELS, PASS, gradeQuestion, totalScore, failedIds, pickQuestions } from '../exam-grade.js';

const ORIGIN_FILTERS = [['all', 'Todas'], ['stress', 'Que enfatizó la profesora'], ['explicit', 'Dichas para el examen'], ['inferred', 'Detectadas por la IA']];
const SIZES = [10, 15, 20, 30, 'all'];
const MINUTES = [0, 15, 30, 45, 60];
const LETTERS = 'ABCDE';

const enc = encodeURIComponent;
const num = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
const isoUtc = (s) => (String(s).includes('T') ? String(s) : `${String(s).replace(' ', 'T')}Z`);
const classTitle = (q) => `${q.class_number ? `Clase ${q.class_number}. ` : ''}${q.recording_title.replace(/^Clase \d+\.\s*/, '')}`;
const minuteLink = (q, label = `${icon('play', 12)} ${msClock(q.t_ms)}`) =>
  html`<a class="btn sm" href="#/r/${q.recording_id}?tab=transcript&t=${Math.max(0, Math.floor(q.t_ms / 1000) - 3)}">${label}</a>`;
const kindTag = (q) => html`<span class="tag ${{ tf: 'tag-blue', mcq: 'tag-purple', short: 'tag-green', essay: 'tag-orange' }[q.kind]}">${KIND_LABELS[q.kind]}</span>`;
const originTag = (q) => q.origin === 'explicit'
  ? html`<span class="tag tag-red" title="La profesora lo dijo para el examen o lo preguntó ella">La profesora</span>`
  : q.emphasis ? html`<span class="tag tag-yellow" title="Insistió en ello">Enfatizada</span>` : html`<span class="tag" title="Detectada por la IA en lo explicado">IA</span>`;

// ── Landing: one card per subject ─────────────────────────
export async function renderExams(root, course, params) {
  if (course) return renderCourseExams(root, course, params);
  const { courses } = await api('/api/exam-bank');
  const shown = READ_ONLY ? courses.filter((c) => c.total > 0 || state.courses.some((x) => x.course === c.course)) : courses;
  mount(root, html`
    <h1 class="page-title">Exámenes</h1>
    <p class="page-sub">Preguntas de práctica sacadas de las clases: las que la profesora dijo para el examen y las que la IA detecta en lo que explica. Se actualizan con cada clase nueva.</p>
    ${shown.length ? html`<div class="cards">${shown.map((c) => html`
      <a class="card" href="#/exams/${enc(c.course)}">
        <div>${courseChip(c.course)}</div>
        <div class="card-title">${c.course.split(' ').slice(1).join(' ') || c.course}</div>
        ${c.total ? html`
          <div class="card-stats muted small">${c.total} ${c.total === 1 ? 'pregunta' : 'preguntas'} · ${c.classes} ${c.classes === 1 ? 'clase' : 'clases'}</div>
          <div class="tags">
            ${c.emphasis ? html`<span class="tag tag-red">${c.emphasis} enfatizadas</span>` : ''}
            ${KIND_ORDER.filter((k) => c.byKind[k]).map((k) => html`<span class="tag">${c.byKind[k]} ${KIND_LABELS[k].toLowerCase()}</span>`)}
          </div>`
          : html`<div class="muted small">Aún sin preguntas${READ_ONLY ? '' : ': se crean al generar con IA cada clase'}.</div>`}
      </a>`)}</div>`
      : html`<div class="empty"><h3>Todavía no hay preguntas</h3><p>Se crean automáticamente al procesar cada clase.</p></div>`}`);
}

// ── One subject: bank and practice ───────────────────────
async function renderCourseExams(root, course, params) {
  const [{ questions }, { attempts: saved }] = await Promise.all([
    api(`/api/courses/${enc(course)}/questions`),
    api(`/api/courses/${enc(course)}/exam-attempts`).catch(() => ({ attempts: [] })),
  ]);
  let attempts = saved;
  let mode = params.get('mode') === 'practice' ? 'practice' : 'bank';
  const bank = { kind: '', recording: '', origin: 'all', starred: false, text: '' };
  // Practice state: 'setup' | 'running' | 'done'
  const run = { stage: 'setup', picked: [], answers: new Map(), results: [], started: 0, limit: 0, timer: null, override: new Set(), saved: false, tick: 0 };
  const setup = { n: 20, kinds: new Set(KIND_ORDER), recordings: new Set(), onlyEmphasis: false, onlyFailed: false, minutes: 0 };
  const classes = [...new Map(questions.map((q) => [q.recording_id, q])).values()];
  setup.recordings = new Set(classes.map((q) => q.recording_id));
  const byId = new Map(questions.map((q) => [q.id, q]));

  const stopTimer = () => { if (run.timer) { clearInterval(run.timer); run.timer = null; } };
  const draw = () => {
    const open = new Set([...root.querySelectorAll('details.q[open]')].map((d) => d.dataset.q));
    mount(root, html`
      <div class="crumbs"><a href="#/exams">Exámenes</a> / <span>${course}</span></div>
      <h1 class="page-title">${courseChip(course)} ${course.split(' ').slice(1).join(' ') || course}</h1>
      <p class="page-sub">${questions.length} ${questions.length === 1 ? 'pregunta' : 'preguntas'} de ${classes.length} ${classes.length === 1 ? 'clase' : 'clases'}${
        questions.filter((q) => q.emphasis).length ? html` · <b>${questions.filter((q) => q.emphasis).length}</b> enfatizadas por la profesora` : ''}.</p>
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" data-mode="bank" aria-selected="${mode === 'bank'}">Banco de preguntas</button>
        <button class="tab" role="tab" data-mode="practice" aria-selected="${mode === 'practice'}">Hacer examen tipo</button>
      </div>
      <div class="tab-body">${!questions.length
        ? html`<div class="empty"><h3>Sin preguntas todavía</h3><p>Se crean al procesar las clases de esta asignatura${READ_ONLY ? '' : '. Para las ya procesadas: Ajustes › Generar preguntas de examen'}.</p></div>`
        : mode === 'bank' ? bankView() : practiceView()}</div>`);
    open.forEach((id) => root.querySelector(`details.q[data-q="${id}"]`)?.setAttribute('open', ''));
    bind();
  };

  // ── bank ──
  const visible = () => {
    const needle = bank.text.trim().toLowerCase();
    return questions.filter((q) =>
      (!bank.kind || q.kind === bank.kind) &&
      (!bank.recording || String(q.recording_id) === bank.recording) &&
      (bank.origin === 'all' || (bank.origin === 'stress' && q.emphasis) || q.origin === bank.origin) &&
      (!bank.starred || q.starred) &&
      (!needle || `${q.question} ${q.topic}`.toLowerCase().includes(needle)));
  };
  const answerView = (q) => {
    if (q.kind === 'tf') return html`<p><b>${q.answer === 'true' ? 'Verdadero' : 'Falso'}</b></p>`;
    if (q.kind === 'mcq') return html`<ol class="q-options" type="A">${q.options.map((o, i) => html`<li class="${i === Number(q.answer) ? 'right' : ''}">${o}${i === Number(q.answer) ? html` ${icon('check', 14)}` : ''}</li>`)}</ol>`;
    return html`<p>${q.answer}</p>${q.rubric.length ? html`<p class="muted small" style="margin-bottom:2px">Debe incluir:</p><ul class="plain">${q.rubric.map((r) => html`<li>${r.point}</li>`)}</ul>` : ''}`;
  };
  const bankView = () => {
    const list = visible();
    const groups = [...new Map(list.map((q) => [q.recording_id, q])).keys()];
    return html`
      <div class="toolbar">
        <select class="input" data-f="kind" aria-label="Tipo"><option value="">Todos los tipos</option>${KIND_ORDER.map((k) => html`<option value="${k}" ${bank.kind === k ? html`selected` : ''}>${KIND_LABELS[k]}</option>`)}</select>
        <select class="input" data-f="recording" aria-label="Clase"><option value="">Todas las clases</option>${classes.map((c) => html`<option value="${c.recording_id}" ${bank.recording === String(c.recording_id) ? html`selected` : ''}>${classTitle(c)}</option>`)}</select>
        <select class="input" data-f="origin" aria-label="Origen">${ORIGIN_FILTERS.map(([v, l]) => html`<option value="${v}" ${bank.origin === v ? html`selected` : ''}>${l}</option>`)}</select>
        ${READ_ONLY ? '' : html`<label class="check"><input type="checkbox" data-f="starred" ${bank.starred ? html`checked` : ''}> Destacadas</label>`}
        <input class="input" data-f="text" type="search" placeholder="Buscar…" value="${bank.text}" aria-label="Buscar en las preguntas">
        <span class="spacer"></span><span class="muted small">${list.length} ${list.length === 1 ? 'pregunta' : 'preguntas'}</span>
      </div>
      ${list.length ? groups.map((rid) => {
        const inClass = list.filter((q) => q.recording_id === rid);
        return html`<h3 class="bucket"><a href="#/r/${rid}">${classTitle(inClass[0])}</a><span class="muted" style="text-transform:none;font-weight:400">${inClass[0].class_date ? ` · ${fmtDate(inClass[0].class_date)}` : ''}</span></h3>
          ${inClass.map((q) => html`<details class="q" data-q="${q.id}">
            <summary><span class="tags">${kindTag(q)}${originTag(q)}</span><span class="q-text">${q.question}</span></summary>
            <div class="q-body">
              ${answerView(q)}
              ${q.explanation ? html`<p class="muted">${q.explanation}</p>` : ''}
              ${q.quote ? html`<q class="q-quote">${q.quote}</q>` : ''}
              <div class="acts-row">${minuteLink(q, html`${icon('play', 12)} ${msClock(q.t_ms)} en la clase`)}
                ${READ_ONLY ? '' : html`<button class="btn sm" data-star="${q.id}" type="button">${icon('star', 12)} ${q.starred ? 'Quitar destacada' : 'Destacar'}</button>
                <button class="btn sm ghost" data-dismiss="${q.id}" type="button">No me sirve</button>`}</div>
            </div>
          </details>`)}`;
      }) : html`<p class="muted">Ninguna pregunta con estos filtros.</p>`}`;
  };

  // ── practice ──
  const failed = () => failedIds(attempts);
  const poolSize = () => pickQuestions(questions, { n: 'all', kinds: [...setup.kinds], recordings: setup.recordings, onlyEmphasis: setup.onlyEmphasis, onlyFailed: setup.onlyFailed, failed: failed() }).length;
  const historyView = () => attempts.length ? html`
    <h3 class="bucket">Tus intentos</h3>
    <table class="db"><thead><tr><th>Fecha</th><th class="num">Preguntas</th><th class="num">Nota</th></tr></thead><tbody>
      ${attempts.slice(0, 8).map((a) => html`<tr><td>${fmtDate(isoUtc(a.created_at), true)}</td>
        <td class="num">${a.total}</td><td class="num">${num((a.correct / a.total) * 10)} / 10</td></tr>`)}
    </tbody></table>` : '';
  const practiceView = () => run.stage === 'setup' ? setupView() : run.stage === 'running' ? runningView() : resultsView();

  const setupView = () => html`
    <div class="exam-setup">
      <fieldset><legend>Preguntas</legend>
        <div class="seg-ctl">${SIZES.map((s) => html`<button type="button" data-n="${s}" aria-pressed="${setup.n === s}">${s === 'all' ? 'Todas' : s}</button>`)}</div>
      </fieldset>
      <fieldset><legend>Tipos</legend>
        ${KIND_ORDER.map((k) => html`<label class="check"><input type="checkbox" data-kind="${k}" ${setup.kinds.has(k) ? html`checked` : ''}> ${KIND_LABELS[k]}</label>`)}
      </fieldset>
      <fieldset><legend>Clases</legend>
        ${classes.map((c) => html`<label class="check"><input type="checkbox" data-rec="${c.recording_id}" ${setup.recordings.has(c.recording_id) ? html`checked` : ''}> ${classTitle(c)}</label>`)}
      </fieldset>
      <fieldset><legend>Opciones</legend>
        <label class="check"><input type="checkbox" data-opt="onlyEmphasis" ${setup.onlyEmphasis ? html`checked` : ''}> Solo lo que enfatizó la profesora</label>
        <label class="check"><input type="checkbox" data-opt="onlyFailed" ${setup.onlyFailed ? html`checked` : ''} ${failed().size ? '' : html`disabled`}> Solo las que fallé antes (${failed().size})</label>
        <label class="field" style="margin-top:6px">Tiempo
          <select class="input" data-minutes>${MINUTES.map((m) => html`<option value="${m}" ${setup.minutes === m ? html`selected` : ''}>${m ? `${m} minutos` : 'Sin límite'}</option>`)}</select></label>
      </fieldset>
    </div>
    <p class="muted small">Se priorizan las que enfatizó la profesora y las que aún no has visto o fallaste. ${poolSize()} ${poolSize() === 1 ? 'pregunta disponible' : 'preguntas disponibles'} con estos filtros.</p>
    <div class="toolbar"><button class="btn primary" data-start type="button" ${poolSize() ? '' : html`disabled`}>Empezar examen</button></div>
    ${historyView()}`;

  const questionInput = (q, i) => {
    if (q.kind === 'tf') return html`<div class="q-choices">${[[true, 'Verdadero'], [false, 'Falso']].map(([v, l]) => html`<label class="check"><input type="radio" name="q${q.id}" data-ans="${q.id}" value="${v}" ${run.answers.get(q.id) === v ? html`checked` : ''}> ${l}</label>`)}</div>`;
    if (q.kind === 'mcq') return html`<div class="q-choices">${q.options.map((o, k) => html`<label class="check"><input type="radio" name="q${q.id}" data-ans="${q.id}" value="${k}" ${run.answers.get(q.id) === k ? html`checked` : ''}> <b>${LETTERS[k]}.</b> ${o}</label>`)}</div>`;
    return html`<textarea class="input" data-ans="${q.id}" rows="${q.kind === 'essay' ? 7 : 3}" placeholder="Escribe tu respuesta…" aria-label="Respuesta a la pregunta ${i + 1}">${run.answers.get(q.id) ?? ''}</textarea>`;
  };
  const runningView = () => html`
    <div class="toolbar sticky-bar"><b>${run.picked.length} preguntas</b>${run.limit ? html`<span class="tag" id="exam-clock">--:--</span>` : ''}<span class="spacer"></span>
      <button class="btn ghost" data-abort type="button">Abandonar</button><button class="btn primary" data-finish type="button">Entregar</button></div>
    <ol class="exam-list">${run.picked.map((q, i) => html`<li class="exam-q"><div class="tags">${kindTag(q)}</div><p class="q-text">${q.question}</p>${questionInput(q, i)}</li>`)}</ol>
    <div class="toolbar"><button class="btn primary" data-finish type="button">Entregar</button></div>`;

  const scoreOf = (q, i) => (run.override.has(q.id) ? 1 : run.results[i].score);
  const resultsView = () => {
    const scores = run.picked.map((q, i) => ({ id: q.id, score: scoreOf(q, i) }));
    const points = totalScore(scores);
    const bad = scores.filter((s) => s.score < PASS).length;
    return html`
      <div class="exam-score"><div class="big">${num((points / run.picked.length) * 10)}<span class="muted"> / 10</span></div>
        <div class="muted">${num(points)} de ${run.picked.length} puntos · ${run.picked.length - bad} ${run.picked.length - bad === 1 ? 'bien' : 'bien'}, ${bad} por repasar</div></div>
      <div class="toolbar">
        <button class="btn primary" data-save type="button" ${run.saved ? html`disabled` : ''}>${run.saved ? 'Guardado en tus intentos' : 'Guardar resultado'}</button>
        ${bad ? html`<button class="btn" data-retry-failed type="button">Repasar las falladas (${bad})</button>` : ''}
        <button class="btn ghost" data-again type="button">Nuevo examen</button>
      </div>
      <ol class="exam-list">${run.picked.map((q, i) => {
        const r = run.results[i];
        const s = scoreOf(q, i);
        const mark = s >= PASS ? html`<span class="tag tag-green">${icon('check', 12)} Bien</span>` : s > 0 ? html`<span class="tag tag-yellow">Parcial ${num(s * 100)} %</span>` : html`<span class="tag tag-red">${r.answered ? 'Mal' : 'Sin responder'}</span>`;
        const given = run.answers.get(q.id);
        return html`<li class="exam-q ${s >= PASS ? 'ok' : 'bad'}"><div class="tags">${kindTag(q)}${originTag(q)}${mark}</div>
          <p class="q-text">${q.question}</p>
          ${q.kind === 'tf' ? html`<p>Tu respuesta: <b>${given === true ? 'Verdadero' : given === false ? 'Falso' : '—'}</b> · Correcta: <b>${q.answer === 'true' ? 'Verdadero' : 'Falso'}</b></p>` : ''}
          ${q.kind === 'mcq' ? html`<ol class="q-options" type="A">${q.options.map((o, k) => html`<li class="${k === Number(q.answer) ? 'right' : k === given ? 'wrong' : ''}">${o}${k === given ? html` <span class="muted small">(tu respuesta)</span>` : ''}</li>`)}</ol>` : ''}
          ${q.kind === 'short' || q.kind === 'essay' ? html`
            <p class="muted small" style="margin-bottom:2px">Tu respuesta</p><p class="q-given">${given || '—'}</p>
            <p class="muted small" style="margin-bottom:2px">Respuesta modelo</p><p>${q.answer}</p>
            ${q.rubric.length ? html`<ul class="plain rubric">${q.rubric.map((item, k) => html`<li class="${r.hits[k] ? 'right' : 'wrong'}">${r.hits[k] ? icon('check', 13) : icon('x', 13)} ${item.point}</li>`)}</ul>` : ''}
            <label class="check"><input type="checkbox" data-override="${q.id}" ${run.override.has(q.id) ? html`checked` : ''}> Me la doy por buena</label>` : ''}
          ${q.explanation ? html`<p class="muted">${q.explanation}</p>` : ''}
          <div class="acts-row">${minuteLink(q, html`${icon('play', 12)} Repasar en la clase (${msClock(q.t_ms)})`)}</div></li>`;
      })}</ol>`;
  };

  const finish = () => {
    stopTimer();
    run.results = run.picked.map((q) => gradeQuestion(q, run.answers.get(q.id)));
    run.stage = 'done';
    run.saved = false;
    run.override.clear();
    draw();
    window.scrollTo({ top: 0 });
  };
  const startExam = (opts) => {
    run.picked = pickQuestions(questions, {
      n: setup.n, kinds: [...setup.kinds], recordings: setup.recordings, onlyEmphasis: setup.onlyEmphasis,
      failed: failed(), seen: new Set(attempts.flatMap((a) => a.items.map((i) => i.id))), ...opts,
    });
    if (!run.picked.length) { toast('No hay preguntas con estos filtros', 'err'); return; }
    run.answers = new Map();
    run.stage = 'running';
    run.limit = setup.minutes * 60;
    run.started = Date.now();
    draw();
    window.scrollTo({ top: 0 });
    if (run.limit) {
      const clock = () => {
        const left = Math.max(0, run.limit - Math.round((Date.now() - run.started) / 1000));
        const el = root.querySelector('#exam-clock');
        if (el) el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
        if (left === 0) { toast('Se acabó el tiempo: examen entregado', 'ok'); finish(); }
      };
      clock();
      run.timer = setInterval(clock, 1000);
    }
  };

  const flag = async (id, patch) => {
    try {
      const { question } = await api(`/api/exam-questions/${id}`, { method: 'PATCH', body: patch });
      const i = questions.findIndex((q) => q.id === id);
      if (patch.dismissed) questions.splice(i, 1); else Object.assign(questions[i], { starred: question.starred });
      draw();
    } catch (e) { toast(e.message, 'err'); }
  };

  function bind() {
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      history.replaceState(null, '', `#/exams/${enc(course)}${mode === 'practice' ? '?mode=practice' : ''}`);
      draw();
    }));
    // bank
    root.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.type === 'search' ? 'input' : 'change', () => {
      bank[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      const caret = el.selectionStart;
      draw();
      if (el.type === 'search') { const again = root.querySelector('[data-f="text"]'); again.focus(); again.setSelectionRange(caret, caret); }
    }));
    root.querySelectorAll('[data-star]').forEach((b) => b.addEventListener('click', () => flag(Number(b.dataset.star), { starred: !byId.get(Number(b.dataset.star)).starred })));
    root.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => flag(Number(b.dataset.dismiss), { dismissed: true })));
    // setup
    root.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => { setup.n = b.dataset.n === 'all' ? 'all' : Number(b.dataset.n); draw(); }));
    root.querySelectorAll('[data-kind]').forEach((c) => c.addEventListener('change', () => { c.checked ? setup.kinds.add(c.dataset.kind) : setup.kinds.delete(c.dataset.kind); draw(); }));
    root.querySelectorAll('[data-rec]').forEach((c) => c.addEventListener('change', () => { const id = Number(c.dataset.rec); c.checked ? setup.recordings.add(id) : setup.recordings.delete(id); draw(); }));
    root.querySelectorAll('[data-opt]').forEach((c) => c.addEventListener('change', () => { setup[c.dataset.opt] = c.checked; draw(); }));
    root.querySelector('[data-minutes]')?.addEventListener('change', (e) => { setup.minutes = Number(e.target.value); });
    root.querySelector('[data-start]')?.addEventListener('click', () => startExam({ onlyFailed: setup.onlyFailed }));
    // running
    root.querySelectorAll('[data-ans]').forEach((el) => el.addEventListener(el.tagName === 'TEXTAREA' ? 'input' : 'change', () => {
      const id = Number(el.dataset.ans);
      const q = byId.get(id);
      run.answers.set(id, q.kind === 'tf' ? el.value === 'true' : q.kind === 'mcq' ? Number(el.value) : el.value);
    }));
    root.querySelectorAll('[data-finish]').forEach((b) => b.addEventListener('click', async () => {
      const blank = run.picked.filter((q) => { const a = run.answers.get(q.id); return a === undefined || a === ''; }).length;
      if (blank && !(await confirmDialog('Entregar el examen', { confirm: 'Entregar', detail: `Hay ${blank} ${blank === 1 ? 'pregunta sin responder' : 'preguntas sin responder'}.` }))) return;
      finish();
    }));
    root.querySelector('[data-abort]')?.addEventListener('click', async () => {
      if (await confirmDialog('Abandonar el examen', { confirm: 'Abandonar', danger: true, detail: 'Se pierden las respuestas.' })) { stopTimer(); run.stage = 'setup'; draw(); }
    });
    // results
    root.querySelectorAll('[data-override]').forEach((c) => c.addEventListener('change', () => {
      const id = Number(c.dataset.override);
      c.checked ? run.override.add(id) : run.override.delete(id);
      run.saved = false;
      const y = window.scrollY; draw(); window.scrollTo({ top: y });
    }));
    root.querySelector('[data-save]')?.addEventListener('click', async () => {
      try {
        const items = run.picked.map((q, i) => ({ id: q.id, score: scoreOf(q, i) }));
        const { attempt } = await api(`/api/courses/${enc(course)}/exam-attempts`, { method: 'POST', body: { items } });
        attempts = [attempt, ...attempts];
        run.saved = true;
        draw();
      } catch (e) { toast(e.message, 'err'); }
    });
    root.querySelector('[data-retry-failed]')?.addEventListener('click', () => {
      const ids = new Set(run.picked.filter((q, i) => scoreOf(q, i) < PASS).map((q) => q.id));
      startExam({ n: 'all', onlyFailed: true, failed: ids, kinds: KIND_ORDER, recordings: null, onlyEmphasis: false });
    });
    root.querySelector('[data-again]')?.addEventListener('click', () => { run.stage = 'setup'; draw(); });
  }

  onLeave(stopTimer);
  draw();
}
