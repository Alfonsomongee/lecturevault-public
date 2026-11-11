/**
 * `notes:eval` — scores the notes of every class under data/transcripts against its own transcript, with no
 * model involved. With `--live` it also writes the notes again in memory with the current prompt (needs a key)
 * and prints both scores, so a prompt change is judged on real classes before it replaces anything. Nothing is
 * saved to disk or to the database.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import type { AppConfig } from '../types.js';
import { GeminiClient } from '../ai/GeminiClient.js';
import { TranscriptRefiner } from '../ai/TranscriptRefiner.js';
import { parseWhisperJson, type TranscriptSegment } from '../library/transcript-files.js';
import { assessNotes, formatQuality } from '../study/notes-quality.js';
import { composeCleanMd, type NotesPart, type NotesRange } from '../study/notes-sections.js';

const LIVE_RANGE_MINUTES = 20;

/** Evenly cut ranges of theory, so the live run does not depend on the analysis stored for the class. */
export function evenRanges(durationMs: number, minutes = LIVE_RANGE_MINUTES): NotesRange[] {
  const size = minutes * 60_000;
  const count = Math.max(1, Math.round(durationMs / size));
  const step = Math.ceil(durationMs / count);
  return Array.from({ length: count }, (_, ord) => ({
    ord, start_ms: ord * step, end_ms: Math.min(durationMs, (ord + 1) * step), destination: 'theory' as const, heading: `Parte ${ord + 1}`,
  }));
}

interface ClassFiles { id: string; segments: TranscriptSegment[]; notes: string | null }

function loadClasses(root: string, only: string[]): ClassFiles[] {
  const dir = path.join(root, 'transcripts');
  if (!fs.existsSync(dir)) return [];
  const out: ClassFiles[] = [];
  for (const id of fs.readdirSync(dir).sort()) {
    if (only.length && !only.some((o) => id.includes(o))) continue;
    const json = path.join(dir, id, `${id}.json`);
    if (!fs.existsSync(json)) continue;
    let segments: TranscriptSegment[];
    try { segments = parseWhisperJson(fs.readFileSync(json, 'utf8')).segments; } catch { continue; }
    if (segments.length === 0) continue;
    const md = path.join(dir, id, `${id}.clean.md`);
    out.push({ id, segments, notes: fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : null });
  }
  return out;
}

export async function runNotesEval(config: AppConfig, logger: Logger): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3), allowPositionals: true, strict: false,
    options: { live: { type: 'boolean' }, facts: { type: 'boolean' }, json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' } },
  });
  const classes = loadClasses(config.dataDir, positionals);
  if (classes.length === 0) { console.log('\nNo hay clases con transcripción en data/transcripts.\n'); return; }

  const client = values['live']
    ? new GeminiClient({
        apiKey: config.geminiApiKey, model: config.geminiModel, deepseekApiKey: config.deepseekApiKey, deepseekModel: config.deepseekModel, logger,
      })
    : null;
  const refiner = client ? new TranscriptRefiner({ client, logger, facts: !!values['facts'] }) : null;
  if (values['live'] && !client?.hasKey) { console.log('\n❌ --live necesita GEMINI_API_KEY o DEEPSEEK_API_KEY en .env.\n'); process.exitCode = 1; return; }

  const rows: Record<string, unknown>[] = [];
  for (const c of classes) {
    const stored = c.notes ? assessNotes(c.notes, c.segments) : null;
    let live = null;
    let model = '';
    if (refiner) {
      const durationMs = Math.round(c.segments[c.segments.length - 1]!.end * 1000);
      const ranges = evenRanges(durationMs);
      const result = await refiner.refineSections(c.segments, ranges, { title: c.id });
      const parts: NotesPart[] = ranges.map((range) => {
        const s = result.sections.find((x) => x.ord === range.ord);
        return { range, gist: s?.gist ?? '', markdown: s?.markdown ?? '' };
      });
      model = result.sections[0]?.model ?? '';
      live = assessNotes(composeCleanMd(c.id, parts), c.segments);
    }
    rows.push({ id: c.id, stored, live, model });
    if (values['json']) continue;
    console.log(`\n${c.id}`);
    if (stored) console.log(`  ${values['live'] ? 'en disco ' : ''}${formatQuality('', stored)}`);
    else console.log('  (sin apuntes .clean.md)');
    if (live) console.log(`  nueva     ${formatQuality('', live)}${model ? `  [${model}]` : ''}`);
    if (values['verbose']) for (const q of [stored, live]) for (const issue of q?.issues ?? []) console.log(`    ⚠ ${issue}`);
    if (values['verbose'] && stored?.coverage.missing.length) console.log(`    sin cubrir: ${stored.coverage.missing.slice(0, 12).join(', ')}`);
  }
  if (values['json']) console.log(JSON.stringify(rows, null, 2));
  else {
    const scored = rows.map((r) => r['stored'] as { score: number } | null).filter((q): q is { score: number } => !!q);
    if (scored.length) console.log(`\nMedia en disco: ${Math.round(scored.reduce((a, q) => a + q.score, 0) / scored.length)} sobre ${scored.length} clases\n`);
  }
}
