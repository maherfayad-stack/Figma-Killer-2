/**
 * agentCheckpointRevert — the user's revert of an agent turn (AI-7). Internal
 * to the checkpoint module; callers import `agentCheckpoints.ts`, whose doc
 * comment describes the whole design.
 *
 * ## Revert is the user's, and it is compare-and-swap
 *
 * {@link revertAgentCheckpoint} restores a file only while it still holds
 * EXACTLY what the agent left (its hash equals the post-image's). A file the
 * user edited afterwards — on the canvas, in an editor, or by a later turn —
 * is refused by name, never overwritten: the one-honest-target invariant,
 * applied to undo. "Revert turn" is all-or-nothing: if any file of the turn
 * moved on, nothing is restored, and the panel offers the per-file reverts that
 * still apply. The write goes through the ONE agent write gate
 * (`resolveAgentFilePath(…, 'write')` → `agentWriteRefusal`) and holds
 * `withProjectWriteLock`, so a revert can land nowhere an agent write could not:
 * never outside the project, never into `.studio/`, `.claude/`, `.git/`,
 * `prototype/`, a host-executed config, or through a link or a hard link.
 *
 * Every refusal has a code and a sentence ({@link revertBlocker} is also what
 * the panel's listing reports as each file's state).
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentHash, hasOtherHardLinks, resolveAgentFilePath, statIfPresent } from './agentFileAccess'
import {
  MAX_CHECKPOINT_FILE_BYTES,
  conversationTurnFilesDir,
  isCheckpointTurnId,
  readFileBytes,
  readFileEntries,
  verifiedBlob,
  writeStoreFile,
  type FileEntry,
} from './agentCheckpointStore'
import { withProjectWriteLock } from './projectWriteLock'

export type RevertRefusalCode =
  | 'not-found'
  | 'changed-since'
  | 'already-reverted'
  | 'not-checkpointed'
  | 'protected-path'
  | 'needs-user'
  | 'path-outside-project'
  | 'io-error'

export type RevertOutcome =
  | { readonly ok: true; readonly reverted: string[] }
  | { readonly ok: false; readonly code: RevertRefusalCode; readonly message: string; readonly files: Array<{ path: string; code: RevertRefusalCode; message: string }> }

function currentHashOf(dir: string, rel: string): string | null {
  const abs = join(dir, ...rel.split('/'))
  const now = readFileBytes(abs)
  if (now === null || !now.existed) return null
  return now.hash ?? contentHash(readFileSync(abs))
}

/** Why `entry` cannot be reverted right now, or `null` when it can. */
export function revertBlocker(dir: string, filesDir: string, entry: FileEntry): { code: RevertRefusalCode; message: string } | null {
  if (entry.reverted) return { code: 'already-reverted', message: `"${entry.pre.path}" was already reverted.` }
  if (entry.pre.withheld) {
    return { code: 'not-checkpointed', message: `"${entry.pre.path}" is a credential file, so Studio keeps no copy of it and cannot put it back.` }
  }
  if (entry.pre.existed === null) {
    return { code: 'not-checkpointed', message: `Studio could not record what "${entry.pre.path}" held before this turn, so it cannot put it back.` }
  }
  if (entry.pre.existed && entry.pre.tooLarge) {
    return { code: 'not-checkpointed', message: `"${entry.pre.path}" was too large to checkpoint (over ${MAX_CHECKPOINT_FILE_BYTES / 1024 / 1024} MB), so it cannot be reverted here.` }
  }
  if (entry.pre.existed && verifiedBlob(filesDir, entry.key, 'pre', entry.pre.hash) === null) {
    return { code: 'not-checkpointed', message: `The stored copy of "${entry.pre.path}" is missing or does not match its record, so Studio will not restore it.` }
  }
  if (currentHashOf(dir, entry.pre.path) !== entry.post.hash) {
    return {
      code: 'changed-since',
      message: `"${entry.pre.path}" changed after this turn wrote it — by you, or by a later turn. Reverting would throw that change away, so it was left alone.`,
    }
  }
  return null
}

/**
 * Put back what `turnId` changed: every file of the turn (`paths` omitted —
 * all-or-nothing), or just `paths`. Each file must still hold exactly the
 * agent's post-image; see the module doc. Holds the project write lock across
 * every check and write, and restores anything already written when a later
 * write fails.
 */
export async function revertAgentCheckpoint(
  dir: string,
  userKey: string,
  conversationId: string,
  turnId: string,
  paths?: readonly string[],
  /** Test seam: runs right before each file's write — the moment an editor outside Studio could still save. */
  options: { beforeWrite?: (abs: string) => void } = {},
): Promise<RevertOutcome> {
  if (!isCheckpointTurnId(turnId)) return refused('not-found', 'No such turn.', [])
  return withProjectWriteLock(dir, () => {
    // A turn is bound to its conversation: one named from another is not found
    // (and so cannot slip past that conversation's "still streaming" 409).
    const filesDir = conversationTurnFilesDir(dir, userKey, conversationId, turnId)
    if (filesDir === null) return refused('not-found', 'No such turn in this conversation.', [])
    const all = readFileEntries(filesDir)
    const selected = paths === undefined ? all : all.filter((entry) => paths.includes(entry.pre.path))
    const missing = paths === undefined ? [] : paths.filter((path) => !all.some((entry) => entry.pre.path === path))
    if (selected.length === 0 || missing.length > 0) {
      return refused('not-found', missing.length > 0 ? `This turn did not change ${missing.map((p) => `"${p}"`).join(', ')}.` : 'This turn changed no files.', [])
    }

    // Every check first — nothing is written unless every selected file passes.
    const plans: Array<{ entry: FileEntry; abs: string; restore: Buffer | null }> = []
    const problems: Array<{ path: string; code: RevertRefusalCode; message: string }> = []
    for (const entry of selected) {
      const target = resolveAgentFilePath(dir, entry.pre.path, 'write')
      if (!target.ok) {
        problems.push({ path: entry.pre.path, code: target.code, message: target.message })
        continue
      }
      const stat = statIfPresent(target.abs)
      if (stat && hasOtherHardLinks(stat)) {
        problems.push({ path: entry.pre.path, code: 'protected-path', message: `"${entry.pre.path}" has other hard-linked names on disk, so restoring it would change them too.` })
        continue
      }
      const blocker = revertBlocker(dir, filesDir, entry)
      if (blocker) {
        problems.push({ path: entry.pre.path, ...blocker })
        continue
      }
      // Verified by `revertBlocker` just above: these bytes hash to the record's pre-image.
      plans.push({ entry, abs: target.abs, restore: entry.pre.existed ? verifiedBlob(filesDir, entry.key, 'pre', entry.pre.hash) : null })
    }
    if (problems.length > 0) {
      const first = problems[0]!
      const message = problems.length === 1
        ? `Nothing was reverted. ${first.message}`
        : `Nothing was reverted: ${problems.length} files cannot be put back (${problems.map((p) => `"${p.path}"`).join(', ')}). ${first.message}`
      return refused(first.code, message, problems)
    }

    const done: Array<{ abs: string; agentBytes: Buffer }> = []
    try {
      for (const plan of plans) {
        options.beforeWrite?.(plan.abs)
        const agentBytes = readFileSync(plan.abs)
        // Compare-and-swap, again, right before the write: an editor outside
        // Studio does not take the project lock (review of #251, F3).
        if (contentHash(agentBytes) !== plan.entry.post.hash) throw new ChangedSinceError(plan.entry.pre.path)
        if (plan.restore === null) unlinkSync(plan.abs)
        else writeFileSync(plan.abs, plan.restore)
        done.push({ abs: plan.abs, agentBytes })
      }
    } catch (err) {
      for (const { abs, agentBytes } of done) {
        try {
          writeFileSync(abs, agentBytes)
        } catch (restoreErr) {
          console.error('[agentCheckpointRevert] could not undo a partial revert:', restoreErr)
        }
      }
      if (err instanceof ChangedSinceError) {
        const message = `Nothing was reverted. "${err.path}" changed after this turn wrote it — by you, or by a later turn — so it was left alone.`
        return refused('changed-since', message, [{ path: err.path, code: 'changed-since', message }])
      }
      const detail = err instanceof Error ? err.message : String(err)
      return refused('io-error', `Reverting failed (${detail}); every file already restored was put back to the agent's version.`, [])
    }
    const atMs = Date.now()
    for (const plan of plans) {
      writeStoreFile(join(filesDir, `${plan.entry.key}.reverted.json`), JSON.stringify({ atMs }))
    }
    return { ok: true, reverted: plans.map((plan) => plan.entry.pre.path) }
  })
}

/** A file that changed between the checks and its write. */
class ChangedSinceError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`"${path}" changed since the revert was checked.`)
    this.name = 'ChangedSinceError'
    this.path = path
  }
}

function refused(code: RevertRefusalCode, message: string, files: Array<{ path: string; code: RevertRefusalCode; message: string }>): RevertOutcome {
  return { ok: false, code, message, files }
}
