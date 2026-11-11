/**
 * Upload transcripts to the project's git remote, without surprises.
 *
 * Uploading is a publication, so it is opt-in (AUTO_GIT_SYNC) and it only ever touches what it was
 * asked to: it commits the given paths and nothing else the student has staged, uploads only from the
 * configured branch, never pushes commits that are not its own, and refuses a remote that GitHub says
 * is public. Every outcome comes back as a result the caller can show; nothing is swallowed.
 */

import { spawnSync } from 'node:child_process';

/** Every commit made here starts with this, so a later run can tell its own commits from the student's. */
export const SYNC_COMMIT_PREFIX = 'docs(transcripts):';

export type RepoVisibility = 'public' | 'private' | 'unknown' | 'unchecked';

export interface GitSyncOptions {
  /** AUTO_GIT_SYNC: nothing happens unless the student turned it on */
  enabled: boolean;
  cwd: string;
  /** Paths to add and commit. Nothing outside them is ever committed. */
  paths: string[];
  /** Commit subject, after the fixed prefix */
  subject: string;
  /** The only branch uploads are made from */
  branch: string;
  remote?: string;
  /** Upload even when GitHub says the repository is public */
  allowPublic?: boolean;
  /** How to find out whether the remote is public (a test seam) */
  visibility?: (remoteUrl: string) => Promise<RepoVisibility>;
}

export type GitSyncStatus = 'pushed' | 'nothing' | 'skipped' | 'failed';

export interface GitSyncResult {
  status: GitSyncStatus;
  /** One sentence for the student, in Spanish */
  message: string;
}

interface GitOutput {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[]): GitOutput {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return {
    ok: run.status === 0,
    out: (run.stdout ?? '').trim(),
    err: ((run.stderr ?? '') || (run.error?.message ?? '')).trim(),
  };
}

const firstLine = (text: string) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'error desconocido';

/** The line that says why git failed ("To <url>" and hints come first in a rejected push, so firstLine hides the cause). */
const reason = (text: string) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /rejected|error:|fatal:|conflict/i.test(l)) ?? lines[0] ?? 'error desconocido';
};

/** owner/repo of a github.com remote (https or ssh), or null for any other host. */
export function parseGithubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/**
 * Ask GitHub, without credentials, whether the repository can be read by anyone: a public repository
 * answers 200, a private one answers 404. The URL is never logged (a remote may carry a token).
 */
export async function githubVisibility(remoteUrl: string, fetchImpl: typeof fetch = fetch): Promise<RepoVisibility> {
  const repo = parseGithubRepo(remoteUrl);
  if (!repo) return 'unchecked';
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'lecturevault' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) return 'public';
    if (res.status === 404) return 'private';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const skipped = (message: string): GitSyncResult => ({ status: 'skipped', message });
const failed = (message: string): GitSyncResult => ({ status: 'failed', message });

export async function syncToGit(options: GitSyncOptions): Promise<GitSyncResult> {
  const { cwd, paths, branch } = options;
  const remote = options.remote ?? 'origin';
  if (!options.enabled) return skipped('la subida automática está desactivada (AUTO_GIT_SYNC)');

  if (!git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) return skipped('esta carpeta no es un repositorio git');
  const current = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (current !== branch) return skipped(`estás en la rama «${current}» y solo se sube desde «${branch}»`);
  const url = git(cwd, ['remote', 'get-url', remote]);
  if (!url.ok) return skipped(`no hay un remoto «${remote}»`);

  if (!options.allowPublic) {
    const visibility = await (options.visibility ?? githubVisibility)(url.out);
    if (visibility === 'public') return skipped('el repositorio de GitHub es público: ponlo privado (o GIT_SYNC_ALLOW_PUBLIC=true si quieres publicarlo)');
    if (visibility === 'unknown') return skipped('no he podido comprobar si el repositorio es privado; no se sube nada');
  }

  // Commits waiting to go up must all be this function's own: anything else is the student's work
  const waiting = git(cwd, ['log', '--format=%s', `${remote}/${branch}..HEAD`]);
  if (!waiting.ok) return skipped(`no conozco «${remote}/${branch}»: ejecuta «git fetch ${remote}» una vez`);
  const ownPrefix = (subject: string) => subject.startsWith(SYNC_COMMIT_PREFIX);
  const pending = waiting.out.split(/\r?\n/).filter(Boolean);
  const foreign = pending.filter((s) => !ownPrefix(s));
  if (foreign.length > 0) {
    return skipped(`hay ${foreign.length === 1 ? 'un commit tuyo' : `${foreign.length} commits tuyos`} sin subir («${foreign[0]}»); súbelo(s) tú y esto se reanuda solo`);
  }

  let committed = false;
  const changes = git(cwd, ['status', '--porcelain', '--', ...paths]);
  if (!changes.ok) return failed(`git status falló: ${firstLine(changes.err)}`);
  if (changes.out) {
    const add = git(cwd, ['add', '--', ...paths]);
    if (!add.ok) return failed(`git add falló: ${firstLine(add.err)}`);
    // With paths, only those files are committed, whatever else the index holds
    const commit = git(cwd, ['commit', '-m', `${SYNC_COMMIT_PREFIX} ${options.subject}`, '--', ...paths]);
    if (!commit.ok) return failed(`git commit falló: ${firstLine(commit.err || commit.out)}`);
    committed = true;
  }

  if (pending.length === 0 && !committed) return { status: 'nothing', message: 'no había nada nuevo que subir' };

  let push = git(cwd, ['push', remote, branch]);
  if (!push.ok) {
    // The branch moved while we worked (the cloud run can last an hour): replay our own commits on top of it and retry once
    const rebase = git(cwd, ['pull', '--rebase', '--autostash', remote, branch]);
    if (rebase.ok) push = git(cwd, ['push', remote, branch]);
    else {
      git(cwd, ['rebase', '--abort']);
      return failed(`el push falló y no pude integrar los cambios de ${remote}/${branch} (queda commiteado en local): ${reason(rebase.err)}`);
    }
  }
  if (!push.ok) return failed(`el push falló (queda commiteado en local y se reintenta en la próxima): ${reason(push.err)}`);
  return { status: 'pushed', message: `subido a ${remote}/${branch}` };
}
