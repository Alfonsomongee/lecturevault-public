import { test, expect, type Page } from '@playwright/test';
import { DashboardServer, type DashboardConfig } from '../../src/dashboard/DashboardServer.js';
import { PROGRESS_PREFIX } from '../../src/capture/progress.js';
import type { LiveCaptureOptions } from '../../src/capture/CaptureRunner.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { StudyRepository } from '../../src/database/StudyRepository.js';
import { seedDemo } from '../../src/demo/seed.js';
import pino from 'pino';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const logger = pino({ level: 'silent' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-e2e-'));

interface Fixture { server: DashboardServer; db: DatabaseManager; url: string; dataDir: string; dbPath: string }
const fixtures: Fixture[] = [];

// "Grabar y transcribir" never opens a real browser here: the capture is a small script that reports like the real one
const CAPTURE_OK = `for (const id of ids) { ev({type:'stage',id,stage:'recording'}); await sleep(500); ev({type:'progress',id,percent:50,position:5,duration:10}); await sleep(800); ev({type:'stage',id,stage:'done'}); }`;
const CAPTURE_FAILS = `for (const id of ids) { ev({type:'stage',id,stage:'failed',error:'No se detectó elemento de audio/vídeo tras 30 segundos de espera.'}); }`;
let captureScript = CAPTURE_OK;
const fakeCapture: DashboardConfig['captureCommand'] = (ids) => ({
  cmd: process.execPath,
  args: ['-e', `const ev=(o)=>process.stdout.write('\\n'+${JSON.stringify(PROGRESS_PREFIX)}+JSON.stringify(o)+'\\n');const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));const ids=process.argv.slice(1).map(Number);(async()=>{${captureScript}})();`, ...ids.map(String)],
  cwd: process.cwd(),
});

// The "+" button: a live capture waits for the student's ENTER (here, a line on stdin) to start and again to stop
const liveLaunched: LiveCaptureOptions[] = [];
const fakeLive: DashboardConfig['liveCaptureCommand'] = (options) => {
  liveLaunched.push(options);
  const ev = `const ev=(o)=>process.stdout.write('\\n'+${JSON.stringify(PROGRESS_PREFIX)}+JSON.stringify(o)+'\\n');`;
  return {
    cmd: process.execPath,
    args: ['-e', `${ev}let n=0;ev({type:'stage',id:0,stage:'opening'});setTimeout(()=>ev({type:'stage',id:0,stage:'waiting'}),300);process.stdin.on('data',()=>{n++;if(n===1){ev({type:'stage',id:0,stage:'recording'});ev({type:'progress',id:0,percent:40,position:4,duration:10});}else{ev({type:'stage',id:0,stage:'done'});process.exit(0);}});`],
    cwd: process.cwd(),
  };
};

async function boot(dbPath: string, dataDir: string, extra: Partial<DashboardConfig> = {}): Promise<Fixture> {
  const db = new DatabaseManager(dbPath, logger);
  const server = new DashboardServer(db, { port: 0, dataDir, ...extra }, logger);
  await server.start();
  const fx = { server, db, url: `http://127.0.0.1:${server.getPort()}`, dataDir, dbPath };
  fixtures.push(fx);
  return fx;
}

const audioTime = (page: Page) => page.evaluate(() => (document.querySelector('audio') as HTMLAudioElement).currentTime);
const audioReady = (page: Page) => page.waitForFunction(() => ((document.querySelector('audio') as HTMLAudioElement | null)?.readyState ?? 0) >= 1);

let demo: Fixture;
let empty: Fixture;
let mallado: number;
let materiales: number;

test.beforeAll(async () => {
  const seeded = seedDemo(path.join(tmp, 'demo'), logger);
  demo = await boot(seeded.dbPath, seeded.dataDir, { captureCommand: fakeCapture, liveCaptureCommand: fakeLive });
  mallado = demo.db.getRecordingByTranscriptId('simulacion_clase2_mallado')!.id;
  materiales = demo.db.getRecordingByTranscriptId('materiales_clase1_traccion')!.id;
  empty = await boot(path.join(tmp, 'empty.db'), path.join(tmp, 'empty-data'));
});

test.afterAll(async () => {
  for (const f of fixtures) { await f.server.stop(); f.db.close(); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test.describe('Estilo', () => {
  test('la interfaz no contiene emojis', async ({ page }) => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FF}\u{2B50}]/u;
    for (const route of ['/', '/#/classes', '/#/calendar', '/#/inbox', '/#/c/Simulaci%C3%B3n%20FEM', '/#/study', '/#/exams', '/#/exams/Simulaci%C3%B3n%20FEM', '/#/ask', '/#/settings', `/#/r/${mallado}`, `/#/r/${mallado}?tab=alerts`, `/#/r/${mallado}?tab=cards`]) {
      await page.goto(demo.url + route);
      await page.waitForTimeout(250);
      expect(emoji.test(await page.locator('body').innerText()), route).toBe(false);
    }
  });
});

test.describe('Gráficas y diagramas en los apuntes', () => {
  const NOTES = [
    '# Tracción', '', '## Ensayo [00:10]', 'La ley de Hooke es $\\sigma = E \\varepsilon$.', '',
    '```plot', '{"title":"Curva elástica","xLabel":"deformación","yLabel":"tensión","xMin":0,"xMax":10,"curves":[{"expr":"2*x","label":"Hooke"}]}', '```', '',
    '```chart', '{"type":"bar","title":"Módulos","unit":"GPa","labels":["Acero","Aluminio"],"series":[{"name":"E","values":[210,70]}]}', '```', '',
    '```flow', '{"nodes":[{"id":"a","label":"Probeta","kind":"start"},{"id":"b","label":"Ensayo"},{"id":"c","label":"Informe","kind":"end"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}', '```', '',
    '```plot', '{"xMin":0,"xMax":1,"curves":[{"expr":"alert(1)"}]}', '```',
  ].join('\n');

  test('se dibujan como SVG, el cursor lee valores y un bloque inválido no ejecuta nada', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => { errors.push(`diálogo: ${d.message()}`); await d.dismiss(); });
    // The demo is shared with the tests below, which expect this class to have no notes: leave it as it was found
    new StudyRepository(demo.db.handle).saveNotes(materiales, NOTES, 'manual', 'manual');
    try {
      await checkFigures(page, errors);
    } finally {
      demo.db.handle.prepare('DELETE FROM notes WHERE recording_id = ?').run(materiales);
    }
  });

  async function checkFigures(page: Page, errors: string[]): Promise<void> {
    await page.goto(`${demo.url}/#/r/${materiales}?tab=notes`);
    await expect(page.locator('figure.dg')).toHaveCount(3);
    await expect(page.locator('figure.dg-plot svg path.dg-line')).toHaveCount(1);
    await expect(page.locator('figure.dg-chart svg .dg-bar')).toHaveCount(2);
    await expect(page.locator('figure.dg-flow svg .dg-node')).toHaveCount(3);
    await expect(page.locator('.dg-error')).toContainText('«alert» no se reconoce');
    await expect(page.locator('.katex').first()).toBeVisible(); // formulas still render next to the figures

    await page.locator('figure.dg-plot .dg-hit').hover({ position: { x: 200, y: 80 } });
    await expect(page.locator('figure.dg-plot .dg-readout')).toContainText('x = ');
    expect(errors).toEqual([]);
  }
});

test.describe('Biblioteca vacía', () => {
  test('muestra estado vacío y la API responde', async ({ page, request }) => {
    await page.goto(empty.url);
    await expect(page).toHaveTitle('LectureVault');
    await expect(page.locator('.empty')).toBeVisible();
    expect((await (await request.get(`${empty.url}/api/health`)).json()).status).toBe('ok');
    expect((await (await request.get(`${empty.url}/api/recordings`)).json()).recordings).toEqual([]);
  });
});

test.describe('Clases', () => {
  test('agrupa por asignatura y lista lo pendiente con el comando exacto', async ({ page }) => {
    await page.goto(`${demo.url}/#/classes`);
    await expect(page.locator('h2.section', { hasText: 'Simulación FEM' })).toBeVisible();
    await expect(page.locator('table.classes')).toHaveCount(3);
    const pending = page.locator('table.pending tbody tr');
    await expect(pending).toHaveCount(2);
    const cmd = await pending.first().locator('[data-copy]').getAttribute('data-copy');
    expect(cmd).toMatch(/^npm run capture:and:transcribe -- .*--date \d{4}-\d{2}-\d{2} --name demo-collab-/);
    await pending.first().locator('[data-copy]').click();
    await expect(page.locator('.toast')).toContainText(/Comando copiado|No se pudo copiar/);
  });

  test('el + de la esquina pide la asignatura, abre el campus y se sigue hasta guardar la clase', async ({ page }) => {
    liveLaunched.length = 0;
    await page.goto(`${demo.url}/#/classes`);
    const fab = page.getByRole('button', { name: 'Grabar y transcribir una clase' });
    await expect(fab).toBeVisible();
    // top right corner of the window
    const [box, viewport] = [await fab.boundingBox(), page.viewportSize()!];
    expect(box!.y).toBeLessThan(40);
    expect(viewport.width - (box!.x + box!.width)).toBeLessThan(40);

    await fab.click();
    const dlg = page.locator('dialog.modal');
    await expect(dlg).toBeVisible();
    // the subject is required: without one nothing starts
    await dlg.getByRole('button', { name: 'Abrir el campus' }).click();
    await expect(dlg).toBeVisible();
    expect(liveLaunched).toHaveLength(0);

    await dlg.locator('#live-course').selectOption('Simulación FEM');
    await dlg.locator('#live-date').fill('2026-10-12');
    await dlg.locator('#live-speed').selectOption('1');
    await dlg.getByRole('button', { name: 'Abrir el campus' }).click();

    const side = page.locator('#side-capture');
    await expect(side).toContainText('Esperando a que abras la clase');
    expect(liveLaunched).toEqual([{ course: 'Simulación FEM', date: '2026-10-12', speed: 1 }]);
    // while it runs, a second one cannot start
    await fab.click();
    await expect(page.locator('.toast').last()).toContainText('Ya hay una captura en marcha');

    await side.getByRole('button', { name: 'Empezar a grabar' }).click();
    await expect(side).toContainText('Grabando 40%');
    const stop = side.getByRole('button', { name: 'Parar y guardar' });
    await expect(stop).toBeVisible();
    // stopping asks first: it takes the place of "Empezar" and a stray click would cut the class
    await stop.click();
    const confirm = page.locator('dialog.modal', { hasText: 'Parar la grabación' });
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(side).toContainText('Grabando 40%');
    await stop.click();
    await confirm.getByRole('button', { name: 'Parar y guardar' }).click();
    await expect(side).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.toast').filter({ hasText: 'grabada y transcrita' })).toBeVisible();
  });

  test('si el filtro de asignatura oculta pendientes de otras, lo dice y se puede quitar', async ({ page }) => {
    await page.goto(`${demo.url}/#/classes`);
    await page.locator('#lib-course').selectOption('Simulación FEM');
    await expect(page.locator('table.pending:not(.ignored) tbody tr')).toHaveCount(1);
    const note = page.locator('[data-pending-elsewhere]');
    await expect(note).toContainText('Hay 1 clase pendiente de capturar en otras asignaturas');
    await note.getByRole('button', { name: 'Ver todas las asignaturas' }).click();
    await expect(page.locator('table.pending:not(.ignored) tbody tr')).toHaveCount(2);
    await expect(note).toHaveCount(0);
  });

  test('«Grabar y transcribir» graba una pendiente, se sigue en la barra lateral y avisa al terminar', async ({ page }) => {
    captureScript = CAPTURE_OK;
    await page.goto(`${demo.url}/#/classes`);
    const row = page.locator('table.pending:not(.ignored) tbody tr').first();
    await row.getByRole('button', { name: 'Grabar y transcribir' }).click();

    const side = page.locator('#side-capture');
    await expect(side).toBeVisible();
    await expect(side).toContainText('Grabando y transcribiendo');
    await expect(side.getByRole('button', { name: 'Cancelar captura' })).toBeVisible();
    // one capture at a time: the other buttons are off while it runs
    await expect(page.locator('[data-capture-all]')).toBeDisabled();

    await expect(side).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.toast').first()).toContainText('grabada y transcrita');
    await expect(page.locator('[data-capture-all]')).toBeEnabled();
  });

  test('si la captura falla se explica por qué y se puede cerrar el aviso', async ({ page }) => {
    captureScript = CAPTURE_FAILS;
    await page.goto(`${demo.url}/#/classes`);
    await page.locator('table.pending:not(.ignored) tbody tr').first().getByRole('button', { name: 'Grabar y transcribir' }).click();

    const result = page.locator('.capture-result');
    await expect(result).toBeVisible({ timeout: 15_000 });
    await expect(result).toContainText('0 de 1');
    await expect(result).toContainText('No se detectó elemento de audio/vídeo');
    await result.getByRole('button', { name: 'Cerrar' }).click();
    await expect(result).toHaveCount(0);
    captureScript = CAPTURE_OK;
  });

  test('una clase pendiente se puede ignorar y recuperar', async ({ page }) => {
    await page.goto(`${demo.url}/#/classes`);
    const pending = page.locator('table.pending:not(.ignored) tbody tr');
    await expect(pending).toHaveCount(2);
    const title = await pending.first().locator('td.name').innerText();
    await pending.first().getByRole('button', { name: 'Ignorar' }).click();
    await expect(pending).toHaveCount(1);
    await page.reload();
    await expect(pending).toHaveCount(1);
    await page.locator('#show-ignored').click();
    await page.locator('table.ignored tr', { hasText: title }).getByRole('button', { name: 'Recuperar' }).click();
    await expect(pending).toHaveCount(2);
  });

  test('filtra por nombre y por asignatura, y recuerda la asignatura tras recargar', async ({ page }) => {
    await page.goto(`${demo.url}/#/classes`);
    await page.locator('#filter').fill('mallado');
    await expect(page.locator('table.classes tbody tr')).toHaveCount(1);
    await page.locator('#filter').fill('');
    await page.locator('#lib-course').selectOption('Estructuras');
    await expect(page.locator('table.classes')).toHaveCount(1);
    await page.reload(); // la asignatura elegida está en la base de datos, no en el navegador
    await expect(page.locator('table.classes')).toHaveCount(1);
    await page.locator('#lib-course').selectOption('');
    await expect(page.locator('table.classes')).toHaveCount(3);
  });

  test('mueve clases en lote a una asignatura del catálogo con solo el número', async ({ page }) => {
    fs.copyFileSync(path.resolve('courses.example.json'), path.join(demo.dataDir, 'courses.json'));
    await page.goto(`${demo.url}/#/classes`);
    await expect(page.locator('#side-courses a', { hasText: '07MUIN' })).toBeVisible();
    await page.locator('tr', { hasText: 'Ensayo de tracción' }).locator('[data-sel]').check();
    await expect(page.locator('#bulk')).toBeVisible();
    await page.locator('#bulk-course').fill('07');
    await page.locator('#bulk-go').click();
    await expect(page.locator('h2.section', { hasText: '07MUIN' })).toBeVisible();
    demo.db.handle.prepare("UPDATE recordings SET course = 'Materiales' WHERE id = ?").run(materiales);
    fs.rmSync(path.join(demo.dataDir, 'courses.json'));
  });
});

test.describe('Clase', () => {
  test('los apuntes muestran fórmulas y cada [mm:ss] mueve el audio', async ({ page }) => {
    const { notes } = await (await page.request.get(`${demo.url}/api/recordings/${mallado}`)).json();
    // A run of marks ("[01:09] [01:20]") is shown as its first one
    const stamp = String.raw`\[\d{1,2}:\d{2}(?::\d{2})?\]`;
    const runs = notes.markdown.replace(new RegExp(`(${stamp})(?:[ \\t]*${stamp})+`, 'g'), '$1');
    const expected = (runs.match(new RegExp(stamp, 'g')) ?? []).length;
    await page.goto(`${demo.url}/#/r/${mallado}?tab=notes`);
    await expect(page.locator('.prose h1')).toContainText('Mallado');
    await expect(page.locator('.prose .katex').first()).toBeVisible();
    await expect(page.locator('.prose button.ts')).toHaveCount(expected);
    // > [!EXAM] becomes a callout box with its title, and its [mm:ss] still plays
    const callout = page.locator('.prose .callout-exam');
    await expect(callout.locator('.callout-title')).toHaveText('Entra en examen');
    await expect(callout).toContainText('convergencia de malla');
    await expect(callout).not.toContainText('[!EXAM]');
    await expect(callout.locator('button.ts')).toHaveCount(1);
    await audioReady(page);
    await page.locator('.prose button.ts', { hasText: '01:09' }).first().click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(68);
  });

  test('transcripción sincronizada y deep link ?t=', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=80&tab=transcript`);
    await audioReady(page);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(79);
    await expect(page.locator('.seg.is-current')).toBeVisible();
    await page.locator('.seg', { hasText: 'Después aplicamos la carga' }).click();
    await expect.poll(() => audioTime(page)).toBeGreaterThan(91);
  });

  test('edita los apuntes: se guardan, quedan en el historial y se pueden restaurar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=notes`);
    await page.locator('#edit').click();
    const original = await page.locator('#editor').inputValue();
    await page.locator('#editor').fill(`${original}\n\n## Mi anexo\n\nTexto escrito por mí sobre tolerancias [00:30]`);
    await page.keyboard.press('Control+s');
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toBeVisible();
    await page.locator('#ver').click();
    await page.locator('#ver-pop [data-v]').first().click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('.prose h2', { hasText: 'Mi anexo' })).toHaveCount(0);
  });

  test('avisos: confirmar, crear a mano y borrar; marcadores en la línea de tiempo', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=alerts`);
    await expect(page.locator('#panel .item').first()).toBeVisible();
    const before = await page.locator('#panel .item').count();
    await page.locator('#panel .item').first().getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.locator('#panel .item .tag-green').first()).toBeVisible();

    await page.locator('#new-alert').click();
    await page.locator('#na-text').fill('Entregar el informe de tolerancias');
    await page.locator('#na-date').fill('2026-12-01');
    await page.locator('#alert-new button[type="submit"]').click();
    await expect(page.locator('#panel .item')).toHaveCount(before + 1);
    await page.locator('#panel .item', { hasText: 'informe de tolerancias' }).getByRole('button', { name: 'Borrar aviso' }).click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('#panel .item')).toHaveCount(before);
    await expect(page.locator('.marker').first()).toBeVisible();
  });

  test('tarjetas: crear, editar y eliminar a mano', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=cards`);
    await page.locator('#new-card').click();
    await page.locator('#cf-front').fill('¿Qué es una tolerancia?');
    await page.locator('#cf-back').fill('Desviación admisible de una cota');
    await page.locator('#card-edit button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'tolerancia' })).toBeVisible();
    await page.locator('#panel .item', { hasText: 'tolerancia' }).getByRole('button', { name: 'Editar' }).click();
    await page.locator('#cf-back').fill('Variación permitida de una medida');
    await page.locator('#card-edit button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'Variación permitida' })).toBeVisible();
    await page.locator('#panel .item', { hasText: 'tolerancia' }).getByRole('button', { name: 'Eliminar' }).click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('#panel .item', { hasText: 'tolerancia' })).toHaveCount(0);
  });

  test('marcas propias y título editable se conservan al recargar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=42&tab=markers`);
    await audioReady(page);
    await page.locator('#marker-text').fill('Repasar el criterio de convergencia');
    await page.locator('#marker-form button[type="submit"]').click();
    await expect(page.locator('#panel .item', { hasText: 'criterio de convergencia' })).toBeVisible();
    await page.locator('#title-input').fill('Clase 2 · Mallado (revisada)');
    await page.locator('#title-input').press('Enter');
    await expect(page.locator('.toast', { hasText: 'Guardado' }).first()).toBeVisible();
    await page.reload();
    await expect(page.locator('#title-input')).toHaveValue('Clase 2 · Mallado (revisada)');
    await expect(page.locator('#panel .item', { hasText: 'criterio de convergencia' })).toBeVisible();
  });

  test('la posición de reproducción se guarda en el servidor', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?t=100`);
    await audioReady(page);
    await page.locator('#play').click();
    await page.waitForTimeout(300);
    await page.locator('#play').click();
    await expect.poll(async () => (await (await page.request.get(`${demo.url}/api/recordings/${mallado}`)).json()).position).toBeGreaterThanOrEqual(100);
  });

  test('una clase sin audio ni apuntes lo explica y deja escribir apuntes', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.no-audio')).toBeVisible();
    await expect(page.locator('#panel')).toContainText('aún no tiene apuntes');
    await page.locator('#write').click();
    await page.locator('#editor').fill('# Mis apuntes\n\nEnsayo de tracción [00:10]');
    await page.locator('#save-notes').click();
    await expect(page.locator('.prose h1')).toContainText('Mis apuntes');
  });

  test('el Markdown malicioso se sanea', async ({ page }) => {
    new StudyRepository(demo.db.handle).saveNotes(materiales, [
      '# Notas', '<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=2</script>',
      '[click](javascript:window.__pwned=3)', '<iframe src="https://evil.example"></iframe>', 'Texto seguro [00:05]',
    ].join('\n\n'), 'test', '2');
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.prose')).toContainText('Texto seguro');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.locator('.prose iframe, .prose script, .prose a[href^="javascript"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test('eliminar una clase local la quita de la lista', async ({ page }) => {
    const rec = demo.db.createLocalRecording({ transcriptId: 'para_borrar', title: 'Clase de prueba', createdAt: new Date().toISOString(), durationSeconds: 60 });
    new StudyRepository(demo.db.handle).replaceSegments(rec.id, [{ start: 0, end: 5, text: 'hola' }]);
    await page.goto(`${demo.url}/#/r/${rec.id}`);
    await page.locator('#del-files').click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('table.classes', { hasText: 'Clase de prueba' })).toHaveCount(0);
  });
});

test.describe('Búsqueda, agenda, repaso, preguntar, ajustes', () => {
  test('la búsqueda tolera acentos y errores y salta al minuto', async ({ page }) => {
    await page.goto(demo.url);
    await page.locator('#global-search').fill('construccion');
    await page.waitForURL(/#\/search\?q=construccion/);
    await page.locator('#global-search').fill('ansis');
    await expect(page.locator('.note-banner')).toContainText('ansys');
    await page.locator('.hit', { hasText: 'restricciones' }).first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=\d+/);
  });

  test('"/" enfoca la búsqueda desde cualquier pantalla', async ({ page }) => {
    await page.goto(`${demo.url}/#/calendar`);
    await page.keyboard.press('/');
    await expect(page.locator('#global-search')).toBeFocused();
  });

  test('la antigua Agenda lleva al Calendario', async ({ page }) => {
    await page.goto(`${demo.url}/#/agenda`);
    await expect(page).toHaveURL(/#\/calendar$/);
    await expect(page.locator('h1.page-title')).toHaveText('Calendario');
  });

  test('avisos de una clase: alta manual y exportación .ics', async ({ page, request }) => {
    await page.goto(`${demo.url}/#/r/${materiales}?tab=alerts`);
    await page.locator('#new-alert').click();
    await page.locator('#na-text').fill('Examen parcial de simulación');
    await page.locator('#na-date').fill('2026-11-20');
    await page.locator('#alert-new button[type="submit"]').click();
    await expect(page.locator('.item', { hasText: 'Examen parcial de simulación' })).toBeVisible();
    const ics = await (await request.get(`${demo.url}/api/calendar.ics?confirmed=1`)).text();
    expect(ics).toContain('SUMMARY:Examen: Examen parcial de simulación');
  });

  test('los avisos descartados sobreviven a recargar y se pueden restaurar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}?tab=alerts`);
    const first = page.locator('.item:not(.is-done)').first();
    const text = await first.locator('.txt').innerText();
    await first.getByRole('button', { name: 'Descartar' }).click();
    await expect(page.locator('.item.is-done', { hasText: text })).toBeVisible();
    await page.reload();
    const dismissed = page.locator('.item.is-done', { hasText: text });
    await expect(dismissed).toBeVisible();
    await dismissed.getByRole('button', { name: 'Restaurar' }).click();
    await expect(page.locator('.item.is-done', { hasText: text })).toHaveCount(0);
  });

  test('repaso con atajos de teclado y sin acumular manejadores', async ({ page }) => {
    await page.goto(`${demo.url}/#/study`);
    await expect(page.locator('.review')).toBeVisible();
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Practicar todas');
    await page.locator('#mode').click();
    await expect(page.locator('#mode')).toContainText('Volver al repaso');
    await expect(page.locator('.review')).toContainText('1 de');
    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await expect(page.locator('.review')).toContainText('2 de');
    await expect(page.locator('.review')).toContainText('1 bien');
    await page.locator('[data-sec="all"]').click();
    await expect(page.locator('table.db tbody tr').first()).toBeVisible();
  });

  test('preguntar funciona sin clave de IA mostrando fragmentos con enlace', async ({ page }) => {
    await page.goto(`${demo.url}/#/ask`);
    await page.locator('#ask-input').fill('¿Qué peso tiene la práctica de CYPE?');
    await page.locator('#ask-form button[type="submit"]').click();
    await expect(page.locator('.a-msg .cite').first()).toContainText('CYPE');
    await page.locator('.a-msg .cite').first().click();
    await expect(page).toHaveURL(/#\/r\/\d+\?t=/);
  });

  test('ajustes: el tema vive en el servidor, copia de seguridad y catálogo editable', async ({ page, browser }) => {
    await page.goto(`${demo.url}/#/settings`);
    await page.locator('[data-theme="dark"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const fresh = await (await browser.newContext()).newPage(); // otro navegador: sin localStorage compartido
    await fresh.goto(demo.url);
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
    await fresh.context().close();
    await page.locator('[data-theme="light"]').click();

    await page.locator('#backup').click();
    await expect(page.locator('.toast', { hasText: 'Copia creada' })).toBeVisible();

    await page.locator('#add-course').click();
    const row = page.locator('table.catalog tbody tr').last();
    await row.locator('[data-f="code"]').fill('99TST');
    await row.locator('[data-f="name"]').fill('Asignatura de prueba');
    await page.locator('#save-courses').click();
    await expect(page.locator('#side-courses a', { hasText: '99TST' })).toBeVisible();
    fs.rmSync(path.join(demo.dataDir, 'courses.json'), { force: true });
  });
});

test.describe('Campus', () => {
  const course = '/#/c/Simulaci%C3%B3n%20FEM';

  test('inicio: próximas fechas, tarjeta de asignatura y lo pendiente de revisar', async ({ page }) => {
    await page.goto(demo.url);
    await expect(page.locator('.page-title')).toHaveText('Inicio');
    await expect(page.locator('.milestone', { hasText: 'Entrega de la práctica de mallado' })).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Simulación FEM' })).toContainText('Entrega de la práctica de mallado');
    await expect(page.locator('#nav a', { hasText: 'Por revisar' }).locator('.count')).toHaveText('1');
    await expect(page.locator('.quick-item', { hasText: 'por decidir' })).toBeVisible();
  });

  test('inicio: una tarea pedida en clase se marca y sigue marcada al volver', async ({ page }) => {
    await page.goto(demo.url);
    const task = page.locator('.task', { hasText: 'Leer el capítulo de mallado' });
    await task.locator('input[type="checkbox"]').check();
    await expect(page.locator('.task.is-done', { hasText: 'Leer el capítulo de mallado' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.task', { hasText: 'Leer el capítulo de mallado' })).toHaveCount(0);
  });

  test('asignatura: ficha que se fija, teoría por temas y trabajo con lo que se dijo', async ({ page }) => {
    await page.goto(demo.url + course);
    await expect(page.locator('.props')).toContainText('Prof. Martín');
    await page.locator('#pf-lock').click();
    await page.locator('dialog.modal button[value="yes"]').click();
    await expect(page.locator('#panel')).toContainText('Ficha fijada');

    await page.locator('.tab[data-tab="teoria"]').click();
    await expect(page.locator('h2.section', { hasText: 'Tema 2. Mallado y convergencia' })).toBeVisible();
    // (an earlier test renamed this class by hand, so look it up by its key moments)
    await expect(page.locator('.item.link', { hasText: '2 momentos clave' })).toBeVisible();

    await page.locator('.tab[data-tab="trabajos"]').click();
    await page.locator('.card', { hasText: 'Práctica de mallado' }).click();
    await expect(page.locator('#entity-detail')).toContainText('Incluir el estudio de convergencia de malla');
    // the notes written for the practice's range of a class open under it, with their warning box
    await page.locator('#entity-detail details.range-notes summary').first().click();
    await expect(page.locator('#entity-detail .callout-warning')).toContainText('Sin el estudio de convergencia');
    await page.locator('#entity-detail [data-check]').first().check();
    await page.locator('#dl-status').selectOption('doing');
    await expect(page.locator('.card', { hasText: 'Práctica de mallado' })).toContainText('En curso');
    await page.reload();
    await expect(page.locator('#entity-detail [data-check]').first()).toBeChecked(); // stored in the database
  });

  test('pdf: una clase y toda la teoría de la asignatura se descargan como PDF', async ({ page }) => {
    test.setTimeout(120_000);
    const one = await page.request.get(`${demo.url}/api/recordings/${mallado}/pdf`);
    expect(one.status()).toBe(200);
    expect(one.headers()['content-type']).toBe('application/pdf');
    expect(one.headers()['content-disposition']).toMatch(/^attachment; filename="[\w-]+\.pdf"; filename\*=UTF-8''/);
    const pdf = await one.body();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
    // the PDF's own index: Chromium only writes it for a tagged PDF (outline alone is silently ignored)
    expect(pdf.toString('latin1')).toContain('/Outlines');

    const all = await page.request.get(`${demo.url}/api/courses/Simulaci%C3%B3n%20FEM/pdf`);
    expect(all.status()).toBe(200);
    const course = await all.body();
    expect(course.subarray(0, 5).toString()).toBe('%PDF-');
    expect(course.toString('latin1')).toContain('/Outlines');
  });

  test('pdf: la página que se imprime muestra los apuntes de la clase y los temas de la asignatura', async ({ page }) => {
    await page.goto(`${demo.url}/print.html?kind=class&id=${mallado}`);
    await page.waitForSelector('body[data-ready="1"]');
    await expect(page.locator('body')).not.toHaveAttribute('data-error', /./);
    await expect(page.locator('.doc-title')).not.toBeEmpty();
    await expect(page.locator('.prose .katex').first()).toBeVisible(); // formulas are drawn, not left as $…$

    await page.goto(`${demo.url}/print.html?kind=course&course=Simulaci%C3%B3n%20FEM`);
    await page.waitForSelector('body[data-ready="1"]');
    await expect(page.locator('.contents')).toContainText('Contenido');
    await expect(page.locator('section.chapter h1', { hasText: 'Mallado y convergencia' })).toBeVisible();
  });

  test('notas: calcula lo que falta, respeta los mínimos y guarda la nota', async ({ page }) => {
    await page.goto(`${demo.url}${course}?tab=notas`);
    await expect(page.locator('.grade-summary')).toContainText('Necesitas una media de 5');
    const practice = page.locator('.grade-table tr', { hasText: 'Práctica de mallado' }).locator('input[data-score]');
    await practice.fill('8');
    await practice.press('Tab');
    // 30 % at 8 = 2.4 points: the 70 % exam needs (5 - 2.4) / 0.7
    await expect(page.locator('.grade-summary')).toContainText('3,71');

    await page.locator('#g-edit').click();
    const exam = page.locator('tr[data-gid]', { has: page.locator('input[data-field="name"][value="Examen final"]') });
    await exam.locator('input[data-field="min_grade"]').fill('5');
    await exam.locator('input[data-field="min_grade"]').press('Tab');
    await page.locator('#g-edit').click();
    await expect(page.locator('.grade-table tr', { hasText: 'Examen final' }).locator('.need')).toHaveText('5');

    await page.reload();
    await expect(page.locator('.grade-table tr', { hasText: 'Práctica de mallado' }).locator('input[data-score]')).toHaveValue('8');
  });

  test('Ctrl+K: salta a una asignatura, a una clase o a una frase dicha en clase', async ({ page }) => {
    await page.goto(demo.url);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('notas fem');
    await expect(page.locator('.palette-row').first()).toContainText('Notas · Simulación FEM');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/tab=notas/);
    await expect(page.locator('dialog.palette')).toHaveCount(0);

    await page.locator('[data-palette]').click();
    await page.keyboard.type('convergencia');
    await expect(page.locator('.palette-group', { hasText: 'En las clases' })).toBeVisible();
    await page.locator('.palette-row', { hasText: 'Buscar «convergencia»' }).click();
    await expect(page).toHaveURL(/#\/search\?q=convergencia/);
  });

  test('una asignatura avisa de las clases sin analizar', async ({ page }) => {
    await page.goto(`${demo.url}/#/c/Estructuras?tab=sesiones`);
    await expect(page.locator('.note-banner')).toContainText('2 clases sin analizar');
    await expect(page.locator('table.db .tag-yellow', { hasText: 'Sin analizar' })).toHaveCount(2);
    // Without GEMINI_API_KEY the page says what is missing instead of offering the button
    await expect(page.locator('.note-banner')).toContainText('GEMINI_API_KEY');
  });

  test('clase: título del campus, tramos con su destino y momentos clave', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.crumbs')).toContainText('Simulación FEM / Teoría');
    await expect(page.locator('.tab[data-tab="summary"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.ranges .range')).toHaveCount(3);
    await expect(page.locator('.moment', { hasText: 'Criterio de convergencia' })).toBeVisible();
    await expect(page.locator('.scrub-ranges span')).toHaveCount(3);
  });

  test('clase: lo secundario está en «Más» y la pestaña elegida sobrevive a recargar', async ({ page }) => {
    await page.goto(`${demo.url}/#/r/${mallado}`);
    await expect(page.locator('.tab[data-tab="gloss"]')).toBeHidden();
    await page.locator('#more-tab').click();
    await page.locator('.tab[data-tab="gloss"]').click();
    await page.reload();
    await expect(page.locator('.tab[data-tab="gloss"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#edit-meta').click();
    await expect(page.locator('#date-input')).toBeVisible();
  });

  test('calendario: «Sin fecha» y por revisar aplican la fecha propuesta', async ({ page }) => {
    await page.goto(`${demo.url}/#/calendar`);
    await expect(page.locator('h2.section', { hasText: 'Sin fecha' })).toBeVisible();
    await page.locator('[data-mode="month"]').click();
    await expect(page.locator('.cal-day')).not.toHaveCount(0);

    await page.goto(`${demo.url}/#/inbox`);
    await expect(page.locator('.proposal').getByRole('button', { name: 'Añadir como evento nuevo' })).toBeVisible();
    await page.locator('.proposal').getByRole('button', { name: 'Cambiar la fecha' }).click();
    await expect(page.locator('.empty', { hasText: 'Todo revisado' })).toBeVisible();
    await page.goto(`${demo.url}/#/calendar`);
    await expect(page.locator('h2.section', { hasText: 'Sin fecha' })).toHaveCount(0);
  });

  test('calendario: semana crítica en Inicio, vista de semana y suscripción', async ({ page, request }) => {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const [kind, title] of [['exam', 'Parcial de estructuras'], ['deadline', 'Entrega del pórtico']]) {
      const res = await request.post(`${demo.url}/api/events`, { data: { course: 'Estructuras', kind, title, date: day } });
      expect(res.ok()).toBe(true);
    }

    await page.goto(demo.url);
    const banner = page.locator('.heavy-week');
    await expect(banner).toContainText('1 examen y 1 entrega');
    await banner.click();
    await expect(page.locator('[data-mode="week"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.week-day .cal-ev', { hasText: 'Parcial de estructuras' })).toBeVisible();
    await expect(page.locator('.load-week.load-critical')).toHaveCount(1);

    await page.locator('#ev-subscribe').click();
    await expect(page.locator('#sub-panel code')).toContainText('webcal://');
    const ics = await request.get(`${demo.url}/api/calendar.ics?subscribe=1`);
    expect(ics.headers()['content-disposition']).toBeUndefined();
    expect(await ics.text()).toContain('SUMMARY:Examen: Parcial de estructuras');
  });

  test('ajustes: los avisos del calendario se validan y llegan al .ics', async ({ page, request }) => {
    await page.goto(`${demo.url}/#/settings`);
    await page.locator('#rem-deadline').fill('mañana');
    await page.locator('#reminders button[type="submit"]').click();
    await expect(page.locator('.toast.err')).toContainText('no es un número');
    await page.locator('#rem-deadline').fill('3');
    await page.locator('#reminders button[type="submit"]').click();
    await expect(page.locator('.toast', { hasText: 'Avisos guardados' })).toBeVisible();
    // The mallado deadline has an hour (23:59): three days before that hour
    expect(await (await request.get(`${demo.url}/api/calendar.ics`)).text()).toContain('TRIGGER:-P3D');
  });

  test('el filtro de asignatura se ve y se puede quitar en Repaso, Preguntar y Buscar', async ({ page }) => {
    for (const route of ['#/study', '#/ask', '#/search?q=examen']) {
      await page.goto(`${demo.url}/${route}`);
      await expect(page.locator('[data-course-filter]')).toHaveValue('');
    }
    await page.goto(`${demo.url}/#/study`);
    await page.locator('[data-course-filter]').selectOption('Estructuras');
    await expect(page.locator('[data-course-filter]')).toHaveValue('Estructuras');
    await page.locator('[data-course-filter]').selectOption('');
    await expect(page.locator('[data-course-filter]')).toHaveValue('');
  });
});

test.describe('Exámenes', () => {
  test('banco con filtros, destacar y descartar se guardan; el examen guarda el intento', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(demo.url + '/#/');
    await page.locator('#nav a', { hasText: 'Exámenes' }).click();
    await expect(page.locator('h1')).toHaveText('Exámenes');
    await page.locator('.cards .card', { hasText: 'Simulación FEM' }).click();
    await expect(page.locator('details.q').first()).toBeVisible();
    const before = await page.locator('details.q').count();
    expect(before).toBeGreaterThan(1);

    await page.locator('details.q').first().locator('summary').click();
    await page.locator('[data-star]').first().click();
    await expect(page.locator('[data-star]').first()).toContainText('Quitar destacada');
    await page.locator('details.q[open] [data-dismiss]').first().click();
    await expect(page.locator('details.q')).toHaveCount(before - 1);
    const { questions } = await (await page.request.get(`${demo.url}/api/courses/${encodeURIComponent('Simulación FEM')}/questions`)).json();
    expect(questions).toHaveLength(before - 1);

    await page.locator('[data-mode="practice"]').click();
    await page.locator('[data-n="10"]').click();
    await page.locator('[data-start]').click();
    for (const box of await page.locator('.exam-q textarea').all()) await box.fill('El concepto y su aplicación');
    await page.locator('[data-finish]').first().click();
    const ok = page.getByRole('button', { name: 'Entregar' });
    if (await ok.count()) await ok.last().click();
    await page.locator('[data-save]').click();
    await expect(page.locator('[data-save]')).toBeDisabled();
    const { attempts } = await (await page.request.get(`${demo.url}/api/courses/${encodeURIComponent('Simulación FEM')}/exam-attempts`)).json();
    expect(attempts).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

test.describe('Persistencia', () => {
  test('todo lo editado sobrevive a reiniciar el servidor', async ({ page }) => {
    await demo.server.stop();
    demo.db.close();
    demo = await boot(demo.dbPath, demo.dataDir);
    await page.goto(`${demo.url}/#/r/${mallado}?tab=markers`);
    await expect(page.locator('#title-input')).toHaveValue('Clase 2 · Mallado (revisada)');
    await page.goto(`${demo.url}/#/r/${materiales}`);
    await expect(page.locator('.prose')).toContainText('Texto seguro');
  });
});

test.describe('Móvil', () => {
  for (const [name, route] of [['inicio', '/#/'], ['clases', '/#/classes'], ['calendario', '/#/calendar'], ['asignatura', '/#/c/Simulaci%C3%B3n%20FEM'], ['por revisar', '/#/inbox'], ['clase', '/#/r/MALLADO'], ['repaso', '/#/study'], ['ajustes', '/#/settings']] as const) {
    test(`${name} no desborda horizontalmente`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(demo.url + route.replace('MALLADO', String(mallado)));
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    });
  }
});
