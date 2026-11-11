/**
 * LectureVault — the friends' read-only web (`npm run export:web`, and automatically after each class).
 *
 * The web itself is built by export/static-site.ts: the dashboard's own views in read-only mode, fed with
 * the dashboard's own answers saved as files. This file decides when to build it, refuses to publish a
 * database that lost most of its classes, writes the shared snapshot the cloud rebuilds from, and uploads.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { CampusRepository } from '../database/CampusRepository.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import { syncToGit } from '../utils/git-sync.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { snapshotPath, writeSharedSnapshot } from '../database/snapshot.js';
import { untitledClasses, webShrinks } from '../database/safety.js';
import { isCiRun } from '../campus/daily-guards.js';
import { loadDailyState } from '../campus/daily-state.js';
import { buildStaticSite } from '../export/static-site.js';
import type { AppConfig } from '../types.js';
import type { Logger } from 'pino';

/**
 * Automatically updates `docs/` (the friends' read-only frontend) whenever the real local database
 * changes, and optionally syncs `docs/` to Git if AUTO_GIT_SYNC is enabled.
 * Never runs during unit tests (where dataDir is a temporary directory).
 */
export async function refreshSharedWebIfRealData(
  db: DatabaseManager,
  dataDir: string,
  options: { config?: AppConfig; subject?: string; extraPaths?: string[]; logger?: Logger; quiet?: boolean } = {}
): Promise<void> {
  if (path.resolve(dataDir) !== path.resolve(PROJECT_ROOT, 'data')) return;
  const outDir = path.join(PROJECT_ROOT, 'docs');
  try {
    // Classes recorded in the cloud arrive as transcript folders after a `git pull`: bring them into the
    // database first, or this export would take them off the web again
    new TranscriptIngestor(db, dataDir, options.logger).ingestAll();
    // What the campus calls each class (date, session, topic), recorded by the daily agent in daily-state.json
    new CampusRepository(db.handle).applyOfficialSessions(loadDailyState(dataDir).entries);
    await exportStaticWebFromDb(db, { dataDir, outDir, quiet: options.quiet ?? false, logger: options.logger });
    // The cloud rebuilds the web from this copy (see database/snapshot.ts), so it is published with docs/
    const snapshot = snapshotPath(dataDir);
    try {
      writeSharedSnapshot(db.handle, snapshot);
    } catch (err) {
      options.logger?.warn({ err: (err as Error).message }, 'Could not write the shared database snapshot');
    }
    if (options.config?.autoGitSync) {
      const paths = [outDir, snapshot, ...(options.extraPaths ?? [])].filter((p) => fs.existsSync(p));
      const result = await syncToGit({
        enabled: true,
        cwd: PROJECT_ROOT,
        paths,
        subject: options.subject ?? 'update shared read-only web',
        branch: options.config.gitSyncBranch,
        allowPublic: options.config.gitSyncAllowPublic,
      });
      const mark = { pushed: '📤', nothing: '✔️', skipped: '⚠️', failed: '❌' }[result.status];
      if (!options.quiet) console.log(`${mark} [Git Web] ${result.message}`);
      options.logger?.[result.status === 'pushed' || result.status === 'nothing' ? 'info' : 'warn'](
        { status: result.status },
        result.message
      );
    }
  } catch (err) {
    options.logger?.warn({ err: (err as Error).message }, 'Could not refresh shared static web');
    if (!options.quiet) console.log(`⚠️ [Web] ${(err as Error).message}`);
  }
}

export interface StaticExportOptions {
  dataDir: string;
  outDir?: string;
  quiet?: boolean;
  logger?: Logger;
  /** Publish even if the database has far fewer classes than the web already shows (see webShrinks) */
  force?: boolean;
}

/** Classes shown by the web already in `outDir` (0 when there is none or it cannot be read). */
export function publishedClassCount(outDir: string): number {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'data', 'manifest.json'), 'utf8'));
    if (Array.isArray(manifest?.recordings)) return manifest.recordings.length;
  } catch {
    /* an older web: its bundle */
  }
  try {
    const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'static-api', 'bundle.json'), 'utf8'));
    const list = bundle?.recordings?.recordings;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/** Builds the read-only web from an open database (see export/static-site.ts). */
export async function exportStaticWebFromDb(
  db: DatabaseManager,
  options: StaticExportOptions
): Promise<{ outDir: string; classesCount: number; coursesCount: number }> {
  const outDir = options.outDir ?? path.join(PROJECT_ROOT, 'docs');

  // A rolled-back or wrong database must not replace the published web (it happened once with OneDrive)
  const published = publishedClassCount(outDir);
  const current = new StudyRepository(db.handle).getOverview().filter((r) => r.segment_count > 0).length;
  if (!options.force && webShrinks(published, current)) {
    throw new Error(
      `La base de datos tiene ${current} clases y la web publicada ${published}: no se sobrescribe. ` +
        'Si es correcto (has borrado clases a propósito), ejecuta `npm run export:web -- --force`.'
    );
  }

  // Classes without the AI's campus title would replace titled ones on the web (the cloud analyses in its own copy)
  const untitled = untitledClasses(new StudyRepository(db.handle).getOverview());
  if (!options.force && !isCiRun() && untitled.length > 0) {
    throw new Error(
      `Hay ${untitled.length} clases sin título ni análisis de IA (ids ${untitled.join(', ')}): no se publican así. ` +
        'Ejecuta `npm run study` y vuelve a exportar (o `npm run export:web -- --force` para publicarlas igualmente).'
    );
  }

  // Teacher and schedule come from the university's timetable, whatever the last class analysis heard
  try {
    new CampusRepository(db.handle).applyOfficialTimetable();
  } catch (err) {
    options.logger?.warn({ err: (err as Error).message }, 'official timetable could not be applied');
  }

  const result = await buildStaticSite(db, { dataDir: options.dataDir, outDir, logger: options.logger });
  if (!options.quiet) {
    console.log(
      `🌐 Web de solo lectura actualizada en: ${outDir} (${result.classes} clases, ${result.courses} asignaturas, ` +
        `${result.files} archivos, ${(result.bytes / 1024 / 1024).toFixed(1)} MB de datos)`
    );
  }
  return { outDir, classesCount: result.classes, coursesCount: result.courses };
}

export async function runExportWeb(argv = process.argv.slice(2)): Promise<void> {
  let outDir = path.join(PROJECT_ROOT, 'docs');
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') force = true;
    else if (argv[i] === '--out' && argv[i + 1]) outDir = path.resolve(argv[++i]!);
  }

  const config = loadConfig();
  const logger = createLogger({ logLevel: 'warn', logDir: config.logDir });
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    new CampusRepository(db.handle).applyOfficialSessions(loadDailyState(config.dataDir).entries);
    await exportStaticWebFromDb(db, { dataDir: config.dataDir, outDir, force, logger });
    // The cloud rebuilds the web from this copy, so a manual export must leave it as current as docs/ (see snapshot.ts)
    if (path.resolve(outDir) === path.join(PROJECT_ROOT, 'docs')) writeSharedSnapshot(db.handle, snapshotPath(config.dataDir));
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('export-web.ts')) {
  runExportWeb()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error al exportar la web:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
