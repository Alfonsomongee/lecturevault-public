/**
 * Where things live, independent of the folder a command happens to be started from.
 * `npm run` always starts in the project folder, but `node dist/index.js` from somewhere else, a shortcut or a
 * scheduled task do not: every default path hangs from the project folder (or from DATA_DIR), never from cwd.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project folder: where .env, .venv, scripts/ and data/ live (src/utils → root, and dist/utils → root) */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An absolute path stays as it is; a relative one is relative to the project folder, not to cwd. */
export function fromRoot(value: string, root: string = PROJECT_ROOT): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}
