/**
 * Daily automated campus agent (`auto-daily`):
 *
 * 1. Opens Chromium with the persistent profile (and `--mute-audio` by default).
 * 2. Navigates to Blackboard Ultra (`LMS_BASE_URL/ultra/course`). If the session expired,
 *    logs in automatically using `LMS_USERNAME` and `LMS_PASSWORD` from `.env`.
 * 3. Iterates over the active courses in `data/courses.json` (e.g. 01MUIN, 02MUIN, 04MUIN):
 *    - Enters the course from `/ultra/course` (or its cached `/ultra/courses/_XXXXX_1/outline` URL)
 *    - Opens Class Collaborate -> "Ver todas las grabaciones" (`/outline/collab/launchRecordings`)
 *    - Waits for the Collaborate LTI table to load and extracts all rows
 *    - Reconciles against SQLite (`findExistingTranscribedMatch`) so already-transcribed `local:`
 *      classes are never re-recorded
 *    - For every genuinely new recording in that course, clicks the 3-dots menu ("Opciones de grabación")
 *      -> "Mirar ahora", clicks Play in the player tab, records audio at 2x speed, normalizes via FFmpeg,
 *      transcribes with faster-whisper, generates study notes/analysis with Gemini, and pushes to GitHub.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Page, Frame, BrowserContext, Locator } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig, RecordingMetadata, RecordingRow } from '../types.js';
import { BrowserManager } from '../browser/BrowserManager.js';
import { PageNavigator } from '../navigator/PageNavigator.js';
import { RecordingExtractor } from '../extractor/RecordingExtractor.js';
import { AudioCaptureManager } from '../capture/AudioCaptureManager.js';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { CourseCatalog, courseLabel, type CatalogCourse } from '../library/courses.js';
import { findExistingTranscribedMatch } from './daily-matcher.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import { restoreForCloud, writeCloudSnapshot } from '../database/snapshot.js';
import { syncToGit } from '../utils/git-sync.js';
import {
  dailyStatePath,
  loadDailyState,
  mergeKnownRows,
  saveDailyState,
  seedFromRows,
  withEntry,
  withOfficial,
  type DailyState,
} from './daily-state.js';
import { CampusRepository } from '../database/CampusRepository.js';
import { exportStaticWebFromDb } from '../cli/export-web.js';
import { fetchLmsFeed } from './lms-sync.js';
import { localCalendarDate, toIso } from '../study/dates.js';
import { materialsDir, syncCourseMaterials, type MaterialsMode } from './materials-sync.js';

/** "off" | "list" | "download" (anything else: undefined). */
export function parseMaterialsMode(value: string | undefined): MaterialsMode | undefined {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'off' || v === 'list' || v === 'download' ? v : undefined;
}
import {
  isCiRun,
  isProfileBusyFailure,
  PlaybackWatchdog,
  RunBudget,
  budgetMinutesFromEnv,
  pickLatest,
  ProfileBusyError,
  watchdogLimitsFor,
} from './daily-guards.js';
import { parseDevice, runTranscriptionCli, type WhisperDevice } from '../transcriber/transcribe-cli.js';
import { assertTranscriptUsable } from '../transcriber/quality.js';
import { adoptHandledClasses, catchUpUnprocessed, finalizeTranscript, printReport } from '../cli/study-commands.js';
import { formatClock } from '../utils/time.js';

export interface DailyAgentOptions {
  speed?: number;
  silent?: boolean;
  headless?: boolean;
  useEdge?: boolean;
  courseFilter?: string;
  model?: string;
  device?: WhisperDevice;
  dryRun?: boolean;
}

export interface CourseCheckSummary {
  course: string;
  totalInTable: number;
  alreadyTranscribed: number;
  newFound: number;
  transcribedNow: number;
  failed: { title: string; error: string }[];
}

/**
 * Builds the Collaborate recordings URL from a Blackboard Ultra course outline URL.
 * Example:
 *   "https://learn.universidadviu.com/ultra/courses/_250115_1/outline"
 *   -> "https://learn.universidadviu.com/ultra/courses/_250115_1/outline/collab/launchRecordings"
 */
export function buildCollaborateRecordingsUrl(outlineOrCourseUrl: string): string | null {
  try {
    const parsed = new URL(outlineOrCourseUrl);
    const match = /(\/ultra\/courses\/_[^/]+\/outline)/i.exec(parsed.pathname);
    if (match && match[1]) {
      parsed.pathname = `${match[1]}/collab/launchRecordings`;
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
    const courseIdMatch = /(\/ultra\/courses\/_[^/]+)/i.exec(parsed.pathname);
    if (courseIdMatch && courseIdMatch[1]) {
      parsed.pathname = `${courseIdMatch[1]}/outline/collab/launchRecordings`;
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensures the browser is authenticated in Blackboard Ultra.
 * Uses the persistent profile first; if on a login page, fills `LMS_USERNAME` and `LMS_PASSWORD`.
 */
export async function ensureCampusLogin(
  page: Page,
  navigator: PageNavigator,
  config: AppConfig,
  logger: Logger
): Promise<void> {
  const coursesUrl = new URL('/ultra/course', config.lmsBaseUrl).toString();
  logger.info({ url: coursesUrl }, 'Opening Blackboard Ultra courses page');

  await page.goto(coursesUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }).catch((err) => {
    logger.warn({ err }, 'Initial navigation warning, checking page state...');
  });

  // Give Blackboard SPA / SSO redirects a moment to settle
  await page.waitForTimeout(2500);

  // Accept Blackboard cookie consent banner if present (#agree_button)
  const agreeBtn = page.locator('#agree_button, button#agree_button, button:has-text("Aceptar"), button:has-text("Estoy de acuerdo")').first();
  if ((await agreeBtn.count().catch(() => 0)) > 0 && (await agreeBtn.isVisible().catch(() => false))) {
    logger.info('Accepting cookie/privacy notice');
    await agreeBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const state = await navigator.detectPageState();
  const curUrl = page.url().toLowerCase();
  const needsLogin =
    state === 'auth-required' ||
    !curUrl.includes('/ultra/') ||
    (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;

  if (!needsLogin) {
    logger.info('Existing persistent session is active');
    return;
  }

  logger.info('Session requires authentication; attempting automatic login');
  if (!config.lmsUsername || !config.lmsPassword) {
    throw new Error(
      'La sesión del campus ha caducado y no hay credenciales en .env. Añade LMS_USERNAME y LMS_PASSWORD en tu archivo .env.'
    );
  }

  // Locate username field (Blackboard classic, Ultra login, or Microsoft/SAML SSO)
  const userSelectors = [
    'input#user_id',
    'input[name="user_id"]',
    'input[name="username"]',
    'input#username',
    'input[name="loginfmt"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ];

  let userFilled = false;
  for (const sel of userSelectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.fill(config.lmsUsername);
      userFilled = true;
      break;
    }
  }

  if (!userFilled) {
    throw new Error('No se encontró el campo de usuario en la pantalla de inicio de sesión del campus.');
  }

  // Check if password field is visible now, or if it's a two-step login (e.g. "Siguiente" first)
  let passLoc = page.locator('input[type="password"]:visible, input#password:visible, input[name="password"]:visible').first();
  if ((await passLoc.count().catch(() => 0)) === 0) {
    const nextBtn = page.locator('#idSIButton9, button[type="submit"], input[type="submit"], button:has-text("Siguiente"), button:has-text("Next")').first();
    if ((await nextBtn.count().catch(() => 0)) > 0) {
      await nextBtn.click();
      await page.waitForTimeout(2000);
    }
    passLoc = page.locator('input[type="password"]:visible, input#password:visible, input[name="password"]:visible').first();
  }

  if ((await passLoc.count().catch(() => 0)) === 0) {
    throw new Error('No se encontró el campo de contraseña en la pantalla de inicio de sesión del campus.');
  }

  await passLoc.fill(config.lmsPassword);

  const submitSelectors = [
    '#entry-login',
    'input#entry-login',
    '#idSIButton9',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Iniciar sesión")',
    'button:has-text("Acceder")',
    'button:has-text("Entrar")',
    'button:has-text("Sign in")',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
      await btn.click();
      submitted = true;
      break;
    }
  }
  if (!submitted) {
    await passLoc.press('Enter');
  }

  // Wait for navigation or optional "Stay signed in" prompt
  await page.waitForTimeout(3000);
  const staySignedInBtn = page.locator('#idSIButton9, input[value="Sí"], button:has-text("Sí"), button:has-text("Yes")').first();
  if ((await staySignedInBtn.count().catch(() => 0)) > 0 && (await staySignedInBtn.isVisible().catch(() => false))) {
    await staySignedInBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Wait up to 25s for `/ultra/` URL to load
  const startWait = Date.now();
  while (Date.now() - startWait < 25000) {
    if (page.url().toLowerCase().includes('/ultra/')) {
      logger.info('Automatic campus login succeeded');
      return;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error('No se pudo completar el inicio de sesión automático en el campus (revisa LMS_USERNAME y LMS_PASSWORD en .env).');
}

/**
 * Navigates from Blackboard Ultra to a specific course's Class Collaborate recordings table:
 * 1. `/ultra/stream` -> click "Cursos" (`/ultra/course`)
 * 2. Click the course matching `course.code` (e.g. `01MUIN`) -> `/ultra/courses/_XXXXX_1/outline`
 * 3. Click the 3 dots next to "Class Collaborate" -> "Ver todas las grabaciones"
 *    (with automatic fallback to `/ultra/courses/_XXXXX_1/outline/collab/launchRecordings`).
 */
export async function navigateToCourseCollaborateRecordings(
  page: Page,
  config: AppConfig,
  course: CatalogCourse,
  logger: Logger
): Promise<void> {
  let outlineUrl = course.ultraUrl ?? '';

  // Step 1: Go to `/ultra/course` and click the course card to reach `/ultra/courses/_XXXXX_1/outline`
  const coursesListUrl = new URL('/ultra/course', config.lmsBaseUrl).toString();
  if (!page.url().toLowerCase().includes('/ultra/course') || page.url().toLowerCase().includes('/ultra/courses/')) {
    // If on /ultra/stream, try clicking "Cursos" in the left menu first, else goto /ultra/course
    const cursosMenuLink = page.locator('a[href*="/ultra/course"], nav :text-is("Cursos")').first();
    if (page.url().toLowerCase().includes('/ultra/stream') && (await cursosMenuLink.count().catch(() => 0)) > 0) {
      await cursosMenuLink.click({ timeout: 5000 }).catch(async () => {
        await page.goto(coursesListUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
      });
    } else {
      await page.goto(coursesListUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    }
  }

  // Wait for course cards to render in `/ultra/course` (the list loads slowly on a cold runner: wait for a card, not a fixed time)
  const code = course.code.trim();
  await page.locator(`a:has-text("${code}"), h4:has-text("${code}")`).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  // Locate the course link by code (e.g. "01MUIN") or lmsId (e.g. "2026_10_A_11175")
  const courseCardCandidates = [
    `a:has-text("${code}_")`,
    `a:has-text("${code}")`,
    `h4:has-text("${code}_")`,
    `h4:has-text("${code}")`,
    `[id*="course-link"]:has-text("${code}")`,
    `[data-course-id]:has-text("${code}")`,
    ...(course.lmsId ? [`a:has-text("${course.lmsId}")`, `[id*="course"]:has-text("${course.lmsId}")`] : []),
  ];

  let clickedCourse = false;
  for (const selector of courseCardCandidates) {
    const loc = page.locator(selector).first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
      logger.info({ code, selector }, 'Clicking course in /ultra/course');
      await loc.click({ timeout: 8000 }).catch(() => {});
      clickedCourse = true;
      break;
    }
  }

  // If course card wasn't visible right away, try using the Blackboard course search input ("Busque sus cursos")
  if (!clickedCourse) {
    const searchInput = page.locator('input[placeholder*="Busque sus cursos" i], input[type="search"]').first();
    if ((await searchInput.count().catch(() => 0)) > 0 && (await searchInput.isVisible().catch(() => false))) {
      await searchInput.fill(code);
      await page.waitForTimeout(1500);
      const filteredLink = page.locator(`a:has-text("${code}"), h4:has-text("${code}")`).first();
      if ((await filteredLink.count().catch(() => 0)) > 0) {
        await filteredLink.click({ timeout: 8000 }).catch(() => {});
        clickedCourse = true;
      }
    }
  }

  // Wait up to 8s for `/ultra/courses/_XXXXX_1/outline` URL
  if (clickedCourse) {
    const waitStart = Date.now();
    while (Date.now() - waitStart < 8000) {
      if (/\/ultra\/courses\/_[^/]+\/outline/i.test(page.url())) {
        outlineUrl = page.url().split('?')[0]!;
        CourseCatalog.saveUltraUrl(config.dataDir, course.code, outlineUrl);
        break;
      }
      await page.waitForTimeout(400);
    }
  }

  // Fallback to cached `course.ultraUrl` if clicking from the list didn't land on `/outline`
  if (!/\/ultra\/courses\/_[^/]+\/outline/i.test(page.url()) && outlineUrl) {
    logger.info({ code, outlineUrl }, 'Navigating directly to cached course outline URL');
    await page.goto(outlineUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
    await page.waitForTimeout(2000);
  }

  // A flaky load must not lose a whole course for the night: reload the course list and click the card again
  for (let attempt = 2; attempt <= 3 && !/\/ultra\/courses\/_[^/]+/i.test(page.url()); attempt++) {
    logger.warn({ code, attempt }, 'Course page not reached, retrying from the course list');
    await page.goto(coursesListUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }).catch(() => undefined);
    await page.locator(`a:has-text("${code}"), h4:has-text("${code}")`).first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500 * attempt);
    for (const selector of courseCardCandidates) {
      const loc = page.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 8000 }).catch(() => {});
        break;
      }
    }
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10_000 && !/\/ultra\/courses\/_[^/]+\/outline/i.test(page.url())) await page.waitForTimeout(400);
    if (!/\/ultra\/courses\/_[^/]+/i.test(page.url()) && outlineUrl) {
      await page.goto(outlineUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout(2000);
    }
  }

  if (!/\/ultra\/courses\/_[^/]+/i.test(page.url())) {
    throw new Error(`No se pudo abrir la página de la asignatura "${courseLabel(course)}" en el campus.`);
  }

  const currentOutlineUrl = page.url().split('?')[0]!;
  CourseCatalog.saveUltraUrl(config.dataDir, course.code, currentOutlineUrl);

  // Step 2: Inside `/outline`, click the 3 dots next to "Class Collaborate" -> "Ver todas las grabaciones"
  logger.info({ code }, 'Opening Class Collaborate recordings view');
  let reachedLaunchRecordings = false;

  const threeDotsSelectors = [
    'button[aria-label*="Class Collaborate" i]',
    'button[aria-label*="Más opciones para Class Collaborate" i]',
    'button[aria-label*="Opciones de Class Collaborate" i]',
    'button[title*="Class Collaborate" i]',
    'li:has-text("Class Collaborate") button[aria-haspopup]',
    'div:has-text("Class Collaborate") button[aria-haspopup="true"]',
  ];

  for (const sel of threeDotsSelectors) {
    const dotsBtn = page.locator(sel).first();
    if ((await dotsBtn.count().catch(() => 0)) > 0 && (await dotsBtn.isVisible().catch(() => false))) {
      await dotsBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);

      const viewAllItem = page.locator(
        '[role="menuitem"]:has-text("Ver todas las grabaciones"), a:has-text("Ver todas las grabaciones"), button:has-text("Ver todas las grabaciones"), :text("Ver todas las grabaciones")'
      ).first();
      if ((await viewAllItem.count().catch(() => 0)) > 0 && (await viewAllItem.isVisible().catch(() => false))) {
        await viewAllItem.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
        if (page.url().toLowerCase().includes('launchrecordings')) {
          reachedLaunchRecordings = true;
          break;
        }
      }
    }
  }

  // Reliable direct route to `/outline/collab/launchRecordings` if menu click didn't navigate
  if (!reachedLaunchRecordings && !page.url().toLowerCase().includes('launchrecordings')) {
    const directRecordingsUrl = buildCollaborateRecordingsUrl(currentOutlineUrl);
    if (!directRecordingsUrl) {
      throw new Error(`No se pudo construir la ruta de grabaciones para "${courseLabel(course)}" (${currentOutlineUrl}).`);
    }
    logger.info({ directRecordingsUrl }, 'Navigating to launchRecordings endpoint');
    await page.goto(directRecordingsUrl, { waitUntil: 'domcontentloaded', timeout: config.browserTimeoutMs });
  }
}

/**
 * Waits for the Collaborate recordings table (or an explicit empty-recordings message)
 * to finish loading inside `launchRecordings` (main page or LTI iframe).
 */
export async function waitForCollaborateTable(
  page: Page,
  extractor: RecordingExtractor,
  timeoutMs: number = 30000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loc = await extractor.findTableLocation();
    if (loc) {
      const rows = await loc.locator.locator('tbody tr, [role="row"]').count().catch(() => 0);
      if (rows > 0) {
        return true;
      }
    }

    // Check if Collaborate explicitly says there are no recordings
    for (const ctx of [page, ...page.frames()]) {
      const empty = await ctx
        .locator('.empty-recordings, .no-recordings, :text("No se encontraron grabaciones"), :text("No recordings found")')
        .count()
        .catch(() => 0);
      if (empty > 0) return true;
    }

    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Opens a specific recording from the Collaborate table by:
 * 1. Finding the row matching `recording.title`
 * 2. Clicking the 3-dots button ("Opciones de grabación") on the right
 * 3. Clicking "Mirar ahora" in the popover menu
 * 4. Catching the newly opened player tab (`eu.bbcollab.com`)
 */
export async function openRecordingPlayerTab(
  page: Page,
  context: BrowserContext,
  recording: RecordingMetadata,
  logger: Logger
): Promise<Page> {
  // Search across the LTI iframe(s) and main page
  const frames: (Page | Frame)[] = [...page.frames().filter((f) => f !== page.mainFrame()), page];

  // Use a distinctive prefix of the title to avoid punctuation issues
  const cleanTitleSnippet = recording.title
    .replace(/\.?\/?recording_\d+$/i, '')
    .trim()
    .slice(0, 45)
    .trim();

  for (const frame of frames) {
    try {
      const rowCandidates = [
        frame.locator(`tbody tr:has-text("${cleanTitleSnippet}")`).first(),
        frame.locator(`tr:has-text("${cleanTitleSnippet}"), [role="row"]:has-text("${cleanTitleSnippet}")`).first(),
      ];

      let targetRow: Locator | null = await findRowByExactTitle(frame, recording.title);
      for (const candidate of targetRow ? [] : rowCandidates) {
        if ((await candidate.count().catch(() => 0)) > 0) {
          targetRow = candidate;
          break;
        }
      }
      if (!targetRow) continue;

      logger.info({ title: recording.title }, 'Located recording row in Collaborate table');

      // 1. Look for the 3-dots "Opciones de grabación" button on this row
      const optionsBtnSelectors = [
        // VIU Collaborate: the recording name is a button that opens the "launch" menu (Mirar ahora, ...)
        'button.show-launch-details',
        '[id$="-launch-dropdown-toggle"]',
        'button[aria-label*="Opciones de grabación" i]',
        '[role="button"][aria-label*="Opciones de grabación" i]',
        '[title*="Opciones de grabación" i]',
        'button[aria-label*="Recording options" i]',
        'button[aria-label*="opciones" i]',
        'td:last-child button',
        '[role="cell"]:last-child button',
        'button, [role="button"], .icon-button, span:has-text("play_circle")',
      ];

      let clickedOptions = false;
      for (const sel of optionsBtnSelectors) {
        // Prefer a button the browser really shows: rows also carry hidden duplicates for narrow layouts
        const base = targetRow.locator(sel);
        const shown = base.locator('visible=true');
        const btn = (await shown.count().catch(() => 0)) > 0 ? shown.first() : base.last();
        if ((await btn.count().catch(() => 0)) > 0) {
          // Listen in case clicking the button directly opens the popup (legacy Collab2 play_circle)
          const directPopupPromise = context.waitForEvent('page', { timeout: 2500 }).catch(() => null);
          await btn.click({ timeout: 5000 }).catch(() => {});
          clickedOptions = true;
          await page.waitForTimeout(700); // let the dropdown animation finish
          logger.info(
            {
              selector: sel,
              expanded: await btn.getAttribute('aria-expanded').catch(() => null),
              itemVisible: await targetRow.locator('[id$="-launch-dropdown"] :text-matches("mirar ahora", "i")').first().isVisible().catch(() => false),
            },
            'Clicked the row menu button'
          );

          const directPopup = await directPopupPromise;
          if (directPopup) {
            await directPopup.waitForLoadState('domcontentloaded').catch(() => {});
            return directPopup;
          }
          break;
        }
      }

      // 2. Click "Mirar ahora" in the dropdown menu that opened
      if (clickedOptions) {
        const mirarAhoraSelectors = [
          ':text-matches("mirar ahora|ver ahora|ver grabaci.n|watch now", "i")',
          '[role="menuitem"]:has-text("Mirar ahora")',
          'button:has-text("Mirar ahora")',
          'a:has-text("Mirar ahora")',
          'li:has-text("Mirar ahora")',
          ':text-is("Mirar ahora")',
          ':text("Mirar ahora")',
          ':text("Watch now")',
        ];

        // Every row has its own hidden launch menu: look in THIS row first (a frame-wide .first() lands on
        // the first row's hidden item), then anywhere for an item that is actually visible.
        const scopes: (Locator | Frame | Page)[] = [targetRow, frame];
        const menuLocators = scopes.flatMap((scope, scopeIdx) =>
          mirarAhoraSelectors.map((sel) => (scopeIdx === 0 ? scope.locator(sel).first() : scope.locator(sel).locator('visible=true').first()))
        );
        for (const menuLoc of menuLocators) {
          if ((await menuLoc.count().catch(() => 0)) > 0 && (await menuLoc.isVisible().catch(() => false))) {
            logger.info({ title: recording.title }, 'Clicking "Mirar ahora"');
            const [popup] = await Promise.all([
              context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
              menuLoc.click({ timeout: 5000 }).catch(() => {}),
            ]);
            if (popup) {
              await popup.waitForLoadState('domcontentloaded').catch(() => {});
              return popup;
            }
          }
        }
      }

      // 2a. The menu did not show after the first click: try other ways a Foundation/ARIA menu opens
      if (clickedOptions) {
        const itemInRow = targetRow.locator('[id$="-launch-dropdown"]').locator(':text-matches("mirar ahora|ver ahora|watch now", "i")').first();
        const toggle = targetRow.locator('button.show-launch-details').locator('visible=true').first();
        const strategies: { name: string; run: () => Promise<unknown> }[] = [
          { name: 'hover+click', run: async () => { await toggle.hover({ timeout: 3000 }); await toggle.click({ timeout: 3000 }); } },
          { name: 'focus+Enter', run: async () => { await toggle.focus({ timeout: 3000 }); await page.keyboard.press('Enter'); } },
          { name: 'focus+ArrowDown', run: async () => { await toggle.focus({ timeout: 3000 }); await page.keyboard.press('ArrowDown'); } },
          { name: 'focus+Space', run: async () => { await toggle.focus({ timeout: 3000 }); await page.keyboard.press('Space'); } },
        ];
        let opened = await itemInRow.isVisible().catch(() => false);
        for (const st of opened ? [] : strategies) {
          await st.run().catch(() => {});
          await page.waitForTimeout(600);
          opened = await itemInRow.isVisible().catch(() => false);
          logger.info({ strategy: st.name, itemVisible: opened }, 'Trying to open the row menu');
          if (opened) break;
        }
        if (opened) {
          logger.info({ title: recording.title }, 'Menu open: real click on "Mirar ahora"');
          const [popup] = await Promise.all([
            context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
            itemInRow.click({ timeout: 5000 }).catch(() => {}),
          ]);
          if (popup) {
            await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 30000 }).catch(() => {});
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            logger.info({ url: popup.url().slice(0, 120) }, 'Player tab opened');
            return popup;
          }
        }
      }

      // 2b. The item exists in this row but Playwright does not see it as visible (Foundation dropdown):
      //     dispatch the click straight on it. Popups are allowed in this browser (--disable-popup-blocking).
      const rowItem = targetRow.locator('[id$="-launch-dropdown"]').locator(':text-matches("mirar ahora|ver ahora|watch now", "i")').first();
      if ((await rowItem.count().catch(() => 0)) > 0) {
        const itemHtml = await rowItem.evaluate((el) => (el.closest('a, button, li') ?? el).outerHTML.slice(0, 700)).catch(() => '');
        logger.info({ title: recording.title, itemHtml }, 'Menu item not visible: dispatching click on it');
        const seen: string[] = [];
        const onResponse = (r: { url(): string; status(): number }) => {
          if (/recording|launch|collab|bbcollab|session/i.test(r.url())) seen.push(`${r.status()} ${r.url().slice(0, 140)}`);
        };
        context.on('response', onResponse);
        const [popup] = await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
          rowItem.dispatchEvent('click').catch(() => {}),
        ]);
        if (popup) {
          popup.on('response', onResponse);
          // The popup opens as about:blank and navigates to the player a moment later
          await popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 30000 }).catch(() => {});
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          context.off('response', onResponse);
          logger.info({ url: popup.url().slice(0, 120), responses: seen.slice(0, 25) }, 'Player tab opened');
          return popup;
        }
      }

      // Keep the evidence: the row's HTML and a screenshot, uploaded with the run's diagnostics
      try {
        const dir = path.join(PROJECT_ROOT, 'data', 'diagnostics');
        fs.mkdirSync(dir, { recursive: true });
        const tag = recording.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
        fs.writeFileSync(path.join(dir, `launch-row-${tag}.html`), await targetRow.evaluate((el) => el.outerHTML), 'utf8');
        await page.screenshot({ path: path.join(dir, `launch-${tag}.png`), fullPage: true }).catch(() => {});
      } catch {
        /* diagnostics are best effort */
      }

      // Say what the menu really offered, so the next fix is made from facts
      try {
        const menuText = await targetRow.locator('[id$="-launch-dropdown"]').first().textContent({ timeout: 2000 });
        logger.warn({ title: recording.title, menu: (menuText ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) }, 'Launch menu contents (no "Mirar ahora" found)');
      } catch {
        logger.warn({ title: recording.title }, 'No launch menu found in the row');
      }

      // 3. Fallback: click the recording title link itself if it is clickable
      const titleLink = targetRow.locator('a, button').first();
      if ((await titleLink.count().catch(() => 0)) > 0) {
        const [popup] = await Promise.all([
          context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
          titleLink.click({ timeout: 5000 }).catch(() => {}),
        ]);
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          return popup;
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Error attempting to open recording row in frame');
    }
  }

  throw new Error(`No se pudo abrir "Mirar ahora" para la grabación "${recording.title}".`);
}

/**
 * Clicks the Play button in the Blackboard Collaborate player (`eu.bbcollab.com`)
 * if the recording requires user interaction to start playback.
 */
export async function clickPlayerPlayIfNeeded(playerPage: Page, logger: Logger): Promise<void> {
  const playSelectors = [
    '.vjs-big-play-button',
    'button[aria-label*="Reproducir" i]',
    'button[aria-label*="Play" i]',
    'button[title*="Reproducir" i]',
    'button[title*="Play" i]',
    'button.play-button',
    '.play-pause-btn',
  ];

  const contexts: (Page | Frame)[] = [playerPage, ...playerPage.frames().filter((f) => f !== playerPage.mainFrame())];
  for (const ctx of contexts) {
    for (const sel of playSelectors) {
      const btn = ctx.locator(sel).first();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        logger.info({ selector: sel }, 'Clicking Play button in Collaborate player');
        await btn.click({ timeout: 5000 }).catch(() => {});
        return;
      }
    }
  }
}

/**
 * Uploads the memory file after a class is handled. In the cloud it also uploads the transcript folder
 * whatever happened to the notes: the runner's disk disappears when the job ends, so a transcript that
 * stayed only there would be lost for good (and the next run would think the class was done).
 * Locally the transcript keeps its own rule (it goes up once the notes exist) and only the file is sent.
 */
export async function publishDailyState(config: AppConfig, transcriptId: string, logger: Logger): Promise<void> {
  if (!config.autoGitSync) {
    if (isCiRun()) console.log('   ⚠️ [Git] AUTO_GIT_SYNC no está activo: en la nube la clase se perdería al terminar. Actívalo en el workflow.');
    return;
  }
  const ci = isCiRun();
  const folder = path.join(config.dataDir, 'transcripts', transcriptId);
  const paths = [dailyStatePath(config.dataDir), ...(ci && fs.existsSync(folder) ? [folder] : [])];
  const push = () =>
    syncToGit({
      enabled: true,
      cwd: PROJECT_ROOT,
      paths,
      subject: `daily agent handled ${transcriptId}`,
      branch: config.gitSyncBranch,
      allowPublic: config.gitSyncAllowPublic,
    });

  let result = await push();
  if (result.status === 'failed' && ci) {
    // Someone pushed while this job was recording: bring their commits in underneath ours and retry once
    spawnSync('git', ['pull', '--rebase', 'origin', config.gitSyncBranch], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 120_000 });
    result = await push();
  }
  const mark = { pushed: '📤', nothing: '✔️', skipped: '⚠️', failed: '❌' }[result.status];
  console.log(`   ${mark} [Git] ${result.message}`);
  logger[result.status === 'pushed' || result.status === 'nothing' ? 'info' : 'warn']({ transcriptId, status: result.status }, result.message);
}

/**
 * Saves the campus listing of the classes recognised tonight, applies it to the database (official date,
 * session and topic) and, in the cloud, publishes the state file and the rebuilt web. Never throws: it is
 * an improvement of data already published, not something worth failing the run for.
 */
export async function publishOfficialSessions(
  config: AppConfig,
  logger: Logger,
  db: DatabaseManager,
  state: DailyState,
  extra: { extraPaths?: string[]; webChanged?: boolean } = {}
): Promise<void> {
  try {
    // Reload first: finalizeTranscript may have added entries since this run began
    const merged = loadDailyState(config.dataDir);
    for (const e of state.entries) {
      if (!e.official) continue;
      const i = merged.entries.findIndex((m) => m.collabId === e.collabId);
      if (i >= 0) merged.entries[i] = { ...merged.entries[i]!, official: e.official };
      else merged.entries.push(e);
    }
    saveDailyState(config.dataDir, merged);
    const changed = new CampusRepository(db.handle).applyOfficialSessions(merged.entries);
    console.log(`📅 Datos oficiales del campus guardados (${changed} clase(s) con fecha, sesión o tema actualizados).`);
    if (!isCiRun() || !config.autoGitSync) return;
    const result = await syncToGit({
      enabled: true,
      cwd: PROJECT_ROOT,
      paths: [dailyStatePath(config.dataDir), ...(extra.extraPaths ?? []).filter((p) => fs.existsSync(p))],
      subject: 'daily agent: official class data and materials from the campus',
      branch: config.gitSyncBranch,
      allowPublic: config.gitSyncAllowPublic,
    });
    console.log(`   [Git] ${result.message}`);
    const webChanged = changed > 0 || extra.webChanged || (extra.extraPaths?.length ?? 0) > 0;
    if (webChanged && process.env['LECTUREVAULT_SHARED_DB'] === '1') {
      await exportStaticWebFromDb(db, { dataDir: config.dataDir, outDir: path.join(PROJECT_ROOT, 'docs'), logger, quiet: true });
      await publishSharedWeb(config, logger, db);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Could not save the official class data');
  }
}

/** Evidence for a player that never showed an audio/video element: where it is, what it shows, what its frames hold. */
export async function savePlayerDiagnostics(playerPage: Page, title: string, logger: Logger): Promise<void> {
  try {
    const dir = path.join(PROJECT_ROOT, 'data', 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const tag = title.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    await playerPage.screenshot({ path: path.join(dir, `player-${tag}.png`), fullPage: true }).catch(() => {});
    const frames = await Promise.all(
      playerPage.frames().map(async (f) => ({
        url: f.url().slice(0, 160),
        media: await f.locator('video, audio').count().catch(() => -1),
        text: ((await f.locator('body').innerText({ timeout: 2000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        mediaState: await f
          .evaluate(
            new Function(
              `return Array.from(document.querySelectorAll('video, audio')).map(function (m) {
                return { tag: m.tagName, readyState: m.readyState, networkState: m.networkState, paused: m.paused, ended: m.ended,
                  duration: m.duration, currentTime: m.currentTime, muted: m.muted, playbackRate: m.playbackRate,
                  src: (m.currentSrc || m.src || '').slice(0, 120), error: m.error ? m.error.code + ' ' + m.error.message : null,
                  mse: !!(m.srcObject) };
              });`
            ) as () => unknown
          )
          .catch(() => null),
        buttons: await f
          .evaluate(
            new Function(
              `return Array.from(document.querySelectorAll('button, [role=button]')).filter(function (b) { return b.offsetParent !== null; })
                .slice(0, 25).map(function (b) { return (b.getAttribute('aria-label') || b.title || b.innerText || '').trim().slice(0, 50); });`
            ) as () => unknown
          )
          .catch(() => null),
      }))
    );
    const info = { url: playerPage.url().slice(0, 200), title: await playerPage.title().catch(() => ''), frames };
    fs.writeFileSync(path.join(dir, `player-${tag}.json`), JSON.stringify(info, null, 2), 'utf8');
    logger.warn(info, 'Player without audio/video element: evidence saved');
  } catch {
    /* best effort */
  }
}

/**
 * Diagnostic: writes how the recordings table is built (headers, first rows, their cells and HTML), so a
 * wrong selector can be fixed from facts. Contains recording titles and dates, no credentials.
 */
export async function dumpTableStructure(extractor: RecordingExtractor, file: string, logger: Logger): Promise<void> {
  try {
    const loc = await extractor.findTableLocation();
    if (!loc) {
      logger.warn('dump-table: no table found');
      return;
    }
    // Passed as text on purpose: tsx adds a `__name` helper to compiled functions that does not exist in the page
    const inPage = new Function('el', `
      var count = function (sel) { return el.querySelectorAll(sel).length; };
      var cells = function (r) {
        return Array.from(r.querySelectorAll('th, td, [role=cell], [role=gridcell], [role=rowheader], [role=columnheader]'))
          .map(function (c) { return { tag: c.tagName, role: c.getAttribute('role'), text: c.innerText.slice(0, 160) }; });
      };
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        counts: {
          thead_th: count('thead th'), th: count('th'), columnheader: count('[role=columnheader]'),
          tbody_tr: count('tbody tr'), tr: count('tr'), role_row: count('[role=row]'),
          td: count('td'), cell: count('[role=cell]'), gridcell: count('[role=gridcell]'),
        },
        rows: Array.from(el.querySelectorAll('tr, [role=row]')).slice(0, 6).map(function (r) {
          return { tag: r.tagName, role: r.getAttribute('role'), cells: cells(r), html: r.outerHTML.slice(0, 3000) };
        }),
      };
    `) as (el: Element) => unknown;
    const data = (await loc.locator.evaluate(inPage)) as Record<string, unknown>;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ container: loc.container === extractor['page'] ? 'page' : 'frame', ...data }, null, 2), 'utf8');
    logger.info({ file }, 'dump-table: structure saved');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'dump-table failed');
  }
}

/**
 * The row whose name cell is exactly `title`. A title prefix is not enough: "Sesión 1: 04MUIN/recording_1" and
 * "…/recording_2" share it, and the wrong recording would be played and filed as the right one.
 */
export async function findRowByExactTitle(scope: Page | Frame, title: string): Promise<Locator | null> {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(title);
  const rows = scope.locator('tbody tr');
  const count = await rows.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const name = await row.locator('td').first().innerText().catch(() => '');
    if (norm(name).replace(/^nombre de la sesi[oó]n\/nombre de la grabaci[oó]n:\s*/i, '') === wanted) return row;
  }
  return null;
}

/**
 * Cloud only: uploads the regenerated docs/ so Vercel shows the new class. It is a separate commit from the
 * transcript so a conflict with the student's own web update can never cost the transcript.
 */
export async function publishSharedWeb(config: AppConfig, logger: Logger, db: DatabaseManager, transcriptIds: string[] = []): Promise<void> {
  if (!config.autoGitSync || !isCiRun() || process.env['LECTUREVAULT_SHARED_DB'] !== '1') return;
  const docs = path.join(PROJECT_ROOT, 'docs');
  if (!fs.existsSync(docs)) return;
  // Transcript folders whose notes were rewritten (catch-up) travel with the web that shows them
  const folders = transcriptIds.map((id) => path.join(config.dataDir, 'transcripts', id)).filter((f) => fs.existsSync(f));
  // The cloud's own copy goes up with the web it was built from, so tomorrow's run starts from it
  let cloudFiles: string[] = [];
  try {
    cloudFiles = writeCloudSnapshot(db.handle, config.dataDir);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'could not write the cloud copy of the database');
  }
  const push = () =>
    syncToGit({
      enabled: true,
      cwd: PROJECT_ROOT,
      paths: [docs, ...folders, ...cloudFiles],
      subject: 'refresh shared web (daily agent)',
      branch: config.gitSyncBranch,
      allowPublic: config.gitSyncAllowPublic,
    });
  let result = await push();
  if (result.status === 'failed') {
    const pull = spawnSync('git', ['pull', '--rebase', 'origin', config.gitSyncBranch], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 120_000 });
    if (pull.status !== 0) spawnSync('git', ['rebase', '--abort'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    else result = await push();
  }
  const mark = { pushed: '📤', nothing: '✔️', skipped: '⚠️', failed: '❌' }[result.status];
  console.log(`   ${mark} [Git Web] ${result.message}`);
  logger[result.status === 'pushed' || result.status === 'nothing' ? 'info' : 'warn']({ status: result.status }, result.message);
}

/** Helper to render a terminal progress bar */
function renderBar(pct: number, width: number = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Main entry point for the daily automated campus check (`auto-daily`).
 */
export async function runDailyCampusAgent(
  config: AppConfig,
  logger: Logger,
  rawOptions?: DailyAgentOptions
): Promise<CourseCheckSummary[]> {
  const agentLogger = logger.child({ component: 'auto-daily' });

  // Parse CLI flags if invoked from CLI
  const args = process.argv.slice(3);
  let speed = rawOptions?.speed ?? 2.0;
  let silent = rawOptions?.silent ?? true;
  // In the cloud there is no screen and no GPU: headless Chromium and CPU Whisper, no matter the flags
  const ci = isCiRun();
  if (ci) process.env['LECTUREVAULT_CI'] = '1'; // tells the study pipeline not to rebuild docs/ from a database that lacks the campus data
  let headless = rawOptions?.headless ?? ci;
  let useEdge = rawOptions?.useEdge ?? process.env.BROWSER_CHANNEL === 'msedge';
  let courseFilter = rawOptions?.courseFilter ?? '';
  let model = rawOptions?.model ?? 'small';
  let device: WhisperDevice | undefined = rawOptions?.device ?? (ci ? parseDevice('cpu') : undefined);
  let dryRun = rawOptions?.dryRun ?? false;
  /** `--seed-state`: write data/daily-state.json from the local database and stop (no browser) */
  let seedOnly = false;
  /** `--dump-table`: save the structure of each recordings table to data/diagnostics (to debug the selectors) */
  let dumpTable = false;
  /** `--latest`: record only the newest unprocessed class of each course (to test the cloud cheaply) */
  let latestOnly = false;
  /** `--probe`: open each new class's player, check the media element is there, and stop (no recording) */
  let probe = false;
  /** `--materials off|list|download`: the subject's files on the campus (default MATERIALS, else download) */
  let materials: MaterialsMode = parseMaterialsMode(process.env['MATERIALS']) ?? 'download';

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '--speed' || a === '-s') && args[i + 1]) {
      speed = parseFloat(args[i + 1]!) || 2.0;
      i++;
    } else if (a === '--audible') {
      silent = false;
    } else if (a === '--silent' || a === '--mute') {
      silent = true;
    } else if (a === '--headless') {
      headless = true;
    } else if (a === '--headed') {
      headless = false;
    } else if (a === '--edge' || a === '-e') {
      useEdge = true;
    } else if ((a === '--course' || a === '-c') && args[i + 1]) {
      courseFilter = args[i + 1]!;
      i++;
    } else if ((a === '--model' || a === '-m') && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if (a === '--device' && args[i + 1]) {
      device = parseDevice(args[i + 1]!);
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--seed-state') {
      seedOnly = true;
    } else if (a === '--dump-table') {
      dumpTable = true;
    } else if (a === '--latest') {
      latestOnly = true;
    } else if (a === '--probe') {
      probe = true;
    } else if (a === '--materials' && args[i + 1]) {
      materials = parseMaterialsMode(args[i + 1]) ?? materials;
      i++;
    } else if (a === '--no-materials') {
      materials = 'off';
    }
  }

  const catalog = CourseCatalog.load(config.dataDir);
  let courses: CatalogCourse[] = catalog.courses;
  if (courseFilter.trim()) {
    const found = catalog.find(courseFilter);
    courses = found ? [found] : courses.filter((c) => c.code.toLowerCase().includes(courseFilter.toLowerCase()));
  }

  if (courses.length === 0) {
    throw new Error('No hay asignaturas configuradas en data/courses.json.');
  }

  console.log('\n===============================================================');
  console.log('🤖 LECTUREVAULT — AGENTE DIARIO DE CAMPUS (AUTO-DAILY)');
  console.log('===============================================================');
  console.log(`• Asignaturas a revisar:  ${courses.map((c) => c.code).join(', ')} (${courses.length})`);
  console.log(`• Velocidad de captura:   ${speed}x (${silent ? '🤫 Silencioso' : '🔊 Con sonido'})`);
  console.log(`• Modo navegador:         ${headless ? '👻 Headless' : '🖥️ Ventana Chromium'}${ci ? ' (GitHub Actions)' : ''}`);
  console.log(`• Login automático (.env): ${config.lmsUsername && config.lmsPassword ? '✅ Configurado' : '⚠️ Sin credenciales en .env (usará sesión guardada)'}`);
  console.log(`• Subida a GitHub:        ${config.autoGitSync ? `✅ Activa (rama ${config.gitSyncBranch})` : '❌ Desactivada (AUTO_GIT_SYNC=false)'}`);
  if (dryRun) {
    console.log('• Modo:                   🔎 DRY-RUN (solo comprueba y sincroniza la tabla, sin grabar)');
  }
  console.log('===============================================================\n');

  // A fresh runner has no database: start from the student's published snapshot, so the analysis of the new
  // class sees the course profiles and the web rebuilt from it keeps all the campus data
  const restored = ci ? restoreForCloud(config.dataDir, config.databasePath) : null;
  if (restored) {
    process.env['LECTUREVAULT_SHARED_DB'] = '1';
    console.log(
      restored === 'cloud'
        ? '• Base de datos:         ♻️ restaurada desde la copia de la nube (data/shared/cloud.db.gz)'
        : '• Base de datos:         ♻️ restaurada desde data/shared/snapshot.db.gz'
    );
  } else if (ci) {
    console.log('• Base de datos:         ⚠️ sin instantánea (data/shared/snapshot.db.gz): la web no se regenerará desde la nube');
  }
  const db = new DatabaseManager(config.databasePath, agentLogger, { backupDir: config.backupDir });

  if (seedOnly) {
    try {
      const before = loadDailyState(config.dataDir).entries.length;
      const seeded = seedFromRows(loadDailyState(config.dataDir), db.getAllRecordings());
      saveDailyState(config.dataDir, seeded);
      console.log(`📝 ${dailyStatePath(config.dataDir)}: ${before} → ${seeded.entries.length} clases ya procesadas.`);
      console.log('   Súbelo a git antes del primer día en GitHub Actions: sin él, la nube volvería a grabar todo.');
    } finally {
      db.close();
    }
    return [];
  }

  const browserManager = new BrowserManager(
    {
      profileDir: config.browserProfileDir,
      headed: !headless,
      viewportWidth: config.browserViewportWidth,
      viewportHeight: config.browserViewportHeight,
      timeoutMs: config.browserTimeoutMs,
      screenshotDir: config.screenshotDir,
      channel: useEdge ? 'msedge' : undefined,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        ...(silent ? ['--mute-audio'] : []),
      ],
    },
    agentLogger
  );

  browserManager.setupGracefulShutdown();
  const summaries: CourseCheckSummary[] = [];

  // What was already handled: the local database (if any) plus the git-tracked file, which is the only
  // memory a cloud run has. Seeding from the database means the first local run fills it in.
  let state: DailyState = loadDailyState(config.dataDir);
  if (!dryRun) {
    state = seedFromRows(state, db.getAllRecordings());
    saveDailyState(config.dataDir, state);
  }

  // Classes that reached the student's database without AI (an earlier cloud run lost its analysis): do them now,
  // so the web shows them complete without the student doing anything
  if (!dryRun && !probe && ci && process.env['LECTUREVAULT_SHARED_DB'] === '1') {
    try {
      const added = adoptHandledClasses(db, config, agentLogger);
      if (added > 0) console.log(`♻️  ${added} clase(s) grabadas por la nube vuelven a la base de datos.`);
      // The university's calendar: new deadlines, exams and classes reach the web without the student's computer
      let calendarChanged = false;
      if (config.lmsCalendarUrl) {
        try {
          const feed = await fetchLmsFeed(config.lmsCalendarUrl, config.dataDir);
          const campus = new CampusRepository(db.handle);
          const synced = campus.syncLmsEvents(feed.items, toIso(localCalendarDate(new Date())));
          const fields = campus.applyOfficialTimetable();
          calendarChanged = synced.added + synced.updated + synced.removed + fields > 0;
          console.log(`📅 Calendario de la universidad: ${synced.added} nuevos, ${synced.updated} cambiados, ${synced.removed} quitados (${feed.total} en total).`);
        } catch (err) {
          // Only the message: the address carries a personal token
          console.log(`⚠️ Calendario de la universidad: ${(err as Error).message}`);
        }
      } else {
        console.log('ℹ️ Calendario de la universidad: sin LMS_CALENDAR_URL en el entorno, no se sincroniza.');
      }
      const done = await catchUpUnprocessed(db, config, agentLogger);
      if (calendarChanged && done.length === 0) {
        await exportStaticWebFromDb(db, { dataDir: config.dataDir, outDir: path.join(PROJECT_ROOT, 'docs'), logger: agentLogger, quiet: true });
      }
      if (done.length > 0 || added > 0 || calendarChanged) await publishSharedWeb(config, agentLogger, db, done);
    } catch (err) {
      agentLogger.warn({ err: (err as Error).message }, 'catch-up of unprocessed classes failed');
    }
  }

  try {
    let context: BrowserContext;
    try {
      context = await browserManager.launch();
    } catch (launchErr) {
      if (isProfileBusyFailure(launchErr)) throw new ProfileBusyError();
      throw launchErr;
    }
    const page = await browserManager.getPage();

    const navigator = new PageNavigator(
      page,
      {
        lmsBaseUrl: config.lmsBaseUrl,
        collabRecordingsPath: config.collabRecordingsPath,
        allowedHosts: config.allowedHosts,
        timeoutMs: config.browserTimeoutMs,
        screenshotDir: config.screenshotDir,
      },
      agentLogger
    );

    // 1. Ensure logged in to Blackboard Ultra
    console.log('🔐 1. Verificando sesión en el campus...');
    await ensureCampusLogin(page, navigator, config, agentLogger);
    console.log('   ✅ Sesión iniciada en el campus.\n');

    // What the campus says about classes already done (official date, session, topic): kept in the state file
    let officialChanged = false;

    // The run has a hard job timeout in the cloud: a class that does not fit is left for tomorrow, not cut halfway
    const budgetMinutes = budgetMinutesFromEnv();
    const runBudget = budgetMinutes ? new RunBudget(budgetMinutes) : null;

    // 2. Check each of the 3 courses in order
    for (const course of courses) {
      const label = courseLabel(course);
      const summary: CourseCheckSummary = {
        course: label,
        totalInTable: 0,
        alreadyTranscribed: 0,
        newFound: 0,
        transcribedNow: 0,
        failed: [],
      };
      summaries.push(summary);

      console.log(`---------------------------------------------------------------`);
      console.log(`📚 Revisando asignatura: ${label}`);
      console.log(`---------------------------------------------------------------`);

      try {
        await navigateToCourseCollaborateRecordings(page, config, course, agentLogger);

        const extractor = new RecordingExtractor(page, agentLogger, {
          courseIdentifier: course.code,
        });

        console.log('   ⏳ Esperando tabla de grabaciones de Class Collaborate...');
        const tableReady = await waitForCollaborateTable(page, extractor, 30000);
        if (!tableReady) {
          throw new Error('No se detectó la tabla de grabaciones tras 30s de espera.');
        }

        if (dumpTable) await dumpTableStructure(extractor, path.join(config.dataDir, 'diagnostics', `table-${course.code}.json`), agentLogger);

        const extraction = await extractor.extractRecordings();
        summary.totalInTable = extraction.recordings.length;
        console.log(`   📋 Grabaciones encontradas en la tabla: ${extraction.recordings.length}`);

        const allExisting = mergeKnownRows(db.getAllRecordings(), state);
        const pendingForCourse: { meta: RecordingMetadata; dbRow: RecordingRow }[] = [];

        // Evaluate from oldest to newest so class numbering stays chronological
        const orderedRecordings = [...extraction.recordings].reverse();

        for (const rec of orderedRecordings) {
          rec.course = label;
          const existingMatch = findExistingTranscribedMatch(rec, label, allExisting);

          if (existingMatch) {
            summary.alreadyTranscribed++;
            if (!dryRun) {
              const listed = withOfficial(state, existingMatch, rec);
              if (listed.changed) {
                state = listed.state;
                officialChanged = true;
              }
            }
            // Upsert the Collab2 row and mark it as processed so it never stays 'new'.
            // A dry run only looks: it writes nothing. The cloud does not store the row either: daily-state.json
            // already remembers the class, and a row without transcript would count as one more class when the
            // course is numbered (Clase 1, 3, 5, 7… instead of 1, 2, 3, 4…).
            if (!dryRun && !ci) {
              db.upsertRecording(rec);
              db.updateStatus(rec.collabId, 'processed');
            }
            console.log(
              `   ✔️ [Ya transcrita] "${rec.title}" (${rec.createdAt.slice(0, 10)}) → coincide con "${existingMatch.display_title || existingMatch.title}"`
            );
          } else {
            summary.newFound++;
            if (!dryRun) db.upsertRecording(rec);
            const dbRow = dryRun ? (undefined as unknown as RecordingRow) : db.getRecordingByCollabId(rec.collabId)!;
            pendingForCourse.push({ meta: rec, dbRow });
            console.log(
              `   🆕 [NUEVA] "${rec.title}" (${rec.createdAt.slice(0, 10)} · ${Math.round(rec.durationSeconds / 60)} min)`
            );
          }
        }

        if (pendingForCourse.length === 0) {
          console.log(`   ✨ Todo al día en ${course.code}.\n`);
          continue;
        }

        if (dryRun) {
          console.log(`   🔎 (Modo --dry-run: ${pendingForCourse.length} clase(s) nueva(s) detectada(s), sin grabar)\n`);
          continue;
        }

        if (latestOnly && pendingForCourse.length > 1) {
          const kept = pickLatest(pendingForCourse);
          console.log(`   ☝️ --latest: solo se graba la más reciente (${kept[0]!.meta.title}); se dejan ${pendingForCourse.length - 1} sin tocar.`);
          pendingForCourse.splice(0, pendingForCourse.length, ...kept);
        }

        // 3. Record, transcribe, generate notes and push to GitHub for each new class in this course
        for (let idx = 0; idx < pendingForCourse.length; idx++) {
          const { meta, dbRow } = pendingForCourse[idx]!;
          const fit = runBudget && !probe ? runBudget.check(meta.durationSeconds, speed) : null;
          if (fit && !fit.ok) {
            console.log(
              `   ⏭️ "${meta.title}" no cabe en el tiempo que queda (necesita ~${fit.needed} min, quedan ${fit.remaining}): se deja pendiente para la próxima ejecución.`
            );
            continue;
          }
          console.log(`\n   ▶️ [${idx + 1}/${pendingForCourse.length}] Grabando nueva clase de ${course.code}: "${meta.title}"`);

          let playerPage: Page | null = null;
          try {
            playerPage = await openRecordingPlayerTab(page, context, meta, agentLogger);

            const captureManager = new AudioCaptureManager(playerPage, context, agentLogger, {
              allowedHosts: config.allowedHosts,
              outputDir: path.join(config.dataDir, 'audio'),
            });

            console.log('   ⏳ Esperando a que cargue el reproductor de Collaborate y pulsando Play...');
            let hook = await captureManager.injectCaptureHook(playerPage);
            let waitElapsed = 0;

            while (!hook.found && waitElapsed < 35000) {
              await clickPlayerPlayIfNeeded(playerPage, agentLogger);
              await new Promise((r) => setTimeout(r, 2000));
              waitElapsed += 2000;
              hook = await captureManager.injectCaptureHook(playerPage);
            }

            if (!hook.found) {
              await savePlayerDiagnostics(playerPage, meta.title, agentLogger);
              throw new Error('No se detectó el elemento de audio/vídeo en la pestaña del reproductor tras 35 segundos.');
            }

            // The <video> exists before the recording is loaded. Starting the recorder on that empty element
            // left it at 0:00 for ever (the player later plays on another one): wait until it has a duration.
            let ready = false;
            for (let t = 0; t < 90 && !ready; t++) {
              const pr = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);
              ready = Boolean(pr && pr.hasMedia && pr.duration > 0);
              if (ready) break;
              if (t % 5 === 4) await clickPlayerPlayIfNeeded(playerPage, agentLogger);
              await new Promise((r) => setTimeout(r, 1000));
            }
            if (!ready) {
              await savePlayerDiagnostics(playerPage, meta.title, agentLogger);
              throw new Error('El reproductor no cargó la grabación (sin duración) tras 90 segundos.');
            }
            console.log('   ✅ Grabación cargada en el reproductor.');

            if (probe) {
              // Give the player time to start, then say what it is doing
              let moved = false;
              for (let t = 0; t < 25 && !moved; t++) {
                await new Promise((r) => setTimeout(r, 1000));
                const pr = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);
                moved = Boolean(pr && pr.currentTime > 1);
                if (t % 5 === 4) await clickPlayerPlayIfNeeded(playerPage, agentLogger);
              }
              await savePlayerDiagnostics(playerPage, meta.title, agentLogger);
              console.log(`   🧪 --probe: ${moved ? 'el vídeo avanza' : 'el vídeo NO avanza tras 25 s'}; no se graba.`);
              await playerPage.close().catch(() => {});
              playerPage = null;
              continue;
            }

            // Click Play if the player still requires initial click
            await clickPlayerPlayIfNeeded(playerPage, agentLogger);

            console.log(`   🔴 Grabando audio digital a ${speed}x...`);
            await captureManager.startCapture(hook.frame, speed);

            let consecutiveEndedCount = 0;
            let stalledSeconds = 0;
            let lastTime = 0;
            // Never wait forever: a frozen video or a closed tab ends the capture with a clear reason
            const watchdog = new PlaybackWatchdog(watchdogLimitsFor(meta.durationSeconds, speed));
            let lastTick = Date.now();

            while (true) {
              await new Promise((r) => setTimeout(r, 1000));
              const progress = await captureManager.getPlaybackProgress(hook.frame).catch(() => null);

              const now = Date.now();
              const verdict = watchdog.sample(
                progress ? { currentTime: progress.currentTime, hasMedia: progress.hasMedia } : null,
                (now - lastTick) / 1000
              );
              lastTick = now;
              if (!verdict.ok) {
                throw new Error(`Captura abortada: ${verdict.reason}.`);
              }

              if (progress && progress.hasMedia) {
                // If paused near the very beginning (0s), click Play to kick off playback
                if (progress.isPaused && progress.currentTime < 2) {
                  stalledSeconds++;
                  if (stalledSeconds % 4 === 0) {
                    await clickPlayerPlayIfNeeded(playerPage, agentLogger);
                  }
                } else {
                  stalledSeconds = 0;
                }

                // Guard against completely stuck player at 0:00 for > 90s
                if (progress.currentTime === lastTime && progress.currentTime === 0 && stalledSeconds > 90) {
                  throw new Error('El reproductor permaneció en pausa en 00:00 durante más de 90 segundos.');
                }
                lastTime = progress.currentTime;

                const curStr = formatClock(progress.currentTime);
                const durStr = progress.duration > 0 ? formatClock(progress.duration) : '--:--';
                const remainingRealSecs = (progress.duration - progress.currentTime) / (speed > 0 ? speed : 1.0);
                const remainingStr = progress.duration > progress.currentTime ? formatClock(remainingRealSecs) : '00:00';
                const statusStr = progress.isPaused ? '⏸️ En pausa' : '▶️ Grabando';

                process.stdout.write(
                  `\r     [${renderBar(progress.percentage)}] ${progress.percentage}% | ${curStr} / ${durStr} | Restante: ~${remainingStr} (${speed}x) | ${statusStr}   `
                );

                const isNearEnd = progress.duration > 0 && progress.currentTime >= progress.duration - 2.0;
                if (progress.hasEnded || (isNearEnd && progress.isPaused)) {
                  consecutiveEndedCount++;
                  if (consecutiveEndedCount >= 2) {
                    process.stdout.write('\n\n   🏁 Vídeo finalizado. Esperando búfer final de 3s...\n');
                    await new Promise((r) => setTimeout(r, 3000));
                    break;
                  }
                } else {
                  consecutiveEndedCount = 0;
                }
              }
            }

            console.log('   ⏳ Normalizando audio a WAV 16 kHz Mono (FFmpeg)...');
            const recId = captureManager.sanitizeRecordingId(`${course.code}_${meta.title}`);
            const captureRes = await captureManager.stopCapture(hook.frame, recId, speed);
            console.log(`   ✅ Audio guardado: ${captureRes.wavPath} (${(captureRes.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);

            // Close player tab before heavy transcription so browser memory is freed
            await playerPage.close().catch(() => {});
            playerPage = null;

            console.log(`   🚀 Transcribiendo localmente con faster-whisper (${model})...`);
            await runTranscriptionCli({
              inputFile: captureRes.wavPath,
              dataDir: config.dataDir,
              model,
              device,
            });

            assertTranscriptUsable(config.dataDir, captureRes.recordingId);

            console.log('   ✨ Generando análisis de campus, apuntes por tramo y subiendo a GitHub...');
            db.linkTranscript(dbRow.id, captureRes.recordingId);
            const classDateIso = meta.createdAt ? meta.createdAt.slice(0, 10) : undefined;
            const report = await finalizeTranscript(
              db,
              config,
              agentLogger,
              captureRes.recordingId,
              label,
              classDateIso
            );
            if (report) printReport(meta.title, report);

            db.updateStatus(meta.collabId, 'processed');
            // Reload first: finalizeTranscript (or the panel) may have added entries since this run began
            state = withEntry(loadDailyState(config.dataDir), {
              collabId: meta.collabId,
              course: label,
              title: meta.title,
              createdAt: meta.createdAt,
              durationSeconds: meta.durationSeconds,
              transcriptId: captureRes.recordingId,
              handledAt: new Date().toISOString(),
              official: { title: meta.title, createdAt: meta.createdAt, durationSeconds: meta.durationSeconds },
            });
            saveDailyState(config.dataDir, state);
            await publishDailyState(config, captureRes.recordingId, agentLogger);
            await publishSharedWeb(config, agentLogger, db);
            summary.transcribedNow++;
            console.log(`   🎉 ¡Clase "${meta.title}" completada de principio a fin!\n`);
          } catch (recErr) {
            const msg = recErr instanceof Error ? recErr.message : String(recErr);
            agentLogger.error({ err: recErr, course: course.code, title: meta.title }, 'Error processing new class');
            console.error(`\n   ❌ Error procesando "${meta.title}": ${msg}\n`);
            summary.failed.push({ title: meta.title, error: msg });
          } finally {
            if (playerPage) {
              await playerPage.close().catch(() => {});
            }
          }
        }
      } catch (courseErr) {
        const msg = courseErr instanceof Error ? courseErr.message : String(courseErr);
        agentLogger.error({ err: courseErr, course: course.code }, 'Error checking course');
        console.error(`   ❌ Error revisando ${label}: ${msg}\n`);
        summary.failed.push({ title: '(Asignatura)', error: msg });
      }
    }

    // 3. The subjects' materials (files and the syllabus their folders spell out). A dry run or a probe only looks.
    const materialPaths: string[] = [];
    let syllabusChanged = false;
    if (materials !== 'off' && !probe) {
      const mode = dryRun ? 'list' : materials;
      console.log(`📚 Materiales del campus (${mode === 'download' ? 'descargando lo nuevo' : 'solo la lista'})...`);
      const budget = { bytes: 150 * 1024 * 1024 };
      const campus = new CampusRepository(db.handle);
      for (const course of courses) {
        const courseUrl = CourseCatalog.load(config.dataDir).find(course.code)?.ultraUrl;
        if (!courseUrl) {
          console.log(`   ⚠️ ${course.code}: no se conoce su página del campus todavía (se aprende al entrar en la asignatura).`);
          continue;
        }
        try {
          const r = await syncCourseMaterials(page.request, {
            dataDir: config.dataDir, code: course.code, course: courseLabel(course), courseUrl,
            mode, logger: agentLogger, budget,
          });
          console.log(`   ✅ ${course.code}: ${r.items} elementos, ${r.files} archivos${r.downloaded ? `, ${r.downloaded} descargados` : ''}${r.syllabus.length ? `, temario de ${r.syllabus.length} temas` : ''}.`);
          for (const s of r.skipped.slice(0, 5)) console.log(`      ↳ ${s}`);
          if (r.changed && !dryRun) materialPaths.push(materialsDir(config.dataDir, course.code));
          if (r.syllabus.length && !dryRun) {
            const applied = campus.applyAiProfile(courseLabel(course), { syllabus: r.syllabus });
            if (applied.action !== 'unchanged') {
              syllabusChanged = true;
              console.log(`      ↳ Temario oficial: ${applied.action === 'proposed' ? 'propuesto en «Por revisar» (la ficha está fijada)' : 'guardado en la ficha'}.`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          agentLogger.warn({ err: msg, course: course.code }, 'campus materials failed');
          console.log(`   ⚠️ ${course.code}: ${msg}`);
        }
      }
    }

    if ((officialChanged || materialPaths.length || syllabusChanged) && !dryRun) {
      await publishOfficialSessions(config, agentLogger, db, state, { extraPaths: materialPaths, webChanged: syllabusChanged });
    }
  } finally {
    console.log('\n===============================================================');
    console.log('📊 RESUMEN DEL AGENTE DIARIO (AUTO-DAILY)');
    console.log('===============================================================');
    for (const s of summaries) {
      console.log(
        `• ${s.course}: ${s.totalInTable} en tabla | ${s.alreadyTranscribed} ya transcritas | ${s.newFound} nuevas | ${s.transcribedNow} grabadas hoy${s.failed.length ? ` | ❌ ${s.failed.length} con error` : ''}`
      );
      for (const f of s.failed) {
        console.log(`    ⚠️ ${f.title}: ${f.error}`);
      }
    }
    console.log('===============================================================\n');

    await browserManager.close().catch(() => {});
    db.close();
  }

  return summaries;
}
