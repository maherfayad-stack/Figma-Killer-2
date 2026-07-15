import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';

/**
 * git checkpoints (playbook §4/P3, ADR-0018 item 11): the daemon auto-
 * commits each file-folder's OWN git repo — a NESTED repo living inside
 * `files/<name>/`, which the monorepo's OWN `.gitignore` already excludes
 * (`files/*` is user content, not studio source) — every N ops or after
 * 30s idle, message `studio: <op summary>`. Local only; remote push is
 * P6. This module never touches the monorepo's own git state (the daemon
 * process's cwd/repo is irrelevant here — `simple-git(fileFolderRoot)`
 * scopes every call to that one nested repo).
 */

const REQUIRED_IGNORE_LINES = ['node_modules/', '.studio/'] as const;

/**
 * Ensure the file-folder's `.gitignore` excludes `node_modules/` and
 * `.studio/` (task brief: "keep node_modules/.studio out of those
 * commits"). `.studio/canvas.json` IS real product data (frame layout),
 * but checkpoint commits are scoped to source-code changes only — the
 * spatial metadata has its own atomic-write persistence (`canvas-json.ts`)
 * and is deliberately excluded from this commit history to keep `git log`
 * readable as "what changed in the code", not noisy with every drag. This
 * is a P3-worker judgment call (task text is explicit about it, but it's
 * flagged here as a design decision the orchestrator may want to revisit
 * once history/checkpoint-restore UX (P6) exists — undoing to a checkpoint
 * would NOT restore canvas.json positions).
 *
 * Idempotent: only appends missing lines, never rewrites/reorders a
 * pre-existing `.gitignore` (a file-folder scaffolded before P3, or one a
 * user hand-edited, keeps its own content plus whatever's missing).
 */
export async function ensureFileFolderGitignore(fileFolderRoot: string): Promise<void> {
  const path = join(fileFolderRoot, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = REQUIRED_IGNORE_LINES.filter((l) => !existingLines.has(l));
  if (missing.length === 0) return;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const updated = `${existing}${separator}${missing.join('\n')}\n`;
  await writeFile(path, updated, 'utf8');
}

/**
 * `git init` the file-folder's own repo if it doesn't have one yet (a
 * NESTED repo — see module doc), then ensure `.gitignore` is in place.
 * Sets a local (repo-scoped, not global) `user.name`/`user.email` on a
 * freshly-initialized repo only — never overwrites an existing repo's
 * config — so checkpoint commits work out of the box on a machine with no
 * git identity configured, without touching the user's real git identity.
 */
export async function ensureFileFolderGitRepo(fileFolderRoot: string): Promise<SimpleGit> {
  const git = simpleGit(fileFolderRoot);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
    await git.addConfig('user.name', 'Canvas Code Studio', false, 'local');
    await git.addConfig('user.email', 'studio@localhost', false, 'local');
  }
  await ensureFileFolderGitignore(fileFolderRoot);
  return git;
}

function summarizeOps(summaries: readonly string[]): string {
  if (summaries.length === 1) return summaries[0]!;
  const shown = summaries.slice(0, 5);
  const more = summaries.length > shown.length ? ', …' : '';
  return `${summaries.length} ops (${shown.join(', ')}${more})`;
}

export interface CheckpointSchedulerOptions {
  /** Commit immediately once this many ops have accumulated since the
   * last checkpoint. */
  everyNOps: number;
  /** Otherwise, commit after this many ms of no further ops (reset on
   * every `noteOp` call). */
  idleMs: number;
}

/**
 * One `CheckpointScheduler` per file-folder. `noteOp` is called once per
 * successfully-applied canvas op (and once per undo/redo) with a short
 * human-readable summary; the scheduler decides whether to commit now
 * (N-ops threshold hit) or arm/reset an idle timer.
 */
export class CheckpointScheduler {
  private pendingSummaries: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fileFolderRoot: string,
    private readonly options: CheckpointSchedulerOptions,
  ) {}

  noteOp(summary: string): void {
    this.pendingSummaries.push(summary);
    if (this.idleTimer) clearTimeout(this.idleTimer);

    if (this.pendingSummaries.length >= this.options.everyNOps) {
      void this.commit();
      return;
    }

    this.idleTimer = setTimeout(() => {
      void this.commit();
    }, this.options.idleMs);
    // Never keep the daemon process alive just for a pending checkpoint.
    this.idleTimer.unref?.();
  }

  /** Commit whatever's pending right now (used by the idle timer, the
   * N-ops threshold, and `openProject().close()`'s final flush). A no-op
   * if nothing is pending, or if there's genuinely nothing to commit
   * (e.g. every pending "op" ended up being a no-op write).
   *
   * Checkpoints are a best-effort background feature, never a correctness
   * dependency (the real source of truth is the file-folder's OWN working
   * tree, written atomically by `op-apply.ts` regardless of git). A
   * failure here (git not installed, disk/permission issue, the
   * file-folder having been deleted out from under a scheduled idle
   * commit, etc.) must never crash the daemon or surface as an unhandled
   * rejection from a fire-and-forget `noteOp` call — swallow and log.
   */
  async commit(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.pendingSummaries.length === 0) return;
    const summaries = this.pendingSummaries;
    this.pendingSummaries = [];

    try {
      const git = await ensureFileFolderGitRepo(this.fileFolderRoot);
      await git.add(['.']);
      const status = await git.status();
      if (status.staged.length === 0) return; // nothing actually changed on disk

      await git.commit(`studio: ${summarizeOps(summaries)}`);
    } catch (err) {
      console.error(
        `@ccs/sync-daemon: git checkpoint commit failed for "${this.fileFolderRoot}" (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
