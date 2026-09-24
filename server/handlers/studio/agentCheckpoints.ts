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
 * Every function here is fail-soft on the CAPTURE side (a checkpoint that
 * could not be taken must never block the write it describes — the file then
 * shows as "not revertable") and honest on the REVERT side (every refusal has
 * a code and a sentence).
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { realWorkspaceRel } from '@core/page-parser'
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { contentHash, hasOtherHardLinks, nonTextReason, resolveAgentFilePath, statIfPresent } from './agentFileAccess'
import { unifiedLineDiff } from './agentCheckpointDiff'
import { withProjectWriteLock } from './projectWriteLock'

/** The environment variable `claudeCli.ts` sets on the CLI subprocess and the hooks read back. */
export const STUDIO_AGENT_CONVERSATION_KEY_ENV = 'STUDIO_AGENT_CONVERSATION_KEY'

/** Largest file whose bytes a checkpoint keeps. Above it the file is listed, not revertable. */
export const MAX_CHECKPOINT_FILE_BYTES = 4 * 1024 * 1024
/** Newest turns kept per account per project. */
export const MAX_TURNS_KEPT = 50
/** Files one turn records. A turn that writes more is not something to undo file by file. */
const MAX_FILES_PER_TURN = 200

/** A turn id is a persisted message id (`nanoid`). It becomes a path segment, so it is validated wherever it enters. */
const TURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const CONVERSATION_KEY_RE = /^[a-f0-9]{16}$/
/** One file's pre-image record: `<pathKey>.json`. */
const RECORD_FILE_RE = /^([a-f0-9]{24})\.json$/

export function isCheckpointTurnId(value: string): boolean {
  return TURN_ID_RE.test(value)
}

/** Stable, path-safe key for one conversation — what the hooks carry instead of the id itself. */
export function conversationCheckpointKey(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 16)
}

/** The conversation key a hook subprocess should use, or `null` when the CLI did not set one (a hook spawned by an older server). */
export function conversationCheckpointKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[STUDIO_AGENT_CONVERSATION_KEY_ENV]
  return raw && CONVERSATION_KEY_RE.test(raw) ? raw : null
}

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

const TurnRecordSchema = Type.Object({
  turnId: Type.String(),
  conversationId: Type.String(),
  startedAtMs: Type.Number(),
})
type TurnRecord = Static<typeof TurnRecordSchema>

const PreRecordSchema = Type.Object({
  /** Project-relative POSIX path, real casing. */
  path: Type.String(),
  /** `false`: the turn created the file. `null`: the write was seen but its pre-image could not be taken. */
  existed: Type.Union([Type.Boolean(), Type.Null()]),
  hash: Type.Union([Type.String(), Type.Null()]),
  bytes: Type.Number(),
  /** The bytes were over {@link MAX_CHECKPOINT_FILE_BYTES} and not kept. */
  tooLarge: Type.Boolean(),
  atMs: Type.Number(),
})
type PreRecord = Static<typeof PreRecordSchema>

const PostRecordSchema = Type.Object({
  hash: Type.String(),
  bytes: Type.Number(),
  tooLarge: Type.Boolean(),
  atMs: Type.Number(),
})
type PostRecord = Static<typeof PostRecordSchema>

const RevertedRecordSchema = Type.Object({ atMs: Type.Number() })

const CurrentTurnSchema = Type.Object({ turnId: Type.String(), startedAtMs: Type.Number() })

function checkpointRoot(dir: string, userKey: string): string {
  return join(dir, '.studio', 'agent-checkpoints', userKey)
}

function turnDir(dir: string, userKey: string, turnId: string): string {
  return join(checkpointRoot(dir, userKey), turnId)
}

function pathKey(rel: string): string {
  return createHash('sha256').update(rel).digest('hex').slice(0, 24)
}

/** A checkpoint record, or `null` when it is absent or unreadable (logged). */
function readRecord<T extends TSchema>(file: string, schema: T): Static<T> | null {
  try {
    if (!existsSync(file)) return null
    const result = safeParseJson(readFileSync(file, 'utf8'), schema)
    return result.ok ? result.value : null
  } catch (err) {
    console.error('[agentCheckpoints] could not read a checkpoint record:', err)
    return null
  }
}

/**
 * `abs` as the project-relative POSIX path it REALLY is (links resolved,
 * on-disk casing), or `null` when it is not inside the project. One spelling
 * per file, so `Pages/home.tsx` and `pages/Home.tsx` are one checkpoint entry.
 */
function projectRel(dir: string, abs: string): string | null {
  return realWorkspaceRel(dir, isAbsolute(abs) ? abs : resolve(dir, abs))
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
    const root = checkpointRoot(dir, userKey)
    mkdirSync(join(turnDir(dir, userKey, turn.turnId), 'files'), { recursive: true })
    const record: TurnRecord = { turnId: turn.turnId, conversationId: turn.conversationId, startedAtMs }
    writeFileSync(join(turnDir(dir, userKey, turn.turnId), 'turn.json'), JSON.stringify(record))
    writeFileSync(
      join(root, `current-${conversationCheckpointKey(turn.conversationId)}.json`),
      JSON.stringify({ turnId: turn.turnId, startedAtMs }),
    )
    pruneOldTurns(dir, userKey)
  } catch (err) {
    console.error('[agentCheckpoints] could not open a checkpoint for this turn — its writes will not be revertable:', err)
  }
}

function listTurnRecords(dir: string, userKey: string): TurnRecord[] {
  const root = checkpointRoot(dir, userKey)
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && isCheckpointTurnId(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const records: TurnRecord[] = []
  for (const name of names) {
    const record = readRecord(join(root, name, 'turn.json'), TurnRecordSchema)
    if (record && record.turnId === name) records.push(record)
  }
  return records.sort((a, b) => a.startedAtMs - b.startedAtMs)
}

function pruneOldTurns(dir: string, userKey: string): void {
  const records = listTurnRecords(dir, userKey)
  for (const record of records.slice(0, Math.max(0, records.length - MAX_TURNS_KEPT))) {
    rmSync(turnDir(dir, userKey, record.turnId), { recursive: true, force: true })
  }
}

/** The conversation's current turn id, or `null`. */
function currentTurnId(dir: string, userKey: string, conversationKey: string): string | null {
  if (!CONVERSATION_KEY_RE.test(conversationKey)) return null
  const current = readRecord(join(checkpointRoot(dir, userKey), `current-${conversationKey}.json`), CurrentTurnSchema)
  if (!current || !isCheckpointTurnId(current.turnId)) return null
  return existsSync(join(turnDir(dir, userKey, current.turnId), 'turn.json')) ? current.turnId : null
}

interface FileBytes {
  readonly existed: boolean
  readonly bytes: Buffer | null
  readonly size: number
  readonly hash: string | null
}

/** What `abs` holds right now; `null` for something that is not a regular file. */
function readFileBytes(abs: string): FileBytes | null {
  const stat = statIfPresent(abs)
  if (!stat) return { existed: false, bytes: null, size: 0, hash: null }
  if (!stat.isFile()) return null
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return { existed: true, bytes: null, size: stat.size, hash: null }
  const bytes = readFileSync(abs)
  return { existed: true, bytes, size: bytes.length, hash: contentHash(bytes) }
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
    const filesDir = join(turnDir(dir, userKey, turnId), 'files')
    const key = pathKey(rel)
    const recordFile = join(filesDir, `${key}.json`)
    if (existsSync(recordFile)) return
    if (readdirSync(filesDir).filter((name) => RECORD_FILE_RE.test(name)).length >= MAX_FILES_PER_TURN) return

    const now = options.knownAbsent ? { existed: false, bytes: null, size: 0, hash: null } : readFileBytes(abs)
    if (now === null) return
    if (now.bytes !== null) writeFileSync(join(filesDir, `${key}.pre`), now.bytes)
    const record: PreRecord = {
      path: rel,
      existed: now.existed,
      hash: now.hash,
      bytes: now.size,
      tooLarge: now.existed && now.bytes === null,
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
    const filesDir = join(turnDir(dir, userKey, turnId), 'files')
    const key = pathKey(rel)
    const now = readFileBytes(abs)
    if (now === null || !now.existed) return
    if (!existsSync(join(filesDir, `${key}.json`))) {
      const unknown: PreRecord = { path: rel, existed: null, hash: null, bytes: 0, tooLarge: false, atMs: Date.now() }
      writeFileSync(join(filesDir, `${key}.json`), JSON.stringify(unknown), { flag: 'wx' })
    }
    if (now.bytes !== null) writeFileSync(join(filesDir, `${key}.post`), now.bytes)
    const post: PostRecord = {
      hash: now.hash ?? contentHash(readFileSync(abs)),
      bytes: now.size,
      tooLarge: now.bytes === null,
      atMs: Date.now(),
    }
    writeFileSync(join(filesDir, `${key}.post.json`), JSON.stringify(post))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    console.error('[agentCheckpoints] could not record a post-image:', err)
  }
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

interface FileEntry {
  readonly key: string
  readonly pre: PreRecord
  readonly post: PostRecord
  readonly reverted: boolean
}

function readFileEntries(dir: string, userKey: string, turnId: string): FileEntry[] {
  const filesDir = join(turnDir(dir, userKey, turnId), 'files')
  let names: string[]
  try {
    names = readdirSync(filesDir)
  } catch {
    return []
  }
  const entries: FileEntry[] = []
  for (const name of names) {
    const match = RECORD_FILE_RE.exec(name)
    if (!match) continue
    const key = match[1]!
    const pre = readRecord(join(filesDir, name), PreRecordSchema)
    const post = readRecord(join(filesDir, `${key}.post.json`), PostRecordSchema)
    // A pre-image with no post-image is a write the gate or the tool refused.
    if (!pre || !post || pathKey(pre.path) !== key) continue
    if (pre.existed === true && pre.hash !== null && pre.hash === post.hash) continue
    const reverted = readRecord(join(filesDir, `${key}.reverted.json`), RevertedRecordSchema) !== null
    entries.push({ key, pre, post, reverted })
  }
  return entries.sort((a, b) => a.pre.path.localeCompare(b.pre.path))
}

function readStored(dir: string, userKey: string, turnId: string, key: string, side: 'pre' | 'post'): Buffer | null {
  try {
    return readFileSync(join(turnDir(dir, userKey, turnId), 'files', `${key}.${side}`))
  } catch {
    return null
  }
}

function currentHashOf(dir: string, rel: string): string | null {
  const abs = join(dir, ...rel.split('/'))
  const now = readFileBytes(abs)
  if (now === null || !now.existed) return null
  return now.hash ?? contentHash(readFileSync(abs))
}

/** Why `entry` cannot be reverted right now, or `null` when it can. */
function revertBlocker(dir: string, userKey: string, turnId: string, entry: FileEntry): { code: RevertRefusalCode; message: string } | null {
  if (entry.reverted) return { code: 'already-reverted', message: `"${entry.pre.path}" was already reverted.` }
  if (entry.pre.existed === null) {
    return { code: 'not-checkpointed', message: `Studio could not record what "${entry.pre.path}" held before this turn, so it cannot put it back.` }
  }
  if (entry.pre.existed && (entry.pre.tooLarge || readStored(dir, userKey, turnId, entry.key, 'pre') === null)) {
    return { code: 'not-checkpointed', message: `"${entry.pre.path}" was too large to checkpoint (over ${MAX_CHECKPOINT_FILE_BYTES / 1024 / 1024} MB), so it cannot be reverted here.` }
  }
  if (currentHashOf(dir, entry.pre.path) !== entry.post.hash) {
    return {
      code: 'changed-since',
      message: `"${entry.pre.path}" changed after this turn wrote it — by you, or by a later turn. Reverting would throw that change away, so it was left alone.`,
    }
  }
  return null
}

function lineCounts(dir: string, userKey: string, turnId: string, entry: FileEntry): { added: number | null; removed: number | null } {
  const before = entry.pre.existed ? readStored(dir, userKey, turnId, entry.key, 'pre') : Buffer.alloc(0)
  const after = readStored(dir, userKey, turnId, entry.key, 'post')
  if (before === null || after === null || nonTextReason(before) !== null || nonTextReason(after) !== null) return { added: null, removed: null }
  const diff = unifiedLineDiff(entry.pre.path, entry.pre.existed ? before.toString('utf8') : null, after.toString('utf8'))
  return diff === null ? { added: null, removed: null } : { added: diff.added, removed: diff.removed }
}

/** Every checkpointed turn of this account in `conversationId`, oldest first, with the files each changed. */
export function listAgentCheckpointTurns(dir: string, userKey: string, conversationId: string): CheckpointTurnSummary[] {
  return listTurnRecords(dir, userKey)
    .filter((record) => record.conversationId === conversationId)
    .map((record) => ({
      turnId: record.turnId,
      startedAtMs: record.startedAtMs,
      files: readFileEntries(dir, userKey, record.turnId).map((entry): CheckpointFileSummary => {
        const blocker = revertBlocker(dir, userKey, record.turnId, entry)
        return {
          path: entry.pre.path,
          change: entry.pre.existed === false ? 'created' : 'modified',
          state: entry.reverted ? 'reverted' : blocker?.code === 'changed-since' ? 'changed-since' : 'current',
          revertable: blocker === null,
          reason: blocker?.message ?? null,
          ...lineCounts(dir, userKey, record.turnId, entry),
        }
      }),
    }))
    .filter((turn) => turn.files.length > 0)
}

export type CheckpointDiffResult =
  | { readonly ok: true; readonly path: string; readonly diff: string; readonly added: number; readonly removed: number }
  | { readonly ok: false; readonly code: 'not-found' | 'binary' | 'too-large'; readonly message: string }

/** The turn's change to one file, as a unified diff of its pre- and post-image. */
export function readAgentCheckpointDiff(dir: string, userKey: string, turnId: string, path: string): CheckpointDiffResult {
  if (!isCheckpointTurnId(turnId)) return { ok: false, code: 'not-found', message: 'No such turn.' }
  const entry = readFileEntries(dir, userKey, turnId).find((e) => e.pre.path === path)
  if (!entry) return { ok: false, code: 'not-found', message: `This turn did not change "${path}".` }
  const before = entry.pre.existed ? readStored(dir, userKey, turnId, entry.key, 'pre') : Buffer.alloc(0)
  const after = readStored(dir, userKey, turnId, entry.key, 'post')
  if (before === null || after === null) {
    return { ok: false, code: 'too-large', message: `"${path}" was too large to checkpoint, so there is no diff to show.` }
  }
  if (nonTextReason(before) !== null || nonTextReason(after) !== null) {
    return { ok: false, code: 'binary', message: `"${path}" is not a text file.` }
  }
  const diff = unifiedLineDiff(path, entry.pre.existed ? before.toString('utf8') : null, after.toString('utf8'))
  if (diff === null) return { ok: false, code: 'too-large', message: `The change to "${path}" is too large to show as a diff.` }
  return { ok: true, path, ...diff }
}

// ---------------------------------------------------------------------------
// Revert — the user's action; compare-and-swap, through the agent write gate
// ---------------------------------------------------------------------------

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
  turnId: string,
  paths?: readonly string[],
): Promise<RevertOutcome> {
  if (!isCheckpointTurnId(turnId)) return refused('not-found', 'No such turn.', [])
  return withProjectWriteLock(dir, () => {
    const all = readFileEntries(dir, userKey, turnId)
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
      const blocker = revertBlocker(dir, userKey, turnId, entry)
      if (blocker) {
        problems.push({ path: entry.pre.path, ...blocker })
        continue
      }
      plans.push({ entry, abs: target.abs, restore: entry.pre.existed ? readStored(dir, userKey, turnId, entry.key, 'pre') : null })
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
        const agentBytes = readFileSync(plan.abs)
        if (plan.restore === null) unlinkSync(plan.abs)
        else writeFileSync(plan.abs, plan.restore)
        done.push({ abs: plan.abs, agentBytes })
      }
    } catch (err) {
      for (const { abs, agentBytes } of done) {
        try {
          writeFileSync(abs, agentBytes)
        } catch (restoreErr) {
          console.error('[agentCheckpoints] could not undo a partial revert:', restoreErr)
        }
      }
      const detail = err instanceof Error ? err.message : String(err)
      return refused('io-error', `Reverting failed (${detail}); every file already restored was put back to the agent's version.`, [])
    }
    const atMs = Date.now()
    for (const plan of plans) {
      writeFileSync(join(turnDir(dir, userKey, turnId), 'files', `${plan.entry.key}.reverted.json`), JSON.stringify({ atMs }))
    }
    return { ok: true, reverted: plans.map((plan) => plan.entry.pre.path) }
  })
}

function refused(code: RevertRefusalCode, message: string, files: Array<{ path: string; code: RevertRefusalCode; message: string }>): RevertOutcome {
  return { ok: false, code, message, files }
}
