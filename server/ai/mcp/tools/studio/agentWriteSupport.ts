/**
 * The steps every agent-facing SOURCE write shares, in one place: the file
 * tools (`fileWriteTools.ts` — `studio_write_file`, `studio_edit_file`,
 * `studio_edit_files`) and the token codemod (`setTokensTool.ts` —
 * `studio_set_tokens`).
 *
 * Split out of `fileWriteTools.ts` when the second writer arrived, because a
 * second copy of "read the target, check its hash, refuse a hard link, write,
 * restore on a failed batch, log the turn write, push the reload" is exactly
 * how two writers drift on one of those steps. Every caller still resolves its
 * target through `resolveAgentFilePath(dir, path, 'write')` — the ONE
 * containment rule and the ONE agent write gate (`agentWriteRefusal`) — and
 * holds `withProjectWriteLock` across its check and its write. This module is
 * what happens between those two.
 */
import { writeFileSync } from 'node:fs'
import { toolRefusal, type ToolRefusal } from '@core/ai'
import type { ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { AGENT_FILE_MAX_BYTES } from './fileReadTools'
import { pushStudioDiskChange } from './liveReloadPush'
import {
  hasOtherHardLinks,
  readTextFile,
  statIfPresent,
  type AgentFileTarget,
} from '../../../../handlers/studio/agentFileAccess'
import { appendTurnWrite } from '../../../../handlers/studio/turnWriteLog'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'

/** The open project this turn writes into, or the refusal when there is none. */
export function turnProject(ctx: ToolContext): string | ToolRefusal {
  if (!ctx.workspaceDir) {
    return toolRefusal('no-open-project', 'No Studio project is open for this turn, so there is nowhere to write.', {
      remedy: 'Ask the user to open the project in Studio and send the message again.',
    })
  }
  return resolveToolProjectDir(undefined, ctx)
}

/** Text content a write may land, or the refusal. */
export function checkContent(content: string, rel: string): ToolRefusal | null {
  if (content.includes('\0')) {
    return toolRefusal('not-text', `The content for "${rel}" contains a NUL character, so it is not text.`, {
      remedy: 'Images, fonts and other binary files go through studio_upload_asset or studio_fetch_remote_asset.',
    })
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > AGENT_FILE_MAX_BYTES) {
    return toolRefusal('file-too-large', `The content for "${rel}" is ${bytes.toLocaleString('en-US')} bytes, over the ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')}-byte cap.`, {
      remedy: 'Split it: move a large section into its own component file, or its styles into their own stylesheet.',
    })
  }
  return null
}

export function staleRefusal(rel: string, expectedHash: string, actualHash: string): ToolRefusal {
  return toolRefusal('stale-source', `"${rel}" changed since you read it (you passed hash ${expectedHash}; it is now ${actualHash}), so writing would discard a change you never saw.`, {
    remedy: 'Read it again with studio_read_file and rebuild the change against what is there now.',
    details: { path: rel, hash: actualHash },
  })
}

/**
 * The current text of an existing target, with every refusal a write shares:
 * not a regular file, a hard link, not text, over the cap, stale. `null`
 * content means the file does not exist yet.
 */
export function currentText(
  target: AgentFileTarget,
  expectedHash: string | undefined,
): { content: string | null; hash: string | null } | ToolRefusal {
  const stat = statIfPresent(target.abs)
  if (!stat) {
    if (expectedHash !== undefined) {
      return toolRefusal('stale-source', `"${target.rel}" does not exist any more, but you passed a hash for it.`, {
        remedy: 'List the folder with studio_list_files to see what is there now.',
      })
    }
    return { content: null, hash: null }
  }
  if (!stat.isFile()) return toolRefusal('not-a-file', `"${target.rel}" is a directory, not a file.`)
  if (hasOtherHardLinks(stat)) {
    return toolRefusal('protected-path', `"${target.rel}" has other hard-linked names on disk, so writing it would change them too — possibly outside the project.`)
  }
  const read = readTextFile(target.abs, AGENT_FILE_MAX_BYTES)
  if (read.kind === 'too-large') {
    return toolRefusal('file-too-large', `"${target.rel}" is ${read.bytes.toLocaleString('en-US')} bytes, over the ${AGENT_FILE_MAX_BYTES.toLocaleString('en-US')}-byte cap for the file tools.`)
  }
  if (read.kind === 'not-text') return toolRefusal('not-text', `"${target.rel}" ${read.reason}, so a text tool cannot rewrite it.`)
  if (read.kind !== 'text') return toolRefusal('not-a-file', `"${target.rel}" could not be read as a file.`)
  if (expectedHash !== undefined && expectedHash !== read.hash) return staleRefusal(target.rel, expectedHash, read.hash)
  return { content: read.content, hash: read.hash }
}

export function isRefusal(value: unknown): value is ToolRefusal {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

/** Record every written file in the turn log and push one reload naming all of them. Runs after the bytes landed. */
export function afterWrites(dir: string, ctx: ToolContext, written: readonly AgentFileTarget[]): void {
  if (written.length === 0) return
  const userKey = studioAgentUserKey(ctx.userId)
  for (const target of written) appendTurnWrite(dir, userKey, target.abs)
  pushStudioDiskChange(dir, written.map((target) => target.rel))
}

/** One file's planned rewrite: what it holds now and what it will hold. */
export interface PlannedFileWrite {
  readonly target: AgentFileTarget
  readonly original: string
  readonly next: string
}

/**
 * Write every planned file, ALL-OR-NOTHING: a failure part-way restores every
 * file already written, so a batch is atomic on disk and not only in the
 * checks that planned it. Unchanged plans are skipped. Logs and reloads what
 * actually changed. Returns the refusal on a failed batch, else the targets
 * written. Call inside `withProjectWriteLock`, after every check passed.
 */
export function commitPlannedWrites(
  dir: string,
  ctx: ToolContext,
  plans: Iterable<PlannedFileWrite>,
): { written: AgentFileTarget[] } | ToolRefusal {
  const written: PlannedFileWrite[] = []
  try {
    for (const plan of plans) {
      if (plan.next === plan.original) continue
      writeFileSync(plan.target.abs, plan.next, 'utf8')
      written.push(plan)
    }
  } catch (err) {
    const unrestored: string[] = []
    for (const { target, original } of written) {
      try {
        writeFileSync(target.abs, original, 'utf8')
      } catch (restoreErr) {
        console.error('[studio:mcp] could not restore a file after a failed batch write:', restoreErr)
        unrestored.push(target.rel)
      }
    }
    // A file that could not be restored DID change: log it and reload it like any write.
    afterWrites(dir, ctx, written.map(({ target }) => target).filter((target) => unrestored.includes(target.rel)))
    return toolRefusal('io-error', `Writing the batch failed (${err instanceof Error ? err.message : String(err)}). ${unrestored.length === 0 ? 'Every file already written was restored, so nothing changed.' : `These files could not be restored and hold the new content: ${unrestored.join(', ')}.`}`)
  }
  const targets = written.map(({ target }) => target)
  afterWrites(dir, ctx, targets)
  return { written: targets }
}
