// Ajustes: IA, tema, calendario de la universidad, avisos del calendario, asignaturas (catálogo editable), copia de seguridad y rutas de datos.
import { api, html, mount, icon, toast, copyText, fmtDate, confirmDialog } from '../util.js';
import { state, setTheme, refreshMeta } from '../main.js';
import { enqueueJobs } from '../jobs.js';

export async function renderSettings(root) {
  const [sys, cat, prefs, lmsData, outdatedData, examData] = await Promise.all([
    api('/api/system'), api('/api/catalog'), api('/api/settings'), api('/api/lms-calendar'),
    api('/api/notes/outdated').catch(() => ({ ids: [] })),
    api('/api/exam-questions/outdated').catch(() => ({ ids: [] })),
  ]);
  const examOutdated = examData.ids;
  let lms = lmsData;
  const outdated = outdatedData.ids;
  const reminders = prefs.reminders;
  let courses = cat.courses.map((c) => ({ ...c }));
  const mb = (n) => (n / 1024 / 1024).toFixed(1);

  const draw = () => {
    mount(root, html`
      <h1 class="page-title">Ajustes</h1>
      <p class="page-sub">Todo lo que configuras aquí se guarda en tu base de datos local, no en el navegador.</p>

      <div class="setting"><div><h3>Apariencia</h3></div><div>
        <div class="seg-ctl" role="group" aria-label="Tema">${[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => html`<button type="button" data-theme="${k}" aria-pressed="${state.theme === k}">${l}</button>`)}</div></div></div>

      <div class="setting"><div><h3>Inteligencia artificial</h3><p>Apuntes, avisos, tarjetas y respuestas.</p></div><div>
        <p>${sys.ai ? html`<span class="tag tag-green">Activa</span> Modelo ${sys.model}.` : html`<span class="tag">Desactivada</span>`}</p>
        ${sys.ai ? '' : html`<p style="margin-top:6px">Añade tu clave en el archivo <code>.env</code> del proyecto y reinicia el servidor:</p>
          <div class="cmd" style="margin-top:6px"><code>GEMINI_API_KEY=tu_clave</code></div>`}
        <p style="margin-top:6px">Al usarla se envía texto (transcripciones y preguntas) a Google. El audio no sale de este equipo.</p></div></div>

      ${sys.ai ? html`<div class="setting"><div><h3>Apuntes por tramo</h3><p>Los apuntes nuevos se escriben tramo a tramo, con la plantilla de su destino (teoría, trabajo, examen).</p></div><div id="regen">
        ${outdated.length ? html`<p>${outdated.length === 1 ? 'Una clase tiene' : `${outdated.length} clases tienen`} apuntes escritos con una versión anterior.</p>
          <p class="muted small" style="margin-top:6px">Al regenerarlos solo se vuelven a escribir los apuntes: no se repite el análisis ni las tarjetas. Los que editaste a mano no se tocan y el texto anterior queda en el historial de versiones de cada clase. Se envían a Gemini las transcripciones de esas clases.</p>
          <div class="toolbar"><button class="btn sm primary" id="regen-notes" type="button">Regenerar apuntes (${outdated.length})</button></div>`
          : html`<p><span class="tag tag-green">Al día</span> Todos los apuntes están escritos con la versión actual.</p>`}
      </div></div>
      <div class="setting"><div><h3>Preguntas de examen</h3><p>El banco de la sección Exámenes se escribe con DeepSeek (y Gemini si falla) a partir de cada clase nueva.</p></div><div id="regen-exam">
        ${examOutdated.length ? html`<p>${examOutdated.length === 1 ? 'Una clase no tiene' : `${examOutdated.length} clases no tienen`} sus preguntas con la versión actual.</p>
          <p class="muted small" style="margin-top:6px">Solo se escriben las preguntas: no se repiten apuntes ni tarjetas. Las que destacaste o descartaste se conservan.</p>
          <div class="toolbar"><button class="btn sm primary" id="gen-exam" type="button">Generar preguntas (${examOutdated.length})</button></div>`
          : html`<p><span class="tag tag-green">Al día</span> Todas las clases tienen sus preguntas.</p>`}
      </div></div>` : ''}

      <div class="setting"><div><h3>Calendario de la universidad</h3><p>Horario de clases, entregas y exámenes oficiales del campus. Se sincroniza al arrancar y cada 6 horas.</p></div><div id="lms">
        ${lms.configured ? html`
          <p>${lms.error ? html`<span class="tag tag-red">Error</span> ${lms.error.replace(/^\S+ /, '')}` : lms.last_sync ? html`<span class="tag tag-green">Conectado</span> ${lms.host}` : html`<span class="tag">Pendiente</span> ${lms.host}`}</p>
          ${lms.last_sync ? html`<p class="muted small" style="margin-top:6px">Última sincronización: ${fmtDate(lms.last_sync, true)}${lms.result ? ` · ${lms.result.total} eventos: ${lms.result.added} nuevos, ${lms.result.updated} cambiados, ${lms.result.matched} confirmados de los que oyó la IA, ${lms.result.removed} quitados` : ''}.</p>` : ''}
          ${lms.result?.held ? html`<p class="small" style="margin-top:8px"><span class="tag tag-red">Sin borrar</span> El calendario ya no trae ${lms.result.held === 1 ? 'un evento' : `${lms.result.held} eventos`} que tenías, y son demasiados para fiarse: puede ser una respuesta incompleta del campus. Se han conservado.</p>
            <div class="toolbar"><button class="btn sm" id="lms-force" type="button">Quitarlos igualmente</button></div>` : ''}
          <div class="toolbar"><button class="btn sm" id="lms-sync" type="button">Sincronizar ahora</button></div>
          ${lms.unknown_courses.length ? html`<p class="small" style="margin-top:8px">El calendario trae asignaturas que no están en tu catálogo:</p>
            <ul class="muted small" style="margin:4px 0 6px 1.2em">${lms.unknown_courses.map((c) => html`<li><b>${c.code}</b> ${c.name}</li>`)}</ul>
            <button class="btn sm" id="lms-add-courses" type="button">${icon('plus', 14)} Añadirlas al catálogo</button>` : ''}`
        : html`<p>Sin configurar. Copia la dirección del calendario del campus (en la VIU: Calendario › exportar) en el archivo <code>.env</code> y reinicia el servidor:</p>
          <div class="cmd" style="margin-top:6px"><code>LMS_CALENDAR_URL=https://…</code></div>
          <p class="muted small" style="margin-top:6px">La dirección lleva un token personal: no la compartas ni la subas a GitHub.</p>`}
      </div></div>

      <div class="setting"><div><h3>Avisos del calendario</h3><p>Días antes de cada fecha en que tu calendario te avisa, separados por comas. Los avisos de un día sin hora llegan a las 9:00. Vacío, sin avisos.</p></div><div>
        <form class="stack" id="reminders">
          ${[['exam', 'Exámenes'], ['deadline', 'Entregas'], ['other', 'Prácticas y otros']].map(([k, label]) => html`<div class="field"><label for="rem-${k}">${label}</label>
            <input class="input" id="rem-${k}" data-rem="${k}" value="${reminders[k].join(', ')}" placeholder="Sin avisos" maxlength="40" style="width:160px"></div>`)}
          <div class="toolbar"><button class="btn primary sm" type="submit">Guardar avisos</button></div>
        </form>
        <p class="muted small" style="margin-top:6px">Se aplican al archivo .ics y a la suscripción del Calendario. Las sesiones de clase no avisan.</p></div></div>

      <div class="setting"><div><h3>Asignaturas</h3><p>Se usan para ordenar las clases y reconocer el código en los títulos. Se guardan en data/courses.json.</p></div><div>
        <table class="db catalog"><thead><tr><th>Código</th><th>Nombre</th><th class="hide-sm">Profesor</th><th class="hide-sm">Id Blackboard</th><th></th></tr></thead><tbody>
          ${courses.map((c, i) => html`<tr data-i="${i}">
            <td><input class="input" data-f="code" value="${c.code}" aria-label="Código"></td>
            <td><input class="input" data-f="name" value="${c.name}" aria-label="Nombre"></td>
            <td class="hide-sm"><input class="input" data-f="teacher" value="${c.teacher || ''}" aria-label="Profesor"></td>
            <td class="hide-sm"><input class="input" data-f="lmsId" value="${c.lmsId || ''}" aria-label="Id Blackboard"></td>
            <td class="acts"><button class="btn sm ghost icon" data-rm type="button" aria-label="Quitar asignatura">${icon('trash', 14)}</button></td></tr>`)}</tbody></table>
        <div class="toolbar"><button class="btn sm" id="add-course" type="button">${icon('plus', 14)} Añadir asignatura</button><span class="spacer"></span>
          <button class="btn primary sm" id="save-courses" type="button">Guardar asignaturas</button></div></div></div>

      <div class="setting"><div><h3>Copia de seguridad</h3><p>Copia consistente de la base de datos (apuntes editados, confirmaciones, repasos). Se hace una al día mientras el servidor está abierto y otra antes de cada actualización de la base de datos.</p></div><div>
        <button class="btn" id="backup" type="button">Crear copia ahora</button>
        ${sys.backups.length ? html`<ul style="margin:10px 0 0 1.2em" class="muted small">${sys.backups.map((b) => html`<li>${b}</li>`)}</ul>` : html`<p class="muted small" style="margin-top:8px">Aún no hay copias.</p>`}
        <p class="muted small" style="margin-top:8px">Carpeta: <code>${sys.backupDir}</code>. Para guardarlas en otro disco o en la nube, pon <code>BACKUP_DIR</code> en el archivo <code>.env</code>.</p>
        <p class="muted small" style="margin-top:4px">El audio y las transcripciones están en la carpeta data; cópiala entera para una copia completa. Lo que borras de una clase va a <code>data/trash</code> durante ${sys.trashDays} días.</p></div></div>

      <div class="setting"><div><h3>Datos</h3></div><dl class="kv">
        <dt>Carpeta de datos</dt><dd>${sys.dataDir}</dd><dt>Base de datos</dt><dd>${sys.dbPath} (${mb(sys.dbBytes)} MB)</dd>
        <dt>Clases</dt><dd>${sys.stats.total} registradas, ${sys.stats.transcribed} transcritas, ${sys.stats.withNotes} con apuntes</dd>
        <dt>Importar</dt><dd><div class="cmd"><code>npm run ingest</code><button class="btn sm" data-copy="npm run ingest" type="button">${icon('copy', 14)}</button></div></dd></dl></div>
    `);

    root.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', async () => { await setTheme(b.dataset.theme); draw(); }));
    root.querySelector('#regen-notes')?.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Regenerar apuntes', { confirm: 'Regenerar', detail: `Se escribirán de nuevo los apuntes de ${outdated.length} ${outdated.length === 1 ? 'clase' : 'clases'} en segundo plano.` }))) return;
      e.currentTarget.disabled = true;
      try { await enqueueJobs(outdated, { steps: ['notes', 'embeddings'] }); }
      catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
    });
    root.querySelector('#gen-exam')?.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Generar preguntas de examen', { confirm: 'Generar', detail: `Se escribirán las preguntas de ${examOutdated.length} ${examOutdated.length === 1 ? 'clase' : 'clases'} en segundo plano (una llamada por clase).` }))) return;
      e.currentTarget.disabled = true;
      try { await enqueueJobs(examOutdated, { steps: ['exam'] }); }
      catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
    });
    root.querySelector('#lms-sync')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Sincronizando';
      try {
        lms = await api('/api/lms-calendar/sync', { method: 'POST', body: {} });
        toast(`Calendario sincronizado: ${lms.result.added} nuevos, ${lms.result.updated} cambiados`);
      } catch (err) {
        toast(err.message, 'err', 8000);
        lms = await api('/api/lms-calendar').catch(() => lms);
      }
      draw();
    });
    root.querySelector('#lms-force')?.addEventListener('click', async (e) => {
      if (!(await confirmDialog('Quitar eventos que ya no están', { confirm: 'Quitarlos', detail: `Se borrarán ${lms.result.held} eventos futuros que vinieron de la universidad y ya no aparecen en su calendario.` }))) return;
      e.currentTarget.disabled = true;
      try {
        lms = await api('/api/lms-calendar/sync', { method: 'POST', body: { force: true } });
        toast(`${lms.result.removed} eventos quitados`);
      } catch (err) { toast(err.message, 'err', 8000); }
      draw();
    });
    root.querySelector('#lms-add-courses')?.addEventListener('click', async () => {
      try {
        const res = await api('/api/catalog', { method: 'PUT', body: { courses: [...courses, ...lms.unknown_courses].map((c) => ({ code: c.code, name: c.name, teacher: c.teacher || undefined, lmsId: c.lmsId || undefined })) } });
        courses = res.courses.map((c) => ({ ...c }));
        lms = await api('/api/lms-calendar');
        toast('Asignaturas añadidas');
        await refreshMeta(); draw();
      } catch (err) { toast(err.message, 'err'); }
    });
    root.querySelector('#reminders').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries([...root.querySelectorAll('[data-rem]')].map((i) => [`reminders_${i.dataset.rem}`, i.value]));
      try {
        await api('/api/settings', { method: 'PUT', body });
        Object.assign(reminders, (await api('/api/settings')).reminders);
        toast('Avisos guardados');
        draw();
      } catch (err) { toast(err.message, 'err'); }
    });
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => toast((await copyText(b.dataset.copy)) ? 'Copiado' : 'No se pudo copiar')));
    const sync = () => root.querySelectorAll('tr[data-i]').forEach((tr) => tr.querySelectorAll('[data-f]').forEach((inp) => { courses[Number(tr.dataset.i)][inp.dataset.f] = inp.value; }));
    root.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { sync(); courses.splice(Number(b.closest('tr').dataset.i), 1); draw(); }));
    root.querySelector('#add-course').addEventListener('click', () => { sync(); courses.push({ code: '', name: '' }); draw(); root.querySelector('tr:last-child input')?.focus(); });
    root.querySelector('#save-courses').addEventListener('click', async () => {
      sync();
      try {
        const res = await api('/api/catalog', { method: 'PUT', body: { courses: courses.map((c) => ({ code: c.code, name: c.name, teacher: c.teacher || undefined, lmsId: c.lmsId || undefined })) } });
        courses = res.courses.map((c) => ({ ...c }));
        toast('Asignaturas guardadas');
        await refreshMeta(); draw();
      } catch (err) { toast(err.message, 'err'); }
    });
    root.querySelector('#backup').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api('/api/backup', { method: 'POST', body: {} }); toast(`Copia creada (${mb(r.bytes)} MB)`); renderSettings(root); }
      catch (err) { toast(err.message, 'err'); e.currentTarget.disabled = false; }
    });
  };
  draw();
}
