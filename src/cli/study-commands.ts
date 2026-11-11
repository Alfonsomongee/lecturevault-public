/**
 * CLI commands for the study copilot: ingest, study, ask, search, export, optimize-audio, demo.
 * Kept out of index.ts so the capture pipeline code stays readable.
 */

import { dailyStatePath, loadDailyState, recordHandledRow } from '../campus/daily-state.js';
import { snapshotPath, writeSharedSnapshot } from '../database/snapshot.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import type { AppConfig } from '../types.js';
import { DatabaseManager } from '../database/DatabaseManager.js';
import { backupDatabaseSync } from '../database/backup.js';
import { StudyRepository } from '../database/StudyRepository.js';
import { CampusRepository } from '../database/CampusRepository.js';
import { TranscriptIngestor } from '../library/TranscriptIngestor.js';
import { StudyPipeline, notesReady, type PipelineReport, type PipelineStep } from '../study/StudyPipeline.js';
import { EXAM_PROMPT_VERSION } from '../study/exam-questions.js';
import { SearchIndex, MARK_CLOSE, MARK_OPEN } from '../search/SearchIndex.js';
import { Rag } from '../search/Rag.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { buildAnkiTsv, buildIcs, noteFileName, renderObsidianNote } from '../study/exporters.js';
import { convertToOpus, findPlaybackAudio } from '../library/audio.js';
import { DashboardServer } from '../dashboard/DashboardServer.js';
import { seedDemo } from '../demo/seed.js';
import { msToClock } from '../utils/time.js';
import { parseIso } from '../study/dates.js';
import { fold } from '../utils/text.js';
import { syncToGit, type GitSyncResult } from '../utils/git-sync.js';
import { CourseCatalog, courseLabel } from '../library/courses.js';
import { refreshSharedWebIfRealData, exportStaticWebFromDb } from './export-web.js';
import { PROJECT_ROOT } from '../utils/paths.js';
import type { RecordingMetadata } from '../types.js';

function args(options: Record<string, { type: 'string' | 'boolean'; short?: string }>) {
  return parseArgs({ args: process.argv.slice(3), options, allowPositionals: true, strict: false });
}

function pipelineConfig(config: AppConfig) {
  return {
    dataDir: config.dataDir,
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    geminiEmbeddingModel: config.geminiEmbeddingModel,
    deepseekApiKey: config.deepseekApiKey,
    deepseekModel: config.deepseekModel,
    notesFacts: config.notesFacts,
  };
}

function printReport(title: string, r: PipelineReport): void {
  const notes = { created: '✅ apuntes generados', kept: '↩️  apuntes ya existentes', skipped: '—', partial: '⚠️  apuntes incompletos (se reintentan)', failed: '❌ apuntes fallidos' }[r.notes];
  if (r.analysis === 'created') {
    console.log(`  ${title}: 🗂️  «${r.title}»${r.proposals ? ` · ${r.proposals} propuestas por revisar` : ''}`);
  } else if (r.analysis === 'failed') {
    console.log(`  ${title}: ❌ análisis fallido`);
  }
  console.log(`  ${title}: ${notes} · ${r.alerts} avisos · ${r.flashcards} tarjetas · ${r.glossary} términos · ${r.examQuestions} preguntas de examen · ${r.embedded} vectores`);
  for (const w of r.warnings) console.log(`     ℹ️  ${w}`);
  for (const e of r.errors) console.log(`     ⚠️  ${e}`);
}

/** Resolve a typed `--course` ("03", "03MUIN", "sistemas eléctricos") to the catalog label; unknown values pass through. */
function courseArg(config: AppConfig, value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? CourseCatalog.load(config.dataDir).resolve(value) : undefined;
}

/** Fill in `course` on freshly scraped recordings when their title/URL carries a known course code. */
export function withDetectedCourses(config: AppConfig, recordings: RecordingMetadata[]): RecordingMetadata[] {
  const catalog = CourseCatalog.load(config.dataDir);
  return recordings.map((r) => ({ ...r, course: r.course || catalog.detect(`${r.title} ${r.playbackUrl}`) || '' }));
}

/** `ingest` — load data/transcripts/* into SQLite (segments, search index, notes). */
export async function runIngest(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({ course: { type: 'string', short: 'c' } });
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    const result = new TranscriptIngestor(db, config.dataDir, logger).ingestAll({ course: courseArg(config, values['course']) });
    console.log('\n📥 Importación de transcripciones');
    console.log(`  Carpetas analizadas:   ${result.scanned}`);
    console.log(`  Vinculadas a Collab2:  ${result.linked}`);
    console.log(`  Grabaciones locales:   ${result.created}`);
    console.log(`  Transcripciones nuevas/actualizadas: ${result.updatedSegments}`);
    console.log(`  Apuntes importados:    ${result.importedNotes}`);
    for (const s of result.skipped) console.log(`  ⚠️  ${s}`);
    await refreshSharedWebIfRealData(db, config.dataDir, { config, subject: 'update shared web after ingest', logger });
    console.log('');
    console.log('');
  } finally {
    db.close();
  }
}

/** `study` — generate notes, alerts, flashcards, glossary and embeddings. */
export async function runStudy(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({
    id: { type: 'string' },
    force: { type: 'boolean' },
    'notes-only': { type: 'boolean' },
    'summary-only': { type: 'boolean' },
    'upgrade-notes': { type: 'boolean' },
    steps: { type: 'string' },
  });
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    new TranscriptIngestor(db, config.dataDir, logger).ingestAll();
    const pipeline = new StudyPipeline(db, pipelineConfig(config), logger);
    if (!pipeline.hasAi) {
      console.log('\n❌ Falta GEMINI_API_KEY en .env: sin ella solo se puede buscar en las transcripciones.\n');
      return;
    }

    console.log('\n🧠 Copiloto de estudio\n');
    if (values['summary-only']) {
      // Only the summary (paragraph + key points); the text of every range stays as it is. Without --id: every class that lacks it
      const ids = values['id'] ? [parseInt(String(values['id']), 10)] : pipeline.study.listWithoutKeyPoints();
      if (ids.length === 0) console.log('  Todas las clases tienen ya el resumen nuevo.');
      for (const id of ids) printReport(`#${id}`, await pipeline.process(id, { force: !!values['force'], steps: ['summary'] }));
    } else if (values['id']) {
      const id = parseInt(String(values['id']), 10);
      const named = String(values['steps'] ?? '').split(',').map((x) => x.trim()).filter(Boolean) as PipelineStep[];
      printReport(`#${id}`, await pipeline.process(id, { force: !!values['force'], steps: named.length ? named : values['notes-only'] ? ['notes'] : undefined }));
    } else if (values['upgrade-notes']) {
      // Regenerate notes that predate timestamps so the interactive player works on old classes
      for (const row of pipeline.study.getOverview()) {
        if (row.segment_count > 0) printReport(row.title, await pipeline.process(row.id, { force: true, steps: ['notes', 'embeddings'] }));
      }
    } else {
      const reports = await pipeline.processPending({ force: !!values['force'] });
      if (reports.length === 0) console.log('  Todo está al día.');
      for (const r of reports) printReport(`#${r.recordingId}`, r);
    }
    await refreshSharedWebIfRealData(db, config.dataDir, {
      config,
      subject: 'update shared web after study',
      extraPaths: [path.join(config.dataDir, 'transcripts')],
      logger,
    });
    console.log('');
  } finally {
    db.close();
  }
}

/** `search "texto"` — instant full-text search from the terminal. */
export async function runSearch(config: AppConfig, logger: Logger): Promise<void> {
  const { values, positionals } = args({ course: { type: 'string', short: 'c' } });
  const query = positionals.join(' ').trim();
  if (!query) {
    console.log('\nUso: npm run search -- "restricciones en Ansys" [--course "Simulación FEM"]\n');
    return;
  }
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    const res = new SearchIndex(db.handle).search(query, { course: courseArg(config, values['course']), limit: 15 });
    console.log(`\n🔎 "${query}"${res.corrected.length ? `  (¿quisiste decir ${res.corrected.map((c) => `"${c.to}"`).join(', ')}?)` : ''}\n`);
    if (res.hits.length === 0) console.log('  Sin resultados.');
    for (const h of res.hits) {
      const snippet = h.snippet.split(MARK_OPEN).join('«').split(MARK_CLOSE).join('»');
      console.log(`  [${h.course || 'sin asignatura'}] ${h.recordingTitle} · ${msToClock(h.startMs)} ${h.source === 'notes' ? '(apuntes)' : ''}`);
      console.log(`    ${snippet}\n`);
    }
  } finally {
    db.close();
  }
}

/** `ai-check` — one tiny real call to each configured provider, so a wrong model id or key shows up now. */
export async function runAiCheck(config: AppConfig, logger: Logger): Promise<void> {
  const client = new GeminiClient({
    apiKey: config.geminiApiKey, model: config.geminiModel, embeddingModel: config.geminiEmbeddingModel,
    deepseekApiKey: config.deepseekApiKey, deepseekModel: config.deepseekModel, logger, maxAttempts: 1,
  });
  if (!client.hasKey) {
    console.log('\n❌ No hay ninguna clave de IA. Añade GEMINI_API_KEY y/o DEEPSEEK_API_KEY a tu .env.\n');
    process.exitCode = 1;
    return;
  }
  console.log('');
  const results = await client.check();
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.provider.padEnd(8)} ${r.model.padEnd(24)} ${String(r.ms).padStart(5)} ms  ${r.ok ? `«${r.detail}»` : r.detail}`);
  }
  if (!config.deepseekApiKey) console.log('ℹ️  Sin DEEPSEEK_API_KEY: no hay respaldo si Gemini da 429.');
  console.log('');
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/** `ask "pregunta"` — RAG over every class, with verified citations. */
export async function runAsk(config: AppConfig, logger: Logger): Promise<void> {
  const { values, positionals } = args({ course: { type: 'string', short: 'c' } });
  const question = positionals.join(' ').trim();
  if (!question) {
    console.log('\nUso: npm run ask -- "¿Qué peso tenía la práctica de CYPE?" [--course Estructuras]\n');
    return;
  }
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    new TranscriptIngestor(db, config.dataDir, logger).ingestAll();
    const client = new GeminiClient({
      apiKey: config.geminiApiKey, model: config.geminiModel, embeddingModel: config.geminiEmbeddingModel,
      deepseekApiKey: config.deepseekApiKey, deepseekModel: config.deepseekModel, logger,
    });
    const rag = new Rag(db.handle, client, logger);
    if (client.hasEmbeddingKey) await rag.indexEmbeddings().catch((e) => console.log(`⚠️  Embeddings no disponibles: ${e.message}`));

    const res = await rag.ask(question, { course: courseArg(config, values['course']) });
    console.log(`\n❓ ${question}\n`);
    if (res.answer) console.log(`${res.answer}\n`);
    else console.log('(Sin GEMINI_API_KEY: se muestran los fragmentos más relevantes, sin respuesta redactada.)\n');

    if (res.citations.length) {
      console.log('📌 Citas verificadas');
      for (const c of res.citations) console.log(`  [${c.fragment}] ${c.recordingTitle} · ${msToClock(c.startMs)}\n      "${c.quote}"`);
    } else if (!res.answer) {
      for (const s of res.sources.slice(0, 5)) console.log(`  • ${s.recordingTitle} · ${msToClock(s.startMs)}\n      ${s.text.slice(0, 220)}…`);
    }
    console.log(`\n(modo: ${res.mode})\n`);
  } finally {
    db.close();
  }
}

function slug(text: string): string {
  return fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sin-asignatura';
}

/** `export` — Anki files, calendar and an Obsidian vault under data/exports. */
export async function runExport(config: AppConfig, logger: Logger): Promise<void> {
  const { values } = args({ course: { type: 'string', short: 'c' } });
  const only = courseArg(config, values['course']);
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    const study = new StudyRepository(db.handle);
    const courses = db.getCourses().map((c) => c.course).filter((c) => !only || c === only);
    const out = path.join(config.dataDir, 'exports');
    console.log('\n📦 Exportación\n');

    for (const course of courses) {
      const dir = path.join(out, slug(course));
      fs.mkdirSync(dir, { recursive: true });
      const cards = study.listFlashcards({ course, limit: 10_000 });
      fs.writeFileSync(path.join(dir, 'anki-basic.txt'), buildAnkiTsv(cards, 'basic'));
      fs.writeFileSync(path.join(dir, 'anki-cloze.txt'), buildAnkiTsv(cards, 'cloze'));
      fs.writeFileSync(path.join(dir, 'calendario.ics'), buildIcs(study.listAlerts({ course }), { calendarName: `LectureVault · ${course || 'General'}` }));

      const vault = path.join(out, 'obsidian', slug(course));
      fs.mkdirSync(vault, { recursive: true });
      let notes = 0;
      for (const rec of db.getAllRecordings().filter((r) => r.course === course)) {
        const n = study.getNotes(rec.id);
        if (!n) continue;
        fs.writeFileSync(
          path.join(vault, `${noteFileName(rec)}.md`),
          renderObsidianNote(rec, n.markdown, study.listAlerts({ recordingId: rec.id }), study.listFlashcards({ recordingId: rec.id }))
        );
        notes++;
      }
      console.log(`  ${course || '(sin asignatura)'}: ${cards.length} tarjetas · ${notes} notas Markdown → ${dir}`);
    }
    if (courses.length === 0) console.log('  No hay nada que exportar todavía.');
    console.log('');
  } finally {
    db.close();
  }
}

/** `optimize-audio` — make small Opus copies for the in-browser player (WAV is kept). */
export async function runOptimizeAudio(config: AppConfig, logger: Logger): Promise<void> {
  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    console.log('\n🎧 Optimizando audio para el reproductor\n');
    let converted = 0;
    for (const rec of db.getAllRecordings()) {
      if (!rec.transcript_id) continue;
      const found = findPlaybackAudio(config.dataDir, rec.transcript_id);
      if (!found || !found.file.endsWith('.wav')) continue;
      try {
        const out = await convertToOpus(config.dataDir, rec.transcript_id);
        const mb = (n: string) => (fs.statSync(n).size / 1024 / 1024).toFixed(1);
        console.log(`  ✅ ${rec.transcript_id}: ${mb(path.join(found.dir, found.file))} MB → ${mb(out)} MB`);
        converted++;
      } catch (err) {
        console.log(`  ❌ ${rec.transcript_id}: ${(err as Error).message}`);
      }
    }
    console.log(`\n  ${converted} archivo(s) convertido(s). Los WAV originales se conservan.\n`);
  } finally {
    db.close();
  }
}

/** `demo` — seed a self-contained demo library and serve it (never touches your real data). */
export async function runDemo(config: AppConfig, logger: Logger): Promise<void> {
  const demoDir = path.join(config.dataDir, 'demo');
  const seeded = seedDemo(demoDir, logger);
  const db = new DatabaseManager(seeded.dbPath, logger);
  const dashboard = new DashboardServer(db, { port: config.dashboardPort, dataDir: seeded.dataDir }, logger);

  const shutdown = async () => {
    await dashboard.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await dashboard.start();
  console.log(`\n🎓 Demo de LectureVault: ${seeded.recordings} clases de ejemplo en ${seeded.dataDir}`);
  console.log(`   Abre http://localhost:${config.dashboardPort}  (Ctrl+C para salir)\n`);
}

/**
 * After a capture + transcription: index the new transcript and, when a Gemini key is configured,
 * generate notes/alerts/flashcards. Returns quietly on AI failure — the transcript is already safe.
 */
export async function finalizeTranscript(
  db: DatabaseManager,
  config: AppConfig,
  logger: Logger,
  transcriptId: string,
  course?: string,
  /** YYYY-MM-DD of the class; local captures only know when they were transcribed */
  classDate?: string
): Promise<PipelineReport | null> {
  let recording = new TranscriptIngestor(db, config.dataDir, logger).ingestOne(transcriptId, undefined, course);
  if (classDate && parseIso(classDate)) {
    db.setCreatedAt(recording.id, new Date(`${classDate}T10:00:00`).toISOString());
    recording = db.getRecordingById(recording.id)!;
  }
  // Every capture path ends here: remember the class so the cloud agent never records it again
  recordHandledRow(config.dataDir, recording);
  const pipeline = new StudyPipeline(db, pipelineConfig(config), logger);
  if (!pipeline.hasAi) {
    await uploadTranscript(config, transcriptId, logger);
    return null;
  }
  const report = await pipeline.process(recording.id);
  // In the cloud the database is rebuilt from scratch and lacks the campus data: regenerating docs/ from it
  // would publish a poorer site than the one made on the student's machine
  // (unless the cloud restored the student's snapshot first: then it has the campus data too)
  const mayExportWeb = process.env['LECTUREVAULT_CI'] !== '1' || process.env['LECTUREVAULT_SHARED_DB'] === '1';
  if (mayExportWeb && path.resolve(config.dataDir) === path.resolve(PROJECT_ROOT, 'data')) {
    let exported = false;
    try {
      await exportStaticWebFromDb(db, { dataDir: config.dataDir, outDir: path.join(PROJECT_ROOT, 'docs'), logger });
      exported = true;
    } catch (err) {
      // The class itself is fine and is still uploaded; only the web (and the snapshot) wait
      logger.warn({ err: (err as Error).message }, 'Could not rebuild the shared web');
      console.log(`⚠️ [Web] ${(err as Error).message}`);
    }
    // Only the student's machine publishes the snapshot; the cloud never does
    if (exported && process.env['LECTUREVAULT_CI'] !== '1') {
      try {
        writeSharedSnapshot(db.handle, snapshotPath(config.dataDir));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Could not write the shared database snapshot');
      }
    }
  }
  // The upload (and so the Vercel deploy) waits for the notes: a transcript without them is not worth publishing
  if (notesReady(report)) await uploadTranscript(config, transcriptId, logger);
  else if (config.autoGitSync) {
    console.log('\n⏳ [Git] Los apuntes no se han generado (' + (report.errors[0] ?? report.notes) + '): no se sube nada todavía.');
    console.log('   Pulsa «Generar con IA» en la clase: al terminar se sube sola.');
  }
  return report;
}

/**
 * Cloud only: classes the daily agent handled whose transcript folder is in the repository but not in the
 * database (the student's snapshot was published before the cloud recorded them). They come back with the
 * course and class day the agent remembered in daily-state.json. Returns how many it added.
 */
export function adoptHandledClasses(db: DatabaseManager, config: AppConfig, logger: Logger): number {
  const ingestor = new TranscriptIngestor(db, config.dataDir, logger);
  let added = 0;
  for (const entry of loadDailyState(config.dataDir).entries) {
    if (!entry.transcriptId || !entry.course || db.getRecordingByTranscriptId(entry.transcriptId)) continue;
    try {
      const rec = ingestor.ingestOne(entry.transcriptId, undefined, entry.course);
      if (parseIso(entry.createdAt.slice(0, 10))) db.setCreatedAt(rec.id, entry.createdAt);
      added++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, id: entry.transcriptId }, 'could not bring back a class recorded by the cloud');
    }
  }
  return added;
}

/**
 * Cloud only: classes the student's database already holds but that never went through the AI
 * (a class recorded by an earlier cloud run keeps its analysis in a database that is lost with the runner).
 * They are processed here, so the web rebuilt from this database shows title, sections, cards and glossary.
 * Returns the transcript folders that changed, so the caller can upload them with docs/.
 */
export async function catchUpUnprocessed(db: DatabaseManager, config: AppConfig, logger: Logger, max = 8): Promise<string[]> {
  const pipeline = new StudyPipeline(db, pipelineConfig(config), logger);
  if (!pipeline.hasAi) return [];
  const study = new StudyRepository(db.handle);
  const rows = study
    .getOverview()
    .filter((row) => row.segment_count > 0)
    .map((row) => db.getRecordingById(row.id))
    .filter((rec): rec is NonNullable<typeof rec> => Boolean(rec && rec.course && !rec.ignored_at && rec.transcript_id && !rec.analysis_version))
    .slice(0, max);
  // Notes that came out with a hole (a range the model could not write): only the notes step is repeated
  const holeIds = new Set(study.listIncompleteNotes());
  const holes = [...holeIds]
    .filter((id) => !rows.some((r) => r.id === id))
    .map((id) => db.getRecordingById(id))
    .filter((rec): rec is NonNullable<typeof rec> => Boolean(rec && rec.course && !rec.ignored_at && rec.transcript_id))
    .slice(0, Math.max(0, max - rows.length));
  // Classes already analysed whose exam-question bank is missing (the feature came later): only that step runs
  const taken = new Set([...rows, ...holes].map((r) => r.id));
  const examOnly = study
    .getOverview()
    .filter((row) => row.segment_count > 0 && !taken.has(row.id))
    .map((row) => db.getRecordingById(row.id))
    .filter((rec): rec is NonNullable<typeof rec> => Boolean(rec && rec.course && !rec.ignored_at && rec.transcript_id && rec.analysis_version && rec.exam_version !== EXAM_PROMPT_VERSION))
    .slice(0, 8);
  const changed: string[] = [];
  for (const rec of [...rows, ...holes, ...examOnly]) {
    const incomplete = holes.includes(rec);
    const examOnlyRun = examOnly.includes(rec);
    console.log(`\n♻️  ${examOnlyRun ? 'Sin preguntas de examen' : incomplete ? 'Apuntes incompletos, se reintentan' : 'Clase sin procesar con IA'}: ${rec.display_title ?? rec.title} (${rec.transcript_id})`);
    try {
      const report = await pipeline.process(rec.id, examOnlyRun ? { steps: ['exam'] } : incomplete ? { steps: ['notes'] } : undefined);
      printReport(rec.display_title ?? rec.title, report);
      if (examOnlyRun ? report.examQuestions > 0 : notesReady(report)) changed.push(rec.transcript_id!);
    } catch (err) {
      logger.warn({ err: (err as Error).message, id: rec.id }, 'catch-up of an unprocessed class failed');
    }
  }
  if (changed.length > 0) {
    try {
      await exportStaticWebFromDb(db, { dataDir: config.dataDir, outDir: path.join(PROJECT_ROOT, 'docs'), logger });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not rebuild the shared web');
    }
  }
  return changed;
}

/**
 * Upload a transcript folder (with its notes) to the git remote when the student turned on AUTO_GIT_SYNC.
 * Whatever happens is printed: an upload that is skipped or fails must never look like it worked.
 */
export async function uploadTranscript(config: AppConfig, transcriptId: string, logger?: Logger): Promise<GitSyncResult | null> {
  const folder = path.join(config.dataDir, 'transcripts', transcriptId);
  if (!config.autoGitSync || !fs.existsSync(folder)) return null;
  const docsDir = path.join(PROJECT_ROOT, 'docs');
  const includeDocs = process.env['LECTUREVAULT_CI'] !== '1' && path.resolve(config.dataDir) === path.resolve(PROJECT_ROOT, 'data') && fs.existsSync(docsDir);
  const statePath = dailyStatePath(config.dataDir);
  const snapshotFile = snapshotPath(config.dataDir);
  const stateFile = [statePath, ...(process.env['LECTUREVAULT_CI'] !== '1' ? [snapshotFile] : [])].filter((f) => includeDocs && fs.existsSync(f));
  const result = await syncToGit({
    enabled: true,
    cwd: includeDocs ? PROJECT_ROOT : path.dirname(folder),
    paths: includeDocs ? [folder, docsDir, ...stateFile] : [folder],
    subject: `update notes and transcript for ${transcriptId}`,
    branch: config.gitSyncBranch,
    allowPublic: config.gitSyncAllowPublic,
  });
  const mark = { pushed: '📤', nothing: '✔️', skipped: '⚠️', failed: '❌' }[result.status];
  console.log(`\n${mark} [Git] ${result.message}`);
  logger?.[result.status === 'pushed' || result.status === 'nothing' ? 'info' : 'warn']({ transcriptId, status: result.status }, result.message);
  return result;
}

export { printReport };

/**
 * `courses` — manage the subject catalog (data/courses.json).
 *   courses init   create it from courses.example.json (your 10 MUIN subjects)
 *   courses list   subjects with how many classes each has
 *   courses auto   assign unassigned classes whose title/folder contains a course code
 *   courses fix    give every course its catalog name and clean old AI data (makes a backup; no Gemini)
 */
export async function runCourses(config: AppConfig, logger: Logger): Promise<void> {
  const sub = process.argv[3] ?? 'list';
  const example = path.resolve('courses.example.json');
  const catalog = () => CourseCatalog.load(config.dataDir);

  if (sub === 'init') {
    const created = CourseCatalog.init(config.dataDir, example);
    console.log(created ? `\n✅ Creado ${path.join(config.dataDir, 'courses.json')} (edítalo a mano si cambian las asignaturas)\n` : '\nℹ️  Ya existe data/courses.json; no se ha tocado.\n');
    return;
  }

  const db = new DatabaseManager(config.databasePath, logger, { backupDir: config.backupDir });
  try {
    if (sub === 'auto') {
      let n = 0;
      for (const rec of db.getAllRecordings().filter((r) => !r.course)) {
        const found = catalog().detect(`${rec.title} ${rec.transcript_id ?? ''} ${rec.playback_url}`);
        if (found) { db.setCourse(rec.id, found); n++; console.log(`  ${rec.title} → ${found}`); }
      }
      console.log(`\n${n} clase(s) asignada(s). El resto se puede asignar en el dashboard (selección múltiple).\n`);
      return;
    }
    if (sub === 'fix') {
      console.log(`\n💾 Copia de seguridad: ${backupDatabaseSync(db.handle, config.backupDir, 'manual')}`);
      const campus = new CampusRepository(db.handle);
      for (const { course } of db.getCourses().filter((c) => c.course)) {
        const label = catalog().resolve(course);
        if (label !== course) { campus.renameCourse(course, label); console.log(`  «${course}» → ${label}`); }
      }
      const r = campus.repairAiData();
      console.log(`\n✅ Fichas limpiadas: ${r.profiles} · formatos: ${r.formats} · falsos exámenes: ${r.exams} · eventos corregidos: ${r.events} · tramos recuperados: ${r.sections}\n`);
      if (r.sections > 0) console.log('   Sus apuntes se escriben al arrancar el panel (npm run serve): solo los tramos que faltan.\n');
      return;
    }
    const cat = catalog();
    if (cat.courses.length === 0) {
      console.log('\nNo hay catálogo. Ejecuta: npm run courses -- init\n');
      return;
    }
    const counts = new Map(db.getCourses().map((c) => [c.course, c.count]));
    console.log('\n📚 Asignaturas\n');
    for (const c of cat.courses) console.log(`  ${courseLabel(c).padEnd(70)} ${String(counts.get(courseLabel(c)) ?? 0).padStart(3)} clases`);
    console.log(`\n  Sin asignatura: ${counts.get('') ?? 0}\n`);
  } finally {
    db.close();
  }
}
