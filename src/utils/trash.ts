/**
 * A recycle bin for the files the dashboard deletes (audio and transcripts of a class).
 * Nothing in data/ is removed straight away: it moves to data/trash/<date>-<class>/ keeping its layout
 * (audio/…, transcripts/…), so putting it back is a move, and the server empties what is older than
 * TRASH_DAYS when it starts. data/trash/ is not part of the transcripts that get uploaded to git.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TRASH_DAYS = 30;

const FOLDER = /^\d{8}-\d{6}-/;

export function trashDir(dataDir: string): string {
  return path.join(dataDir, 'trash');
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

/**
 * Move files and folders into a new trash folder. `entries[].to` is where each lands inside it
 * (relative, e.g. "audio/clase.wav"). Returns the trash folder, or null when there was nothing to move.
 */
export function moveToTrash(
  dataDir: string,
  label: string,
  entries: { from: string; to: string }[],
  now = new Date()
): string | null {
  const present = entries.filter((e) => fs.existsSync(e.from));
  if (present.length === 0) return null;

  const safeLabel = label.replace(/[^\w.-]/g, '_').slice(0, 80);
  const root = path.join(trashDir(dataDir), `${stamp(now)}-${safeLabel}`);
  for (const { from, to } of present) {
    const target = path.join(root, to);
    // A destination outside the trash folder would turn this into a file mover
    if (path.relative(root, target).startsWith('..')) throw new Error(`Destino no válido en la papelera: ${to}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(from, target);
  }
  return root;
}

/** Empty what has been in the trash longer than `days`. Returns how many folders went. */
export function purgeTrash(dataDir: string, now = new Date(), days = TRASH_DAYS): number {
  const dir = trashDir(dataDir);
  if (!fs.existsSync(dir)) return 0;
  const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Only folders this module created: never anything else a person may have put there
    if (!entry.isDirectory() || !FOLDER.test(entry.name)) continue;
    const folder = path.join(dir, entry.name);
    if (fs.statSync(folder).mtimeMs > limit) continue;
    fs.rmSync(folder, { recursive: true, force: true });
    purged++;
  }
  return purged;
}
