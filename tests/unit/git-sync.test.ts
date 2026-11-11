import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncToGit, parseGithubRepo, githubVisibility, SYNC_COMMIT_PREFIX, type GitSyncOptions } from '../../src/utils/git-sync.js';

// Real git on Windows takes a second or two per command: these tests run whole repositories
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

describe('syncToGit', () => {
  let tmp: string;
  let remote: string;
  let work: string;

  const write = (rel: string, content = 'x') => {
    const file = path.join(work, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const options = (extra: Partial<GitSyncOptions> = {}): GitSyncOptions => ({
    enabled: true,
    cwd: work,
    paths: ['data/transcripts/clase1'],
    subject: 'update notes and transcript for clase1',
    branch: 'main',
    visibility: async () => 'unchecked',
    ...extra,
  });
  const remoteSubjects = () => git(remote, 'log', 'main', '--format=%s').split('\n');
  const remoteFiles = () => git(remote, 'ls-tree', '-r', 'main', '--name-only').split('\n');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-gitsync-'));
    remote = path.join(tmp, 'remote.git');
    work = path.join(tmp, 'work');
    fs.mkdirSync(remote);
    git(remote, 'init', '--bare', '-b', 'main');
    git(tmp, 'clone', remote, 'work');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'checkout', '-b', 'main');
    write('README.md', 'hello');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'initial');
    git(work, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads only the transcript folder and leaves what the student has staged alone', async () => {
    write('src-change.ts', 'work in progress');
    git(work, 'add', 'src-change.ts');
    write('data/transcripts/clase1/clase1.json', '{}');

    const result = await syncToGit(options());

    expect(result.status).toBe('pushed');
    expect(remoteSubjects()[0]).toBe(`${SYNC_COMMIT_PREFIX} update notes and transcript for clase1`);
    expect(remoteFiles()).toContain('data/transcripts/clase1/clase1.json');
    expect(remoteFiles()).not.toContain('src-change.ts');
    // still staged, not committed anywhere
    expect(git(work, 'status', '--porcelain')).toContain('A  src-change.ts');
  });

  it('does nothing unless it was turned on', async () => {
    write('data/transcripts/clase1/clase1.json');
    const result = await syncToGit(options({ enabled: false }));
    expect(result.status).toBe('skipped');
    expect(git(work, 'status', '--porcelain')).toContain('data/');
    expect(remoteSubjects()).toEqual(['initial']);
  });

  it('never uploads from a branch other than the configured one, and commits nothing there', async () => {
    git(work, 'checkout', '-b', 'feat/algo');
    write('data/transcripts/clase1/clase1.json');

    const result = await syncToGit(options());

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('feat/algo');
    expect(git(work, 'log', '--format=%s')).toBe('initial');
    expect(remoteSubjects()).toEqual(['initial']);
  });

  it("refuses to push the student's own unpushed commits", async () => {
    write('mine.ts');
    git(work, 'add', 'mine.ts');
    git(work, 'commit', '-m', 'feat: algo sin terminar');
    write('data/transcripts/clase1/clase1.json');

    const result = await syncToGit(options());

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('feat: algo sin terminar');
    expect(remoteSubjects()).toEqual(['initial']);
    expect(git(work, 'status', '--porcelain')).toContain('data/'); // not even committed locally
  });

  it('retries an earlier push that failed, even with nothing new', async () => {
    write('data/transcripts/clase1/clase1.json');
    git(work, 'add', 'data');
    git(work, 'commit', '-m', `${SYNC_COMMIT_PREFIX} update notes and transcript for clase1`);

    const result = await syncToGit(options());

    expect(result.status).toBe('pushed');
    expect(remoteSubjects()[0]).toContain(SYNC_COMMIT_PREFIX);
  });

  it('says so when there is nothing to upload', async () => {
    const result = await syncToGit(options());
    expect(result.status).toBe('nothing');
  });

  const otherPush = (file: string, content: string) => {
    const other = path.join(tmp, 'other');
    if (!fs.existsSync(other)) {
      git(tmp, 'clone', remote, 'other');
      git(other, 'config', 'user.email', 'o@example.com');
      git(other, 'config', 'user.name', 'Other');
      git(other, 'config', 'commit.gpgsign', 'false');
    }
    fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
    fs.writeFileSync(path.join(other, file), content);
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'other');
    git(other, 'push', 'origin', 'main');
    return other;
  };

  it('integrates a branch that moved while it worked and pushes', async () => {
    otherPush('other.txt', 'x');
    write('data/transcripts/clase1/clase1.json');

    const result = await syncToGit(options());

    expect(result.status).toBe('pushed');
    const check = path.join(tmp, 'check');
    git(tmp, 'clone', remote, 'check');
    expect(fs.existsSync(path.join(check, 'other.txt'))).toBe(true);
    expect(fs.existsSync(path.join(check, 'data/transcripts/clase1/clase1.json'))).toBe(true);
  });

  it('reports a push it cannot integrate instead of hiding it', async () => {
    otherPush('data/transcripts/clase1/clase1.json', 'de otro');
    write('data/transcripts/clase1/clase1.json');

    const result = await syncToGit(options());

    expect(result.status).toBe('failed');
    expect(result.message).toContain('push');
    // it stays committed locally for the next try, and the tree is not left mid-rebase
    expect(git(work, 'log', '-1', '--format=%s')).toContain(SYNC_COMMIT_PREFIX);
    expect(fs.existsSync(path.join(work, '.git', 'rebase-merge'))).toBe(false);
  });

  describe('public repositories', () => {
    it('refuses a repository GitHub says is public, and commits nothing', async () => {
      write('data/transcripts/clase1/clase1.json');
      const result = await syncToGit(options({ visibility: async () => 'public' }));
      expect(result.status).toBe('skipped');
      expect(result.message).toContain('público');
      expect(git(work, 'status', '--porcelain')).toContain('data/');
    });

    it('refuses when it cannot tell', async () => {
      write('data/transcripts/clase1/clase1.json');
      const result = await syncToGit(options({ visibility: async () => 'unknown' }));
      expect(result.status).toBe('skipped');
    });

    it('uploads to a public repository only when the student allows it', async () => {
      write('data/transcripts/clase1/clase1.json');
      const result = await syncToGit(options({ visibility: async () => 'public', allowPublic: true }));
      expect(result.status).toBe('pushed');
    });

    it('uploads when GitHub confirms the repository is private', async () => {
      write('data/transcripts/clase1/clase1.json');
      const result = await syncToGit(options({ visibility: async () => 'private' }));
      expect(result.status).toBe('pushed');
    });
  });
});

describe('GitHub visibility', () => {
  it('reads owner and repo from https and ssh remotes, and ignores other hosts', () => {
    expect(parseGithubRepo('https://github.com/example-user/lecturevault.git')).toEqual({ owner: 'example-user', repo: 'lecturevault' });
    expect(parseGithubRepo('https://ghp_token@github.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('git@github.com:o/r.git')).toEqual({ owner: 'o', repo: 'r' });
    expect(parseGithubRepo('https://gitlab.com/o/r.git')).toBeNull();
    expect(parseGithubRepo('C:\\repos\\remote.git')).toBeNull();
  });

  const answer = (status: number): typeof fetch => (async () => new Response('{}', { status })) as typeof fetch;

  it('treats 200 as public and 404 as private', async () => {
    expect(await githubVisibility('https://github.com/o/r.git', answer(200))).toBe('public');
    expect(await githubVisibility('https://github.com/o/r.git', answer(404))).toBe('private');
  });

  it('does not guess on rate limits, errors or no network', async () => {
    expect(await githubVisibility('https://github.com/o/r.git', answer(403))).toBe('unknown');
    expect(await githubVisibility('https://github.com/o/r.git', answer(500))).toBe('unknown');
    expect(await githubVisibility('https://github.com/o/r.git', (async () => { throw new Error('offline'); }) as typeof fetch)).toBe('unknown');
  });

  it('does not ask about other hosts', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    expect(await githubVisibility('https://gitlab.com/o/r.git', spy)).toBe('unchecked');
    expect(called).toBe(false);
  });
});
