// The friends' web: the read-only classes, subjects and search views, served as plain files (as Vercel serves docs/)
import { test, expect } from '@playwright/test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { seedDemo } from '../../src/demo/seed.js';
import { DatabaseManager } from '../../src/database/DatabaseManager.js';
import { buildStaticSite } from '../../src/export/static-site.js';

const logger = pino({ level: 'silent' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-static-e2e-'));
let server: Server;
let url = '';
let firstClass = 0;

test.beforeAll(async () => {
  const seeded = seedDemo(path.join(tmp, 'demo'), logger);
  const db = new DatabaseManager(seeded.dbPath, logger);
  const site = path.join(tmp, 'site');
  try {
    await buildStaticSite(db, { dataDir: seeded.dataDir, outDir: site });
  } finally {
    db.close();
  }
  const ids: number[] = JSON.parse(fs.readFileSync(path.join(site, 'data', 'manifest.json'), 'utf8')).recordings;
  // The class the demo analysed (ranges and key moments): its summary has minutes to click
  firstClass = ids.find((id) => JSON.parse(fs.readFileSync(path.join(site, 'data', 'rec', `${id}.json`), 'utf8')).campus?.sections?.length) ?? ids[0]!;
  // A static host: files only, nothing under /api
  const app = express();
  app.use(express.static(site));
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EDIT_CONTROLS = /^(Editar|Editar datos|Eliminar clase|Confirmar|Descartar|Nuevo evento|Nuevo aviso|Nueva tarjeta|Importar transcripciones|Generar con IA|Regenerar con IA)$/;

test('opens on Clases y Transcripciones, with Calendario but without Inicio or Repaso', async ({ page }) => {
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (res) => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });

  await page.goto(`${url}/#/`);
  await expect(page.locator('h1')).toHaveText('Clases y Transcripciones');
  await expect(page.locator('.static-badge')).toHaveText('Apuntes');
  await expect(page.locator('.course-card').first()).toBeVisible();
  await expect(page.locator('table.readonly-classes').first()).toBeVisible();

  await expect(page.locator('#nav')).toContainText('Todas las clases');
  for (const hiddenSection of ['Inicio', 'Por revisar', 'Repaso', 'Preguntar']) {
    await expect(page.locator('#nav')).not.toContainText(hiddenSection);
  }
  await expect(page.locator('#side-foot')).toContainText('Buscar / Ir a…');
  await expect(page.locator('#side-foot')).toContainText('Tema:');
  await expect(page.locator('#side-foot')).toContainText('Actualizado');
  await expect(page.locator('#side-foot')).not.toContainText('Ajustes');
  await expect(page.locator('#new-class')).toHaveCount(0);

  // Dashboard-only hashes fall back cleanly to Clases y Transcripciones
  for (const privateRoute of ['#/study', '#/inbox', '#/ask', '#/settings']) {
    await page.goto(`${url}/${privateRoute}`);
    await expect(page.locator('h1')).toHaveText('Clases y Transcripciones');
  }
  expect(errors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test('the calendar lists the dates read-only, with the .ics to subscribe', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${url}/#/classes`);
  await page.locator('#nav a', { hasText: 'Calendario' }).click();
  await expect(page.locator('h1')).toHaveText('Calendario');
  await expect(page.locator('#view .loading')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText('No se pudo cargar');
  for (const view of ['Semana', 'Mes', 'Agenda']) {
    await page.locator('button[data-mode]', { hasText: view }).click();
    await expect(page.locator('#view')).not.toContainText('No se pudo cargar');
  }
  // Nothing to edit: no new events
  await expect(page.locator('#ev-new')).toHaveCount(0);
  await page.locator('#ev-subscribe').click();
  await expect(page.locator('#sub-panel')).toContainText('/calendar.ics');
  expect(errors).toEqual([]);
});

test('every page renders without edit controls and subject opens on Teoría', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${url}/#/c/Simulaci%C3%B3n%20FEM`);
  await expect(page.locator('.tab[data-tab="teoria"]')).toHaveAttribute('aria-selected', 'true');
  const tabLabels = (await page.locator('.tabs .tab').allTextContents()).map((t) => t.replace(/\d+$/, '').trim());
  expect(tabLabels).toEqual(['Teoría', 'Sesiones', 'Temario y Ficha', 'Trabajos', 'Exámenes']);

  // Trabajos auto-selects first deliverable with read-only notes and no checkboxes
  await page.locator('.tab[data-tab="trabajos"]').click();
  await expect(page.locator('#entity-detail')).toBeVisible();
  await expect(page.locator('#entity-detail [data-check]')).toHaveCount(0);
  await expect(page.locator('#dl-status')).toHaveCount(0);

  for (const route of ['#/', '#/classes', `#/r/${firstClass}`, `#/r/${firstClass}?tab=notes`, `#/r/${firstClass}?tab=cards`, '#/c/Simulaci%C3%B3n%20FEM', '#/c/Simulaci%C3%B3n%20FEM?tab=trabajos', '#/search?q=malla']) {
    await page.goto(`${url}/${route}`);
    await expect(page.locator('#view .loading')).toHaveCount(0);
    await expect(page.locator('#view')).not.toContainText('No se pudo cargar');
    const labels = await page.locator('#view button:visible, #view a.btn:visible').allTextContents();
    expect(labels.map((l) => l.trim()).filter((l) => EDIT_CONTROLS.test(l)), route).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('recording page shows Tarjetas (without Repasar) and minute link opens transcript', async ({ page }) => {
  await page.goto(`${url}/#/r/${firstClass}`);
  await expect(page.locator('.tabs')).toContainText('Tarjetas');
  await expect(page.locator('.tabs')).not.toContainText('Repasar');
  await expect(page.locator('#more-tab')).toHaveCount(0);

  const stamp = page.locator('#panel [data-listen]').first();
  await stamp.click();
  await expect(page).toHaveURL(/tab=transcript/);
  await expect(page.locator('.seg.is-current')).toHaveCount(1);

  await page.locator('.tab[data-tab="cards"]').click();
  await expect(page.locator('#panel')).not.toContainText('Ir a Repaso');

  await page.goto(`${url}/print.html?kind=class&id=${firstClass}`);
  await page.waitForSelector('body[data-ready="1"]');
  await expect(page.locator('.prose .katex').first()).toBeVisible();
});

test('searching works without a server, suggests closest word, and Ctrl+K filters out personal sections', async ({ page }) => {
  await page.goto(`${url}/#/search?q=malla`);
  await expect(page.locator('.hit').first()).toBeVisible();
  await page.goto(`${url}/#/search?q=mallaa`);
  await expect(page.locator('.note-banner')).toContainText('malla');

  await page.keyboard.press('Control+k');
  await expect(page.locator('dialog.palette')).toBeVisible();
  await expect(page.locator('.palette-list')).not.toContainText('Calendario');
  await page.keyboard.type('malla');
  await expect(page.locator('.palette-list')).toContainText('Buscar «malla»');
  await expect(page.locator('.palette-list')).not.toContainText('Preguntar');
});

test('mobile viewport renders cleanly without horizontal overflow and drawer opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['#/', '#/c/Simulaci%C3%B3n%20FEM', `#/r/${firstClass}`]) {
    await page.goto(`${url}/${route}`);
    await expect(page.locator('#view .loading')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
  await page.locator('#menu-toggle').click();
  await expect(page.locator('#sidebar')).toHaveClass(/\bopen\b/);
  await expect(page.locator('#nav a[data-all-classes]')).toBeVisible();
  await page.locator('#menu-toggle').click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/\bopen\b/);
});

test('Exámenes: the bank is shown and a practice exam is corrected in the browser, keeping the attempt there', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${url}/#/classes`);
  await page.locator('#nav a', { hasText: 'Exámenes' }).click();
  await expect(page.locator('h1')).toHaveText('Exámenes');
  await expect(page.locator('.cards .card').first()).toContainText('pregunta');

  await page.goto(`${url}/#/exams/Simulaci%C3%B3n%20FEM`);
  await expect(page.locator('details.q').first()).toBeVisible();
  // Read-only: no star or dismiss controls
  await page.locator('details.q summary').first().click();
  await expect(page.locator('[data-star], [data-dismiss]')).toHaveCount(0);
  await page.locator('[data-f="origin"]').selectOption('stress');
  await expect(page.locator('details.q').first()).toBeVisible();

  await page.locator('[data-mode="practice"]').click();
  await page.locator('[data-start]').click();
  await expect(page.locator('.exam-q').first()).toBeVisible();
  // Answer every true/false and multiple choice with its first option, write something in the long ones
  for (const radio of await page.locator('.exam-q input[type=radio]:first-of-type').all()) await radio.check().catch(() => undefined);
  for (const box of await page.locator('.exam-q textarea').all()) await box.fill('La idea principal es el concepto central y su aplicación');
  await page.locator('[data-finish]').first().click();
  const confirm = page.locator('dialog button, .dialog button', { hasText: 'Entregar' });
  if (await confirm.count()) await confirm.first().click();
  await expect(page.locator('.exam-score .big')).toBeVisible();
  await page.locator('[data-save]').click();
  await expect(page.locator('[data-save]')).toBeDisabled();
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lv:attempts:')));
  expect(saved).toHaveLength(1);
  expect(errors).toEqual([]);
});
