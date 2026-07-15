import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';
import { CheckpointScheduler, ensureFileFolderGitRepo, ensureFileFolderGitignore } from './git-checkpoint.js';

/** `git log` THROWS (rather than returning an empty list) on a repo with
 * no commits yet — a real git behavior, not a bug. Spawning `git` (a real
 * child process) for every step of `ensureFileFolderGitRepo` + `add` +
 * `status` + `commit` takes a variable, load-dependent amount of wall
 * time, so polling (like the pre-existing `watcher.test.ts` flake
 * discipline: "deflake with higher tolerance") rather than a fixed sleep
 * is what makes this deterministic instead of occasionally racing ahead
 * of the real commit. */
async function waitForCommit(root: string, timeout = 5000): Promise<import('simple-git').LogResult> {
  return vi.waitFor(
    async () => {
      const log = await simpleGit(root).log();
      expect(log.total).toBeGreaterThanOrEqual(1);
      return log;
    },
    { timeout, interval: 50 },
  );
}

describe('ensureFileFolderGitignore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccs-gitignore-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a .gitignore with the required lines when none exists', async () => {
    await ensureFileFolderGitignore(root);
    const content = await readFile(join(root, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.studio/');
  });

  it('preserves existing content and only appends missing lines', async () => {
    await writeFile(join(root, '.gitignore'), 'dist/\n.vite/\n');
    await ensureFileFolderGitignore(root);
    const content = await readFile(join(root, '.gitignore'), 'utf8');
    expect(content).toContain('dist/');
    expect(content).toContain('.vite/');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.studio/');
  });

  it('is idempotent (does not duplicate lines on a second call)', async () => {
    await ensureFileFolderGitignore(root);
    await ensureFileFolderGitignore(root);
    const content = await readFile(join(root, '.gitignore'), 'utf8');
    const occurrences = content.split('\n').filter((l) => l.trim() === 'node_modules/').length;
    expect(occurrences).toBe(1);
  });
});

describe('ensureFileFolderGitRepo', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccs-gitrepo-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('git-inits a fresh repo and sets a local commit identity', async () => {
    const git = await ensureFileFolderGitRepo(root);
    expect(await git.checkIsRepo()).toBe(true);
    const name = (await git.getConfig('user.name')).value;
    const email = (await git.getConfig('user.email')).value;
    expect(name).toBe('Canvas Code Studio');
    expect(email).toBe('studio@localhost');
  });

  it('does not overwrite an existing repo\'s identity', async () => {
    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.name', 'Real Human', false, 'local');
    await git.addConfig('user.email', 'real@example.com', false, 'local');

    await ensureFileFolderGitRepo(root);
    const name = (await git.getConfig('user.name')).value;
    expect(name).toBe('Real Human');
  });
});

describe('CheckpointScheduler', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ccs-checkpoint-'));
    await mkdir(join(root, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('commits immediately once the N-ops threshold is hit, with a "studio: " message', async () => {
    await writeFile(join(root, 'src', 'a.tsx'), 'export const A = 1;\n');
    const scheduler = new CheckpointScheduler(root, { everyNOps: 2, idleMs: 60_000 });

    scheduler.noteOp('set-text a');
    scheduler.noteOp('set-text b');
    // noteOp is synchronous scheduling but commit() spawns several real
    // `git` child processes — poll rather than guess a fixed delay.
    const log = await waitForCommit(root);
    expect(log.total).toBe(1);
    expect(log.latest?.message).toMatch(/^studio: /);
    scheduler.dispose();
  });

  it('commits after the idle window even below the N-ops threshold', async () => {
    await writeFile(join(root, 'src', 'a.tsx'), 'export const A = 1;\n');
    const scheduler = new CheckpointScheduler(root, { everyNOps: 100, idleMs: 100 });

    scheduler.noteOp('set-text a');
    const log = await waitForCommit(root);
    expect(log.total).toBe(1);
    scheduler.dispose();
  });

  it('a manual commit() flush is a no-op when nothing is pending', async () => {
    const scheduler = new CheckpointScheduler(root, { everyNOps: 100, idleMs: 60_000 });
    await scheduler.commit();
    const git = simpleGit(root);
    expect(await git.checkIsRepo()).toBe(false);
    scheduler.dispose();
  });
});
