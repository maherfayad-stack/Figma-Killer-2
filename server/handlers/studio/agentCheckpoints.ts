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
 * ## The store does not trust its own files (review of #251, F1)
 *
 * `.studio/` is out of every agent's reach, but not out of `git pull`'s or
 * another local process's. So nothing here follows a link, and nothing read
 * back is believed on its word:
 *
 *   - every store directory, from `.studio/` down, must be a real directory —
 *     never a symlink or a junction — or the store is treated as absent
 *     (`storeDir`), so no copy is ever written, read or pruned outside it;
 *   - every store file is read with `lstat` + no-follow, must be a regular
 *     single-link file, and is capped (64 KB for a record, the checkpoint cap
 *     for a blob) — `readStoreFile`;
 *   - a stored image counts only if its bytes hash to the hash its record
 *     states — a pre-image that is a link, or was swapped, is simply "not
 *     checkpointed", never restored and never diffed;
 *   - a turn belongs to ONE conversation (`turn.json`), and a revert or a diff
 *     naming another conversation is `not-found`;
 *   - store files are written through a fresh temp name and a rename, so a
 *     link planted at a record's name is replaced, never written through.
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
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isSecretBearingFileName, realWorkspaceRel } from '@core/page-parser'
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
/** Largest JSON record the store reads back. Every real one is a few hundred bytes. */
const MAX_RECORD_BYTES = 64 * 1024

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
  /** A credential file: its bytes are never kept, so it is never revertable. */
  withheld: Type.Optional(Type.Boolean()),
  atMs: Type.Number(),
})
type PreRecord = Static<typeof PreRecordSchema>

const PostRecordSchema = Type.Object({
  hash: Type.String(),
  bytes: Type.Number(),
  tooLarge: Type.Boolean(),
  /** Line counts of the turn's change, computed ONCE when the post-image is recorded (listing never re-diffs). */
  added: Type.Union([Type.Number(), Type.Null()]),
  removed: Type.Union([Type.Number(), Type.Null()]),
  atMs: Type.Number(),
})
type PostRecord = Static<typeof PostRecordSchema>

const RevertedRecordSchema = Type.Object({ atMs: Type.Number() })

const CurrentTurnSchema = Type.Object({ turnId: Type.String(), startedAtMs: Type.Number() })

const STORE_SEGMENTS = ['.studio', 'agent-checkpoints'] as const

function pathKey(rel: string): string {
  return createHash('sha256').update(rel).digest('hex').slice(0, 24)
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * `<dir>/.studio/agent-checkpoints/<…segments>` when EVERY directory on the
 * way is a real directory inside the project — no symlink, no junction —
 * creating the missing ones when `create`; else `null`. The one way this
 * module reaches a store directory, so nothing is ever read, written or
 * pruned through a link out of the project.
 */
function storeDir(dir: string, segments: readonly string[], create: boolean): string | null {
  let current: string
  try {
    current = realpathSync.native(resolve(dir))
  } catch {
    return null
  }
  for (const segment of [...STORE_SEGMENTS, ...segments]) {
    const next = join(current, segment)
    let stat = lstatOrNull(next)
    if (stat === null) {
      if (!create) return null
      try {
        mkdirSync(next)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
      }
      stat = lstatOrNull(next)
    }
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return null
    // A junction can read as a plain directory to lstat on some runtimes; its real path cannot.
    try {
      if (!samePath(realpathSync.native(next), next)) return null
    } catch {
      return null
    }
    current = next
  }
  return current
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * A store file's bytes: a regular, single-link file of at most `maxBytes`,
 * opened without following a link. `null` for anything else — absent, a
 * link, a directory, a hard link, oversized.
 */
function readStoreFile(file: string, maxBytes: number): Buffer | null {
  const stat = lstatOrNull(file)
  if (stat === null || stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > maxBytes) return null
  let fd: number
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes || opened.nlink > 1) return null
    if (opened.ino !== 0 && stat.ino !== 0 && opened.ino !== stat.ino) return null
    return readFileSync(fd)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** Write a store file through a fresh temp name and a rename: a link planted at `file` is replaced, never written through. */
function writeStoreFile(file: string, data: string | Buffer): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, data, { flag: 'wx' })
  try {
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** A checkpoint record, or `null` when it is absent, not a plain small file, or not the right shape. */
function readRecord<T extends TSchema>(file: string, schema: T): Static<T> | null {
  const bytes = readStoreFile(file, MAX_RECORD_BYTES)
  if (bytes === null) return null
  const result = safeParseJson(bytes.toString('utf8'), schema)
  return result.ok ? result.value : null
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

function listTurnRecords(dir: string, userKey: string): TurnRecord[] {
  const root = storeDir(dir, [userKey], false)
  if (root === null) return []
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
    // Only a real directory inside the store; `rmSync` removes links it meets, never their targets.
    const doomed = storeDir(dir, [userKey, record.turnId], false)
    if (doomed !== null) rmSync(doomed, { recursive: true, force: true })
  }
}

/** The conversation's current turn id, or `null`. */
function currentTurnId(dir: string, userKey: string, conversationKey: string): string | null {
  if (!CONVERSATION_KEY_RE.test(conversationKey)) return null
  const root = storeDir(dir, [userKey], false)
  if (root === null) return null
  const current = readRecord(join(root, `current-${conversationKey}.json`), CurrentTurnSchema)
  if (!current || !isCheckpointTurnId(current.turnId)) return null
  return turnFilesDir(dir, userKey, current.turnId) !== null ? current.turnId : null
}

/** The turn's `files/` directory, when the turn exists and its whole path is real. */
function turnFilesDir(dir: string, userKey: string, turnId: string): string | null {
  if (!isCheckpointTurnId(turnId)) return null
  const files = storeDir(dir, [userKey, turnId, 'files'], false)
  if (files === null || readRecord(join(files, '..', 'turn.json'), TurnRecordSchema) === null) return null
  return files
}

/** The turn's `files/` directory when the turn belongs to `conversationId` — a turn is bound to one conversation. */
function conversationTurnFilesDir(dir: string, userKey: string, conversationId: string, turnId: string): string | null {
  const files = turnFilesDir(dir, userKey, turnId)
  if (files === null) return null
  const record = readRecord(join(files, '..', 'turn.json'), TurnRecordSchema)
  return record !== null && record.turnId === turnId && record.conversationId === conversationId ? files : null
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

/** A stored image, only when its bytes hash to what its record says they are. */
function verifiedBlob(filesDir: string, key: string, side: 'pre' | 'post', expectedHash: string | null): Buffer | null {
  if (expectedHash === null) return null
  const bytes = readStoreFile(join(filesDir, `${key}.${side}`), MAX_CHECKPOINT_FILE_BYTES)
  return bytes !== null && contentHash(bytes) === expectedHash ? bytes : null
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

function readFileEntries(filesDir: string | null): FileEntry[] {
  if (filesDir === null) return []
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

function currentHashOf(dir: string, rel: string): string | null {
  const abs = join(dir, ...rel.split('/'))
  const now = readFileBytes(abs)
  if (now === null || !now.existed) return null
  return now.hash ?? contentHash(readFileSync(abs))
}

/** Why `entry` cannot be reverted right now, or `null` when it can. */
function revertBlocker(dir: string, filesDir: string, entry: FileEntry): { code: RevertRefusalCode; message: string } | null {
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
          console.error('[agentCheckpoints] could not undo a partial revert:', restoreErr)
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
  constructor(readonly path: string) {
    super(`"${path}" changed since the revert was checked.`)
    this.name = 'ChangedSinceError'
  }
}

function refused(code: RevertRefusalCode, message: string, files: Array<{ path: string; code: RevertRefusalCode; message: string }>): RevertOutcome {
  return { ok: false, code, message, files }
}
