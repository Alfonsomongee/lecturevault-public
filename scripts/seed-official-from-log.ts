/**
 * One-off: fills the campus listing (official title and date) of daily-state.json from the log of a daily
 * agent run (`gh run view <id> --log`), for classes the agent recognised before it started saving it.
 * Each "[Ya transcrita] "<campus title>" (<day>) → coincide con "<title>"" line is matched to the class the
 * agent named (display title or title, in the database or in the state file), never re-guessed.
 * Usage: npx tsx scripts/seed-official-from-log.ts <log-file>
 */
import fs from 'node:fs';
import { loadConfig } from '../src/utils/config.js';
import { createLogger } from '../src/utils/logger.js';
import { DatabaseManager } from '../src/database/DatabaseManager.js';
import { loadDailyState, mergeKnownRows, saveDailyState, withOfficial } from '../src/campus/daily-state.js';

const file = process.argv[2];
if (!file) throw new Error('Falta el archivo de registro');
const config = loadConfig();
const db = new DatabaseManager(config.databasePath, createLogger({ logLevel: 'warn', logDir: config.logDir }), { backupDir: config.backupDir });
let state = loadDailyState(config.dataDir);
let course = '';
let changed = 0;
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const c = /Revisando asignatura: (.+)$/.exec(line);
  if (c) { course = c[1]!.trim(); continue; }
  const m = /\[Ya transcrita\] "(.+)" \((\d{4}-\d{2}-\d{2})\) → coincide con "(.+)"\s*$/.exec(line);
  if (!m || !course) continue;
  const rows = mergeKnownRows(db.getAllRecordings(), state).filter((r) => r.course === course && (r.display_title || r.title) === m[3]);
  if (rows.length !== 1) { console.log(`⚠️ ${rows.length} parejas para "${m[3]}": se salta`); continue; }
  const rec = { title: m[1]!, createdAt: `${m[2]}T12:00:00.000Z`, durationSeconds: 0 };
  const out = withOfficial(state, rows[0]!, rec);
  if (out.changed) { state = out.state; changed++; }
  console.log(`${course.slice(0, 6)} | ${rec.title.slice(0, 55).padEnd(55)} → ${rows[0]!.transcript_id}`);
}
saveDailyState(config.dataDir, state);
db.close();
console.log(`${changed} clase(s) con ficha oficial`);
