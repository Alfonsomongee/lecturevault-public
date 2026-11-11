// Notas: the course's grading table with the student's scores, and what is still needed to reach a target.
// The table comes from the AI and is often loose (weights over 100 %, parts at the top level): «Editar tabla»
// fixes it, and from then on the table is the student's (the AI can only propose changes).
import { api, html, mount, icon, toast, confirmDialog } from '../util.js';

const fmt = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100).replace('.', ','));
const pct = (n) => `${fmt(n)} %`;

/** Older versions kept the target in this browser: move it to the server once, then forget it. */
function legacyTarget(course) {
  try {
    const key = `lv.grade-target.${course}`;
    const v = Number(localStorage.getItem(key));
    localStorage.removeItem(key);
    return v > 0 && v <= 10 ? v : null;
  } catch { return null; }
}

/** One sentence that answers "what do I need?". */
function verdict(p) {
  const t = fmt(p.target);
  const mins = p.minimums.filter((m) => m.status !== 'met');
  switch (p.status) {
    case 'no-data': return html`Añade los criterios de evaluación con su peso para calcular la nota.`;
    case 'passed': return html`Nota final: <b>${fmt(p.floor)}</b>. Alcanzas el ${t}.`;
    case 'failed': return mins.some((m) => m.status === 'failed')
      ? html`Nota media ${fmt(p.floor)}, pero no llegas al mínimo en <b>${mins.filter((m) => m.status === 'failed').map((m) => m.name).join(', ')}</b>.`
      : html`Nota final: <b>${fmt(p.floor)}</b>. No llegas al ${t}.`;
    case 'secured': return html`El ${t} ya está asegurado aunque saques un 0 en lo que queda.`;
    case 'unreachable': return p.minimums.some((m) => m.status === 'failed' || m.status === 'impossible')
      ? html`Ya no es posible llegar al mínimo en <b>${p.minimums.filter((m) => m.status === 'failed' || m.status === 'impossible').map((m) => m.name).join(', ')}</b>.`
      : html`Con un 10 en todo lo que queda llegarías a un ${fmt(p.ceiling)}: no alcanzas el ${t}.`;
    default: return p.needed !== null
      ? html`Necesitas una media de <b class="big">${fmt(p.needed)}</b> en lo que queda (${pct(p.totalWeight - p.gradedWeight)} de la nota)${mins.length ? ', y respetar los mínimos marcados' : ''}.`
      : html`Necesitas lo indicado en cada criterio para llegar al ${t}.`;
  }
}

export async function renderGrades(panel, course, { passRules = '' } = {}) {
  const url = `/api/courses/${encodeURIComponent(course)}/grades`;
  let editing = false;
  let data = await api(url);
  const legacy = legacyTarget(course);
  if (legacy !== null && !data.targetSaved) data = await api(`${url}/target`, { method: 'PUT', body: { target: legacy } });
  let target = data.target;

  const reload = async () => { data = await api(url); draw(); };

  const draw = () => {
    const p = data.projection;
    const leafById = new Map(p.leaves.filter((l) => l.id !== null).map((l) => [l.id, l]));
    const ids = new Set(data.items.map((g) => g.id));
    const childrenOf = (id) => data.items.filter((g) => g.parent_id === id);
    const restOf = (g) => p.leaves.find((l) => l.id === null && l.name === `Resto de ${g.name}`);
    const focused = document.activeElement?.dataset?.focusKey;

    const scoreCell = (g) => html`<input class="input num-input" type="number" min="0" max="10" step="0.01" inputmode="decimal"
      data-score="${g.id}" data-focus-key="s${g.id}" value="${g.score ?? ''}" aria-label="Nota de ${g.name}" placeholder="—">`;
    const needCell = (leaf) => (leaf && leaf.required !== null
      ? html`<span class="need ${leaf.required > 10 ? 'is-bad' : ''}">${fmt(leaf.required)}</span>` : '');

    const viewRow = (g, depth) => {
      const leaf = leafById.get(g.id);
      const rest = childrenOf(g.id).length && g.score === null ? restOf(g) : null;
      return html`<tr class="${g.score !== null ? 'is-graded' : ''}">
        <td style="padding-left:${8 + depth * 18}px">${g.name}${g.min_grade !== null ? html` <span class="tag" title="Nota mínima para aprobar">≥ ${fmt(g.min_grade)}</span>` : ''}</td>
        <td class="num">${leaf ? pct(leaf.weight) : g.weight_pct !== null ? pct(g.weight_pct) : html`<span class="muted">—</span>`}</td>
        <td class="num">${scoreCell(g)}</td>
        <td class="num">${needCell(leaf)}</td>
      </tr>
      ${g.score === null ? childrenOf(g.id).map((c) => viewRow(c, depth + 1)) : ''}
      ${rest ? html`<tr class="is-implicit"><td style="padding-left:${8 + (depth + 1) * 18}px" title="Lo que no cubren las partes de ${g.name}">${rest.name}</td>
        <td class="num">${pct(rest.weight)}</td><td></td><td class="num">${needCell(rest)}</td></tr>` : ''}`;
    };

    const parentOptions = (g) => data.items.filter((o) => o.id !== g.id).map((o) => html`<option value="${o.id}" ${o.id === g.parent_id ? html`selected` : ''}>${o.name}</option>`);
    const editRow = (g, depth) => html`<tr data-gid="${g.id}">
      <td style="padding-left:${8 + depth * 18}px"><input class="input" data-field="name" data-focus-key="n${g.id}" value="${g.name}" maxlength="120" aria-label="Nombre"></td>
      <td class="num"><input class="input num-input" type="number" min="0" max="100" step="0.5" data-field="weight_pct" data-focus-key="w${g.id}" value="${g.weight_pct ?? ''}" aria-label="Peso de ${g.name}" placeholder="—"></td>
      <td><select class="input" data-field="parent_id" aria-label="Dentro de"><option value="">—</option>${parentOptions(g)}</select></td>
      <td class="num"><input class="input num-input" type="number" min="0" max="10" step="0.5" data-field="min_grade" data-focus-key="m${g.id}" value="${g.min_grade ?? ''}" aria-label="Mínimo de ${g.name}" placeholder="—"></td>
      <td class="acts"><button class="btn sm ghost icon" data-del="${g.id}" type="button" aria-label="Quitar ${g.name}">${icon('trash', 14)}</button></td>
    </tr>${childrenOf(g.id).map((c) => editRow(c, depth + 1))}`;

    const roots = data.items.filter((g) => g.parent_id === null || !ids.has(g.parent_id));

    mount(panel, html`
      <div class="toolbar" style="margin-top:0">
        <label class="small" for="g-target">Nota objetivo</label>
        <input class="input num-input" id="g-target" type="number" min="1" max="10" step="0.5" value="${target}" data-focus-key="target">
        <span class="spacer"></span>
        <button class="btn sm ${editing ? 'primary' : ''}" id="g-edit" type="button">${icon(editing ? 'check' : 'edit', 14)} ${editing ? 'Hecho' : 'Editar tabla'}</button>
      </div>

      <div class="grade-summary status-${p.status}">
        <p class="verdict">${verdict(p)}</p>
        ${p.status !== 'no-data' ? html`<dl class="grade-stats">
          <div><dt>Media en lo evaluado</dt><dd>${fmt(p.current)}</dd></div>
          <div><dt>Evaluado</dt><dd>${pct(p.gradedWeight)}</dd></div>
          <div><dt>Nota final posible</dt><dd>${fmt(p.floor)} – ${fmt(p.ceiling)}</dd></div>
        </dl>` : ''}
      </div>

      ${!p.weightsOk && p.status !== 'no-data' ? html`<div class="note-banner"><b>Los pesos suman ${pct(p.totalWeight)}.</b>
        La nota se calcula sobre ese total. Si un criterio es parte de otro (por ejemplo, las actividades del portafolio), indícalo en «Editar tabla» con «Dentro de».</div>` : ''}
      ${p.unweighted.length ? html`<p class="muted small">Sin peso, no cuentan: ${p.unweighted.join(', ')}.</p>` : ''}
      ${passRules ? html`<p class="muted small">Dicho en clase sobre el aprobado: «${passRules}». Los mínimos se marcan en «Editar tabla».</p>` : ''}

      ${editing ? html`
        <div class="table-scroll"><table class="db grade-table edit"><thead><tr><th>Criterio</th><th>Peso</th><th>Dentro de</th><th>Mínimo</th><th></th></tr></thead>
          <tbody>${roots.map((g) => editRow(g, 0))}</tbody></table></div>
        <form class="toolbar" id="g-add">
          <input class="input" id="g-new-name" placeholder="Nuevo criterio" maxlength="120" aria-label="Nombre del nuevo criterio" data-focus-key="new">
          <input class="input num-input" id="g-new-weight" type="number" min="0" max="100" step="0.5" placeholder="Peso %" aria-label="Peso del nuevo criterio">
          <button class="btn sm" type="submit">${icon('plus', 14)} Añadir</button>
        </form>
        <p class="muted small">El peso de una parte es sobre la nota de la asignatura (un foro del 3 % dentro de un proyecto del 50 %). Al editar la tabla pasa a ser tuya: la IA ya solo propondrá cambios en «Por revisar».</p>`
      : data.items.length ? html`
        <table class="db grade-table"><thead><tr><th>Criterio</th><th>Peso</th><th>Tu nota</th><th title="Lo que necesitas en cada criterio pendiente">Necesitas</th></tr></thead>
          <tbody>${roots.map((g) => viewRow(g, 0))}</tbody></table>
        <p class="muted small">Notas sobre 10. Una nota puesta en un criterio con partes vale por todo el criterio.</p>`
      : html`<div class="empty"><p>Sin criterios de evaluación. Se rellenan al generar con IA la clase de presentación, o añádelos tú en «Editar tabla».</p></div>`}
    `);

    if (focused) {
      const el = panel.querySelector(`[data-focus-key="${focused}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    }
  };

  const fail = (err) => { toast(err.message, 'err'); reload().catch(() => {}); };

  panel.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'g-target') {
      const v = Number(String(t.value).replace(',', '.'));
      if (!(v > 0 && v <= 10)) { t.value = target; return; }
      target = v;
      await api(`${url}/target`, { method: 'PUT', body: { target: v } }).then((d) => { data = d; draw(); }, fail);
    } else if (t.dataset.score) {
      await api(`/api/grades/${t.dataset.score}`, { method: 'PATCH', body: { score: t.value === '' ? null : t.value } }).then(reload, fail);
    } else if (t.dataset.field) {
      const id = t.closest('[data-gid]').dataset.gid;
      await api(`/api/grades/${id}`, { method: 'PATCH', body: { [t.dataset.field]: t.value === '' ? null : t.value } }).then(reload, fail);
    }
  });

  panel.addEventListener('click', async (e) => {
    if (e.target.closest('#g-edit')) { editing = !editing; draw(); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const g = data.items.find((x) => x.id === Number(del.dataset.del));
      const parts = data.items.filter((x) => x.parent_id === g.id).length;
      if (!(await confirmDialog(`Quitar «${g.name}»`, { confirm: 'Quitar', danger: true, detail: parts ? `También se quitan sus ${parts} partes.` : '' }))) return;
      await api(`/api/grades/${g.id}`, { method: 'DELETE' }).then(reload, fail);
    }
  });

  panel.addEventListener('submit', async (e) => {
    if (e.target.id !== 'g-add') return;
    e.preventDefault();
    const name = panel.querySelector('#g-new-name').value.trim();
    if (!name) { toast('Escribe el nombre del criterio', 'err'); return; }
    const weight = panel.querySelector('#g-new-weight').value;
    await api(`/api/courses/${encodeURIComponent(course)}/grades`, { method: 'POST', body: { name, weight_pct: weight === '' ? null : weight } })
      .then(async () => { await reload(); panel.querySelector('#g-new-name')?.focus(); }, fail);
  });

  draw();
}
