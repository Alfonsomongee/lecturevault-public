/**
 * Screenshots of the dashboard with the built-in demo data (fictional classes, no AI key, nothing from a real account).
 *   npx tsx scripts/take-screenshots.ts [outDir]
 */
process.env['GEMINI_API_KEY'] = '';
process.env['DEEPSEEK_API_KEY'] = '';
process.env['LMS_CALENDAR_URL'] = '';
process.env['AUTO_GIT_SYNC'] = 'false';

import { chromium, type Page } from '@playwright/test';
import pino from 'pino';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardServer } from '../src/dashboard/DashboardServer.js';
import { DatabaseManager } from '../src/database/DatabaseManager.js';
import { seedDemo } from '../src/demo/seed.js';

const outDir = path.resolve(process.argv[2] ?? 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
const logger = pino({ level: 'silent' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-shots-'));
const seeded = seedDemo(tmp, logger);
const db = new DatabaseManager(seeded.dbPath, logger);
const server = new DashboardServer(db, { port: 0, dataDir: seeded.dataDir }, logger);
await server.start();
const base = `http://127.0.0.1:${server.getPort()}`;

const browser = await chromium.launch({ executablePath: process.env['PW_CHROMIUM_PATH'] || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'es-ES' });
const page = await context.newPage();

async function shot(name: string, hash: string, act?: (p: Page) => Promise<void>) {
  await page.goto(`${base}/#${hash}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  if (act) await act(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log('✔', name);
}
const click = (text: string | RegExp) => async (p: Page) => { await p.getByRole('link', { name: text }).or(p.getByRole('button', { name: text })).or(p.getByText(text)).first().click(); };

const meta = (await (await fetch(`${base}/api/recordings`)).json()) as { recordings: { id: number; course: string; title: string; display_title: string | null; has_notes: number; segment_count: number }[] };
const course = 'Simulación FEM';
const cls = meta.recordings.find((r) => r.course === course && r.has_notes && r.segment_count > 0)!;

await shot('01-inicio', '/');
await shot('02-calendario', '/calendar');
await shot('03-asignatura-teoria', `/c/${encodeURIComponent(course)}`);
await shot('04-asignatura-ficha', `/c/${encodeURIComponent(course)}`, click(/Temario y Ficha|Ficha/));
await shot('05-asignatura-trabajos', `/c/${encodeURIComponent(course)}`, click(/^Trabajos/));
await shot('06-asignatura-notas', `/c/${encodeURIComponent(course)}`, async (p) => {
  await click(/^Notas/)(p);
  await p.waitForTimeout(500);
  const first = p.locator('input[type="number"], input[inputmode="decimal"]').nth(1);
  await first.fill('7.5');
  await first.blur();
  await p.waitForTimeout(600);
});
await shot('07-clase-resumen', `/r/${cls.id}`);
await shot('08-clase-apuntes', `/r/${cls.id}`, click(/^Apuntes/));
await shot('09-clase-transcripcion', `/r/${cls.id}`, click(/^Transcripci/));
await shot('10-por-revisar', '/inbox');
await shot('11-paleta', '/', async (p) => { await p.keyboard.press('Control+K'); await p.keyboard.type('mallado'); await p.waitForTimeout(600); });

await browser.close();
await server.stop();
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
