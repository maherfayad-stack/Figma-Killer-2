/**
 * agentCheckpointStore — the on-disk half of the per-turn agent checkpoint
 * (AI-7): the store's layout, its record shapes, and every read and write of
 * `.studio/agent-checkpoints/<userKey>/<turnId>/`. Internal to the checkpoint
 * module; callers outside it import `agentCheckpoints.ts`, whose doc comment
 * describes the whole design.
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
 *     checkpointed", never restored and never diffed (`verifiedBlob`);
 *   - a turn belongs to ONE conversation (`turn.json`), and a revert or a diff
 *     naming another conversation is `not-found` (`conversationTurnFilesDir`);
 *   - store files are written through a fresh temp name and a rename, so a
 *     link planted at a record's name is replaced, never written through.
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
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { realWorkspaceRel } from '@core/page-parser'
import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { contentHash, statIfPresent } from './agentFileAccess'

/** Largest file whose bytes a checkpoint keeps. Above it the file is listed, not revertable. */
export const MAX_CHECKPOINT_FILE_BYTES = 4 * 1024 * 1024
/** Newest turns kept per account per project. */
export const MAX_TURNS_KEPT = 50
/** Files one turn records. A turn that writes more is not something to undo file by file. */
export const MAX_FILES_PER_TURN = 200
/** Largest JSON record the store reads back. Every real one is a few hundred bytes. */
const MAX_RECORD_BYTES = 64 * 1024

/** A turn id is a persisted message id (`nanoid`). It becomes a path segment, so it is validated wherever it enters. */
const TURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const CONVERSATION_KEY_RE = /^[a-f0-9]{16}$/
/** One file's pre-image record: `<pathKey>.json`. */
export const RECORD_FILE_RE = /^([a-f0-9]{24})\.json$/

export function isCheckpointTurnId(value: string): boolean {
  return TURN_ID_RE.test(value)
}

/** Stable, path-safe key for one conversation — what the hooks carry instead of the id itself. */
export function conversationCheckpointKey(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

const TurnRecordSchema = Type.Object({
  turnId: Type.String(),
  conversationId: Type.String(),
  startedAtMs: Type.Number(),
})
export type TurnRecord = Static<typeof TurnRecordSchema>

export const PreRecordSchema = Type.Object({
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
export type PreRecord = Static<typeof PreRecordSchema>

const PostRecordSchema = Type.Object({
  hash: Type.String(),
  bytes: Type.Number(),
  tooLarge: Type.Boolean(),
  /** Line counts of the turn's change, computed ONCE when the post-image is recorded (listing never re-diffs). */
  added: Type.Union([Type.Number(), Type.Null()]),
  removed: Type.Union([Type.Number(), Type.Null()]),
  atMs: Type.Number(),
})
export type PostRecord = Static<typeof PostRecordSchema>

const RevertedRecordSchema = Type.Object({ atMs: Type.Number() })

const CurrentTurnSchema = Type.Object({ turnId: Type.String(), startedAtMs: Type.Number() })

const STORE_SEGMENTS = ['.studio', 'agent-checkpoints'] as const

export function pathKey(rel: string): string {
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
export function storeDir(dir: string, segments: readonly string[], create: boolean): string | null {
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

export function lstatOrNull(path: string): Stats | null {
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
export function readStoreFile(file: string, maxBytes: number): Buffer | null {
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
export function writeStoreFile(file: string, data: string | Buffer): void {
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
export function readRecord<T extends TSchema>(file: string, schema: T): Static<T> | null {
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
export function projectRel(dir: string, abs: string): string | null {
  return realWorkspaceRel(dir, isAbsolute(abs) ? abs : resolve(dir, abs))
}

// ---------------------------------------------------------------------------
// Turns — which turn directories exist, and which one is current
// ---------------------------------------------------------------------------

export function listTurnRecords(dir: string, userKey: string): TurnRecord[] {
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

export function pruneOldTurns(dir: string, userKey: string): void {
  const records = listTurnRecords(dir, userKey)
  for (const record of records.slice(0, Math.max(0, records.length - MAX_TURNS_KEPT))) {
    // Only a real directory inside the store; `rmSync` removes links it meets, never their targets.
    const doomed = storeDir(dir, [userKey, record.turnId], false)
    if (doomed !== null) rmSync(doomed, { recursive: true, force: true })
  }
}

/** The conversation's current turn id, or `null`. */
export function currentTurnId(dir: string, userKey: string, conversationKey: string): string | null {
  if (!CONVERSATION_KEY_RE.test(conversationKey)) return null
  const root = storeDir(dir, [userKey], false)
  if (root === null) return null
  const current = readRecord(join(root, `current-${conversationKey}.json`), CurrentTurnSchema)
  if (!current || !isCheckpointTurnId(current.turnId)) return null
  return turnFilesDir(dir, userKey, current.turnId) !== null ? current.turnId : null
}

/** The turn's `files/` directory, when the turn exists and its whole path is real. */
export function turnFilesDir(dir: string, userKey: string, turnId: string): string | null {
  if (!isCheckpointTurnId(turnId)) return null
  const files = storeDir(dir, [userKey, turnId, 'files'], false)
  if (files === null || readRecord(join(files, '..', 'turn.json'), TurnRecordSchema) === null) return null
  return files
}

/** The turn's `files/` directory when the turn belongs to `conversationId` — a turn is bound to one conversation. */
export function conversationTurnFilesDir(dir: string, userKey: string, conversationId: string, turnId: string): string | null {
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
export function readFileBytes(abs: string): FileBytes | null {
  const stat = statIfPresent(abs)
  if (!stat) return { existed: false, bytes: null, size: 0, hash: null }
  if (!stat.isFile()) return null
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return { existed: true, bytes: null, size: stat.size, hash: null }
  const bytes = readFileSync(abs)
  return { existed: true, bytes, size: bytes.length, hash: contentHash(bytes) }
}

// ---------------------------------------------------------------------------
// Images and entries — only what verifies against its record
// ---------------------------------------------------------------------------

/** A stored image, only when its bytes hash to what its record says they are. */
export function verifiedBlob(filesDir: string, key: string, side: 'pre' | 'post', expectedHash: string | null): Buffer | null {
  if (expectedHash === null) return null
  const bytes = readStoreFile(join(filesDir, `${key}.${side}`), MAX_CHECKPOINT_FILE_BYTES)
  return bytes !== null && contentHash(bytes) === expectedHash ? bytes : null
}

export interface FileEntry {
  readonly key: string
  readonly pre: PreRecord
  readonly post: PostRecord
  readonly reverted: boolean
}

export function readFileEntries(filesDir: string | null): FileEntry[] {
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
