/**
 * agentCheckpoints — a pre-image of every file an agent turn writes, so the
 * USER can see what the turn changed and take it back (AI-7).
 *
 * ## What is recorded, and when
 *
 * A turn begins ({@link beginAgentCheckpointTurn}) right where the turn write
 * log is reset — `claudeCli.ts` before its spawn, `studioHttpTurn.ts` for an
 * HTTP driver. From then on every agent write is bracketed:
 *
 *   - **before** the bytes land, {@link captureAgentPreImage} copies what the
 *     file held (or records that it did not exist). The FIRST capture of a path
 *     in a turn wins — a file the agent writes five times reverts to what it
 *     was before the first write, not before the fifth.
 *   - **after**, {@link recordAgentPostImage} copies what the agent left. The
 *     LAST record wins, so the post-image is the turn's final word on the file.
 *
 * Both paths reach the same two calls. The `claude` CLI writes with its own
 * native `Write`/`Edit`, so the pre-image is taken by its `PreToolUse` hook
 * (`hooks/denyControlPlaneWrite.ts`, right after the write gate allows the
 * call) and the post-image by its `PostToolUse` hook
 * (`hooks/recordToolWrite.ts`). The HTTP drivers write through Studio's own
 * file tools, which bracket each write themselves (`agentWriteSupport.ts`),
 * inside the project write lock.
 *
 * ## Which turn a write belongs to
 *
 * A hook is a separate process, and a warm CLI session keeps ONE process (and
 * one environment) across many turns — so the turn id cannot ride the
 * environment. What rides it is the CONVERSATION (`STUDIO_AGENT_CONVERSATION_KEY`,
 * set by `claudeCli.ts` at spawn; the warm pool is keyed per conversation, so
 * that value never changes under a live process), and the conversation's
 * current turn is a file, `current-<conversationKey>.json`, rewritten at each
 * turn's start. The HTTP tools read the same file through `ctx.conversationId`.
 *
 * ## Revert is the user's, and it is compare-and-swap
 *
 * {@link revertAgentCheckpoint} restores a file only while it still holds
 * EXACTLY what the agent left, all-or-nothing, through the ONE agent write
 * gate and under `withProjectWriteLock` — see `agentCheckpointRevert.ts`.
 *
 * ## Where it lives
 *
 * `.studio/agent-checkpoints/<userKey>/<turnId>/` — per account, like the turn
 * write log (`agentUserScope.ts`), so one person's revert can never reach
 * another's turn. Not under `.studio/cache/`: a pre-image is the only copy of
 * what the file was, and nothing regenerates it. `.studio/` is excluded from
 * Studio's own commit staging (`gitOperations.ts`, `EXCLUDED_WORKSPACE_DIR_NAMES`)
 * and from every scaffolded `.gitignore`; this repo's `.gitignore` names the
 * folder for its own fixtures. The newest {@link MAX_TURNS_KEPT} turns per
 * account are kept; files over {@link MAX_CHECKPOINT_FILE_BYTES} are listed but
 * carry no bytes, so they cannot be reverted and say so.
 *
 * ## The store does not trust its own files (review of #251, F1)
 *
 * Nothing in the store follows a link, and nothing read back is believed on
 * its word: real directories only, no-follow single-link capped reads, images
 * that must hash to their record, turns bound to one conversation, and
 * temp-and-rename writes — see `agentCheckpointStore.ts`.
 *
 * Credential files (`isSecretBearingFileName`) never have their bytes kept at
 * all: they are listed as changed and are not revertable. The agent write gate
 * refuses them on both paths anyway (`agentWriteRefusal`); this is the second
 * layer.
 *
 * Every function here is fail-soft on the CAPTURE side (a checkpoint that
 * could not be taken must never block the write it describes — the file then
 * shows as "not revertable") and honest on the REVERT side (every refusal has
 * a code and a sentence).
 *
 * ## Module layout
 *
 * This file is the checkpoint module's public entry: turn start, capture,
 * listing and diff. `agentCheckpointStore.ts` owns the on-disk store and
 * `agentCheckpointRevert.ts` the revert; both are internal, and everything
 * outside the module imports from here.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSecretBearingFileName } from '@core/page-parser'
import { contentHash, nonTextReason } from './agentFileAccess'
import { unifiedLineDiff } from './agentCheckpointDiff'
import { revertBlocker } from './agentCheckpointRevert'
import {
  CONVERSATION_KEY_RE,
  MAX_FILES_PER_TURN,
  PreRecordSchema,
  RECORD_FILE_RE,
  conversationCheckpointKey,
  conversationTurnFilesDir,
  currentTurnId,
  isCheckpointTurnId,
  listTurnRecords,
  lstatOrNull,
  pathKey,
  projectRel,
  pruneOldTurns,
  readFileBytes,
  readFileEntries,
  readRecord,
  storeDir,
  turnFilesDir,
  verifiedBlob,
  writeStoreFile,
  type PostRecord,
  type PreRecord,
  type TurnRecord,
} from './agentCheckpointStore'

export {
  MAX_CHECKPOINT_FILE_BYTES,
  MAX_TURNS_KEPT,
  conversationCheckpointKey,
  isCheckpointTurnId,
} from './agentCheckpointStore'
export { revertAgentCheckpoint, type RevertOutcome, type RevertRefusalCode } from './agentCheckpointRevert'

/** The environment variable `claudeCli.ts` sets on the CLI subprocess and the hooks read back. */
export const STUDIO_AGENT_CONVERSATION_KEY_ENV = 'STUDIO_AGENT_CONVERSATION_KEY'

/** The conversation key a hook subprocess should use, or `null` when the CLI did not set one (a hook spawned by an older server). */
export function conversationCheckpointKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STUDIO_AGENT_CONVERSATION_KEY_ENV]
  return raw && CONVERSATION_KEY_RE.test(raw) ? raw : null
}

// ---------------------------------------------------------------------------
// Capture — fail-soft, never blocks the write it describes
// ---------------------------------------------------------------------------

export interface CheckpointTurnStart {
  readonly conversationId: string
  readonly turnId: string
  readonly atMs?: number
}

/**
 * Open a checkpoint for this turn and make it the conversation's current one.
 * Prunes the account's oldest turns past {@link MAX_TURNS_KEPT}. Never throws.
 */
export function beginAgentCheckpointTurn(dir: string, userKey: string, turn: CheckpointTurnStart): void {
  if (!isCheckpointTurnId(turn.turnId)) return
  try {
    const startedAtMs = turn.atMs ?? Date.now()
    const root = storeDir(dir, [userKey], true)
    const turnPath = storeDir(dir, [userKey, turn.turnId], true)
    if (root === null || turnPath === null || storeDir(dir, [userKey, turn.turnId, 'files'], true) === null) {
      console.error('[agentCheckpoints] the checkpoint store is not a plain directory inside the project — this turn takes no checkpoint.')
      return
    }
    const record: TurnRecord = { turnId: turn.turnId, conversationId: turn.conversationId, startedAtMs }
    writeStoreFile(join(turnPath, 'turn.json'), JSON.stringify(record))
    writeStoreFile(
      join(root, `current-${conversationCheckpointKey(turn.conversationId)}.json`),
      JSON.stringify({ turnId: turn.turnId, startedAtMs }),
    )
    pruneOldTurns(dir, userKey)
  } catch (err) {
    console.error('[agentCheckpoints] could not open a checkpoint for this turn — its writes will not be revertable:', err)
  }
}

export interface CaptureOptions {
  /** The caller KNOWS the file did not exist before its write (an asset landed under a fresh name). */
  readonly knownAbsent?: boolean
}

/**
 * Record what `abs` holds BEFORE this turn writes it — once per path per
 * turn. `conversationKey` is {@link conversationCheckpointKey} of the turn's
 * conversation. A no-op when no checkpoint turn is open. Never throws.
 */
export function captureAgentPreImage(
  dir: string,
  userKey: string,
  conversationKey: string,
  abs: string,
  options: CaptureOptions = {},
): void {
  try {
    const turnId = currentTurnId(dir, userKey, conversationKey)
    if (turnId === null) return
    const rel = projectRel(dir, abs)
    if (rel === null) return
    const filesDir = turnFilesDir(dir, userKey, turnId)
    if (filesDir === null) return
    const key = pathKey(rel)
    const recordFile = join(filesDir, `${key}.json`)
    if (lstatOrNull(recordFile) !== null) return
    if (readdirSync(filesDir).filter((name) => RECORD_FILE_RE.test(name)).length >= MAX_FILES_PER_TURN) return

    const now = options.knownAbsent ? { existed: false, bytes: null, size: 0, hash: null } : readFileBytes(abs)
    if (now === null) return
    const withheld = isCredentialPath(rel)
    if (now.bytes !== null && !withheld) writeStoreFile(join(filesDir, `${key}.pre`), now.bytes)
    const record: PreRecord = {
      path: rel,
      existed: now.existed,
      hash: withheld ? null : now.hash,
      bytes: now.size,
      tooLarge: now.existed && now.bytes === null,
      ...(withheld ? { withheld: true } : {}),
      atMs: Date.now(),
    }
    // `wx`: two concurrent captures of one path (parallel tool calls) — the first claim wins.
    writeFileSync(recordFile, JSON.stringify(record), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    console.error('[agentCheckpoints] could not capture a pre-image — this write will not be revertable:', err)
  }
}

/**
 * Record what `abs` holds AFTER this turn wrote it. The last record in a turn
 * wins. A write whose pre-image was never captured (a hook that did not run)
 * is recorded with `existed: null`, so it lists as changed but never offers a
 * revert it could not honestly perform. Never throws.
 */
export function recordAgentPostImage(dir: string, userKey: string, conversationKey: string, abs: string): void {
  try {
    const turnId = currentTurnId(dir, userKey, conversationKey)
    if (turnId === null) return
    const rel = projectRel(dir, abs)
    if (rel === null) return
    const filesDir = turnFilesDir(dir, userKey, turnId)
    if (filesDir === null) return
    const key = pathKey(rel)
    const now = readFileBytes(abs)
    if (now === null || !now.existed) return
    const withheld = isCredentialPath(rel)
    if (lstatOrNull(join(filesDir, `${key}.json`)) === null) {
      const unknown: PreRecord = { path: rel, existed: null, hash: null, bytes: 0, tooLarge: false, ...(withheld ? { withheld: true } : {}), atMs: Date.now() }
      writeFileSync(join(filesDir, `${key}.json`), JSON.stringify(unknown), { flag: 'wx' })
    }
    if (now.bytes !== null && !withheld) writeStoreFile(join(filesDir, `${key}.post`), now.bytes)
    const pre = readRecord(join(filesDir, `${key}.json`), PreRecordSchema)
    const counts = withheld || now.bytes === null || pre === null ? { added: null, removed: null } : changeCounts(filesDir, key, pre, now.bytes)
    const post: PostRecord = {
      hash: now.hash ?? contentHash(readFileSync(abs)),
      bytes: now.size,
      tooLarge: now.bytes === null,
      ...counts,
      atMs: Date.now(),
    }
    writeStoreFile(join(filesDir, `${key}.post.json`), JSON.stringify(post))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    console.error('[agentCheckpoints] could not record a post-image:', err)
  }
}

/** A credential file: listed as changed, never copied into the store. */
function isCredentialPath(rel: string): boolean {
  return isSecretBearingFileName(rel.split('/').at(-1) ?? rel)
}

/** Added/removed lines of the turn's change to one file, against its verified pre-image. `null`s for binary, unverifiable or oversized changes. */
function changeCounts(filesDir: string, key: string, pre: PreRecord, after: Buffer): { added: number | null; removed: number | null } {
  const before = pre.existed === false ? Buffer.alloc(0) : verifiedBlob(filesDir, key, 'pre', pre.hash)
  if (before === null || nonTextReason(before) !== null || nonTextReason(after) !== null) return { added: null, removed: null }
  const diff = unifiedLineDiff(pre.path, pre.existed === false ? null : before.toString('utf8'), after.toString('utf8'))
  return diff === null ? { added: null, removed: null } : { added: diff.added, removed: diff.removed }
}

// ---------------------------------------------------------------------------
// Read — what the panel lists
// ---------------------------------------------------------------------------

export type CheckpointFileState =
  /** The file still holds exactly what the agent left: revertable. */
  | 'current'
  /** Someone changed it after the agent's last write: revert refused. */
  | 'changed-since'
  /** Already reverted. */
  | 'reverted'

export interface CheckpointFileSummary {
  readonly path: string
  readonly change: 'created' | 'modified'
  readonly state: CheckpointFileState
  /** Whether a revert can run now: `current`, and the pre-image bytes exist. */
  readonly revertable: boolean
  /** Why it cannot, when it cannot — a sentence for the panel. */
  readonly reason: string | null
  /** Line counts of the turn's change, `null` for a binary or oversized file. */
  readonly added: number | null
  readonly removed: number | null
}

export interface CheckpointTurnSummary {
  readonly turnId: string
  readonly startedAtMs: number
  readonly files: CheckpointFileSummary[]
}

/** Every checkpointed turn of this account in `conversationId`, oldest first, with the files each changed. */
export function listAgentCheckpointTurns(dir: string, userKey: string, conversationId: string): CheckpointTurnSummary[] {
  return listTurnRecords(dir, userKey)
    .filter((record) => record.conversationId === conversationId)
    .map((record) => {
      const filesDir = conversationTurnFilesDir(dir, userKey, conversationId, record.turnId)
      return {
        turnId: record.turnId,
        startedAtMs: record.startedAtMs,
        files: filesDir === null ? [] : readFileEntries(filesDir).map((entry): CheckpointFileSummary => {
          const blocker = revertBlocker(dir, filesDir, entry)
          return {
            path: entry.pre.path,
            change: entry.pre.existed === false ? 'created' : 'modified',
            state: entry.reverted ? 'reverted' : blocker?.code === 'changed-since' ? 'changed-since' : 'current',
            revertable: blocker === null,
            reason: blocker?.message ?? null,
            // Stored when the post-image was recorded: a list never re-diffs (review of #251, F4).
            added: entry.post.added,
            removed: entry.post.removed,
          }
        }),
      }
    })
    .filter((turn) => turn.files.length > 0)
}

export type CheckpointDiffResult =
  | { readonly ok: true; readonly path: string; readonly diff: string; readonly added: number; readonly removed: number }
  | { readonly ok: false; readonly code: 'not-found' | 'binary' | 'too-large' | 'withheld'; readonly message: string }

/**
 * The turn's change to one file, as a unified diff of its pre- and
 * post-image. The turn must belong to `conversationId`, and both images must
 * hash to what their records say.
 */
export function readAgentCheckpointDiff(dir: string, userKey: string, conversationId: string, turnId: string, path: string): CheckpointDiffResult {
  const filesDir = conversationTurnFilesDir(dir, userKey, conversationId, turnId)
  if (filesDir === null) return { ok: false, code: 'not-found', message: 'No such turn in this conversation.' }
  const entry = readFileEntries(filesDir).find((e) => e.pre.path === path)
  if (!entry) return { ok: false, code: 'not-found', message: `This turn did not change "${path}".` }
  if (entry.pre.withheld) return { ok: false, code: 'withheld', message: `"${path}" is a credential file, so Studio keeps no copy of it to show.` }
  const before = entry.pre.existed === false ? Buffer.alloc(0) : verifiedBlob(filesDir, entry.key, 'pre', entry.pre.hash)
  const after = verifiedBlob(filesDir, entry.key, 'post', entry.post.hash)
  if (before === null || after === null) {
    return { ok: false, code: 'too-large', message: `There is no verified copy of "${path}" to diff (too large to checkpoint, or the stored copy does not match its record).` }
  }
  if (nonTextReason(before) !== null || nonTextReason(after) !== null) {
    return { ok: false, code: 'binary', message: `"${path}" is not a text file.` }
  }
  const diff = unifiedLineDiff(path, entry.pre.existed === false ? null : before.toString('utf8'), after.toString('utf8'))
  if (diff === null) return { ok: false, code: 'too-large', message: `The change to "${path}" is too large to show as a diff.` }
  return { ok: true, path, ...diff }
}
