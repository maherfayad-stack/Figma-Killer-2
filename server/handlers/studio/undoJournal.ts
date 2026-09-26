/**
 * undoJournal — ⌘Z for the writes no edit kind can take back (P3-F: ERR-2,
 * DET-4).
 *
 * ## Why a journal, and not an inverse codemod per verb
 *
 * A delete, a detach, a swap and an extract each rewrite markup in one shot,
 * and what they replace is source text no later edit can describe: the
 * deleted element's own bytes, the `<Card/>` call site a detach inlined, the
 * attributes a swap dropped. `store-15` (#201) answered delete alone with a
 * `reinsert-source` edit that carried the removed bytes BACK from the browser,
 * which made the undo of one verb a raw-text write surface on the wire. This
 * is the one mechanism for all four instead: the server keeps what the files
 * were, and an undo names that record by an opaque token. The client never
 * posts file text.
 *
 * ## Compare-and-swap
 *
 * An entry is `{ files: [{ rel, before, afterSha256 }] }`: for every file the
 * write changed, the bytes it had BEFORE (`null` when the write created it)
 * and the SHA-256 of the bytes it left (`null` when it removed it). A restore
 * applies only when every file still hashes to exactly what the write left.
 * Anything else — an agent's edit, an external editor, a value edit that did
 * not round-trip byte for byte — refuses `restore-stale`, names the file, and
 * writes nothing: putting back `before` then would silently throw that newer
 * change away. So the write surface is exactly "revert Studio's own last
 * write, and only while it is untouched".
 *
 * A restored entry is deleted: its token cannot be replayed, and a redo
 * re-posts the forward edit, which records a fresh entry of its own.
 *
 * ## The files are untrusted on read
 *
 * `.studio/` arrives with a clone and can be touched by any local process, so
 * nothing read back here is believed on its word:
 *
 *   - a token is 32 lowercase hex digits (`undoJournalToken.ts`) before it is
 *     ever joined into a path, so it can never traverse;
 *   - the folder and the entry must be reached through plain directory
 *     entries only — no symlink or junction from the project root down
 *     (`isUnlinkedWorkspacePath`) — for a read as well as a write;
 *   - an entry is size-capped ({@link MAX_ENTRY_BYTES}) before it is read and
 *     validated with TypeBox after;
 *   - every `rel` it names is re-derived through `canonicalSourceRel`, the
 *     same guard a node id's file goes through: inside the project on the
 *     real path, app source only, never `.studio`/`.git`/`node_modules`. An
 *     entry that names anything else is `restore-unavailable`, not a write.
 *
 * ## Bounded
 *
 * The newest {@link MAX_ENTRIES} entries per project are kept; recording one
 * prunes the rest. A write whose pre-image would not fit in one entry, or is
 * not valid UTF-8 (so could not be put back byte for byte), records nothing
 * and reports no token — its undo then says it cannot, rather than restoring
 * something close. `.studio/undo-journal/` is outside Studio's commit
 * staging (`gitOperations.ts` excludes all of `.studio/`) and in this
 * repository's `.gitignore`.
 *
 * Single writer: every caller holds the project write lock
 * (`projectWriteLock.ts`), which is also what makes the hash check and the
 * write one step — for Studio's own writers. A process that does not take the
 * lock (an external editor, a Tier-2 dev server's tooling) can still land a
 * change in the microseconds between the hash check and the write, and that
 * change would be overwritten. That window is inherent to a filesystem
 * compare-and-swap without OS-level locks, and the actor already has local
 * write access to the file; it is documented, not defended.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isUnlinkedWorkspacePath } from '@core/page-parser'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { canonicalSourceRel } from '../studioEditRouting'
import { writeFileAtomic } from './atomicFileWrite'
import { readJsonFileSafe } from './cappedFileRead'
import { isUndoJournalToken } from './undoJournalToken'

/** Where the entries live, relative to the project root. */
export const UNDO_JOURNAL_DIR = '.studio/undo-journal'

/** How many entries one project keeps. Older ones are pruned on every record. */
export const MAX_ENTRIES = 50

/** The largest entry recorded or read back — every pre-image of one write together. */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024

/** A name stamped further ahead than this is not one this clock minted (a planted journal, or a clock rolled back). */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

/** The most directory entries one prune reads — a planted folder of junk names cannot make every write slow. */
const MAX_PRUNE_SCAN = 1_000

/** The most files one entry may name. A one-shot write touches one or two. */
const MAX_FILES_PER_ENTRY = 32

const SHA256_PATTERN = '^[0-9a-f]{64}$'

const UndoJournalEntrySchema = Type.Object({
  version: Type.Literal(1),
  at: Type.Number(),
  files: Type.Array(
    Type.Object({
      /** Workspace-relative POSIX path. Re-validated on every read. */
      rel: Type.String({ minLength: 1, maxLength: 1024 }),
      /** The file's bytes before the write, or `null` when the write created it. */
      before: Type.Union([Type.String(), Type.Null()]),
      /** SHA-256 of the bytes the write left, or `null` when the write removed the file. */
      afterSha256: Type.Union([Type.String({ pattern: SHA256_PATTERN }), Type.Null()]),
    }),
    { minItems: 1, maxItems: MAX_FILES_PER_ENTRY },
  ),
})
type UndoJournalEntry = Static<typeof UndoJournalEntrySchema>

/** Every file a restore writes is resolved in the editor's scope — the journal is the editor's undo. */
const EDITOR_SCOPE = { canvasLayers: 'allow' } as const

/** What a write's files held before it ran: absolute path to bytes, or `null` for "did not exist". */
export type UndoPreImage = ReadonlyMap<string, Buffer | null>

let lastStamp = 0

/**
 * A fresh token: a strictly increasing 48-bit millisecond stamp, then 80
 * random bits. The stamp makes name order creation order, so pruning needs no
 * `stat` and no tie-break; the random part is what makes a token unguessable.
 */
function mintToken(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp.toString(16).padStart(12, '0') + randomBytes(10).toString('hex')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readBytes(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null
}

function journalDir(dir: string): string {
  return join(dir, ...UNDO_JOURNAL_DIR.split('/'))
}

/** The entry's path, or `null` for anything that is not a well-formed token. The ONLY place a token meets a path. */
function entryPath(dir: string, token: string): string | null {
  return isUndoJournalToken(token) ? join(journalDir(dir), `${token}.json`) : null
}

/** Read the files a write is about to change. Call it BEFORE the write, under the same lock. */
export function captureUndoPreImage(files: Iterable<string>): UndoPreImage {
  const preImage = new Map<string, Buffer | null>()
  for (const file of files) if (!preImage.has(file)) preImage.set(file, readBytes(file))
  return preImage
}

/**
 * Record what the write that just ran changed, and return its token — or
 * `null` when there is nothing Studio could put back exactly: no file changed,
 * a file is not app source, a pre-image is not valid UTF-8, the entry would
 * be over {@link MAX_ENTRY_BYTES}, or `.studio/` is reached through a link.
 *
 * `created` names files the write made that `preImage` did not list (an
 * extract's new component file); they are recorded as "did not exist".
 */
export function recordUndoJournal(dir: string, preImage: UndoPreImage, created: Iterable<string> = []): string | null {
  const before = new Map(preImage)
  for (const file of created) if (!before.has(file)) before.set(file, null)

  const files: UndoJournalEntry['files'] = []
  for (const [file, was] of before) {
    const now = readBytes(file)
    if (was === null ? now === null : now !== null && was.equals(now)) continue
    const rel = relative(dir, file).split(sep).join('/')
    if (canonicalSourceRel(dir, rel, EDITOR_SCOPE) !== rel) return null
    const text = was === null ? null : was.toString('utf8')
    // Not valid UTF-8: the string would not write back the same bytes.
    if (text !== null && !Buffer.from(text, 'utf8').equals(was!)) return null
    files.push({ rel, before: text, afterSha256: now === null ? null : sha256(now) })
  }
  if (files.length === 0 || files.length > MAX_FILES_PER_ENTRY) return null

  const entry: UndoJournalEntry = { version: 1, at: Date.now(), files }
  const json = JSON.stringify(entry)
  if (Buffer.byteLength(json, 'utf8') > MAX_ENTRY_BYTES) return null

  const folder = journalDir(dir)
  if (!isUnlinkedWorkspacePath(dir, folder)) return null
  mkdirSync(folder, { recursive: true })
  const token = mintToken()
  const path = entryPath(dir, token)!
  if (!isUnlinkedWorkspacePath(dir, path)) return null
  writeFileAtomic(path, json)
  pruneUndoJournal(dir, token)
  return token
}

/** The entry `token` names, validated — `null` when it is absent, malformed, oversized or reached through a link. */
function readEntry(dir: string, token: string): UndoJournalEntry | null {
  const path = entryPath(dir, token)
  if (!path || !isUnlinkedWorkspacePath(dir, path)) return null
  return readJsonFileSafe(path, UndoJournalEntrySchema, MAX_ENTRY_BYTES) ?? null
}

/** Each file of an entry as an absolute path, or `null` when any `rel` is not a writable source path any more. */
function entryFiles(dir: string, entry: UndoJournalEntry): string[] | null {
  const files: string[] = []
  for (const { rel } of entry.files) {
    if (canonicalSourceRel(dir, rel, EDITOR_SCOPE) !== rel) return null
    files.push(join(dir, ...rel.split('/')))
  }
  return files
}

/** The absolute files a restore of `token` would write — empty when it would write none. For the batch's line-count bookkeeping. */
export function undoJournalFiles(dir: string, token: string): string[] {
  const entry = readEntry(dir, token)
  return entry ? entryFiles(dir, entry) ?? [] : []
}

export type UndoJournalRestore =
  | { ok: true; files: string[] }
  | { ok: false; reason: 'restore-unavailable' | 'restore-stale' | 'restore-failed'; message: string }

/** Test seam: the file writes a restore makes, so a test can make one fail mid-restore. */
export interface UndoJournalRestoreDeps {
  readonly writeFile?: (path: string, text: string) => void
  readonly removeFile?: (path: string) => void
}

/**
 * Put back what the write behind `token` changed — every file, or none. See
 * this module's doc for the compare-and-swap rule and what is re-validated.
 *
 * "Or none" holds through a failed write too: the bytes each file had when
 * the check passed are kept, and a write that throws part-way puts every file
 * already restored back to them before refusing `restore-failed`. The entry
 * survives, so the same undo can be tried again.
 */
export function restoreUndoJournal(dir: string, token: string, deps: UndoJournalRestoreDeps = {}): UndoJournalRestore {
  const writeFile = deps.writeFile ?? writeFileAtomic
  const removeFile = deps.removeFile ?? unlinkSync
  const entry = readEntry(dir, token)
  const files = entry ? entryFiles(dir, entry) : null
  if (!entry || !files) {
    return {
      ok: false,
      reason: 'restore-unavailable',
      message: 'Studio no longer has what that change replaced, so it cannot be undone here. Nothing was written.',
    }
  }
  const current: (Buffer | null)[] = []
  for (const [i, { rel, afterSha256 }] of entry.files.entries()) {
    const now = readBytes(files[i]!)
    current.push(now)
    if ((now === null ? null : sha256(now)) !== afterSha256) {
      return {
        ok: false,
        reason: 'restore-stale',
        message: `${rel} has changed since that edit, so undoing it would overwrite the newer change. Nothing was written.`,
      }
    }
  }
  // Every path here passed `canonicalSourceRel(...) === rel`, which a link
  // never does (its real path canonicalises differently). That equality is
  // what makes `writeFileAtomic` — which writes THROUGH a symlink to its
  // target — safe here: relax it and this becomes a write-through-link hole.
  const restored: number[] = []
  try {
    for (const [i, { before }] of entry.files.entries()) {
      const file = files[i]!
      if (before === null) {
        if (existsSync(file)) removeFile(file)
      } else {
        writeFile(file, before)
      }
      restored.push(i)
    }
  } catch (err) {
    console.error('[studio:undoJournal] restore failed part-way, putting back what it changed:', err)
    for (const i of restored) {
      const was = current[i]!
      try {
        if (was === null) {
          if (existsSync(files[i]!)) unlinkSync(files[i]!)
        } else {
          writeFileAtomic(files[i]!, was.toString('utf8'))
        }
      } catch (rollbackErr) {
        console.error('[studio:undoJournal] could not put back', entry.files[i]!.rel, rollbackErr)
      }
    }
    return {
      ok: false,
      reason: 'restore-failed',
      message: `Studio could not write ${entry.files[restored.length]?.rel ?? 'a file'} back, so it left every file as it was.`,
    }
  }
  unlinkSync(entryPath(dir, token)!)
  return { ok: true, files }
}

/**
 * Keep the newest {@link MAX_ENTRIES} entries (name order is creation order —
 * see `mintToken`), and never `keep`, the entry just written. Only regular
 * files named like a token are ever touched, and at most
 * {@link MAX_PRUNE_SCAN} names are read.
 *
 * A name stamped more than {@link FUTURE_SLACK_MS} ahead of now was not minted
 * by this clock: a journal planted in a clone, or one left before a clock
 * rollback. Kept, 50 of them would sort above every new entry and get each one
 * pruned the moment it was written — undo switched off. They are removed.
 */
function pruneUndoJournal(dir: string, keep?: string): void {
  const folder = journalDir(dir)
  if (!existsSync(folder) || !isUnlinkedWorkspacePath(dir, folder)) return
  const futureStamp = Date.now() + FUTURE_SLACK_MS
  const ours: string[] = []
  const future: string[] = []
  const handle = opendirSync(folder)
  try {
    for (let scanned = 0; scanned < MAX_PRUNE_SCAN; scanned += 1) {
      const dirent = handle.readSync()
      if (!dirent) break
      const token = dirent.name.endsWith('.json') ? dirent.name.slice(0, -'.json'.length) : ''
      if (!dirent.isFile() || !isUndoJournalToken(token) || token === keep) continue
      ;(parseInt(token.slice(0, 12), 16) > futureStamp ? future : ours).push(dirent.name)
    }
  } finally {
    handle.closeSync()
  }
  ours.sort().reverse()
  // `keep` is one of the newest MAX_ENTRIES by definition, so the rest get one slot fewer.
  const surplus = ours.slice(keep === undefined ? MAX_ENTRIES : MAX_ENTRIES - 1)
  for (const name of [...future, ...surplus]) {
    const path = join(folder, name)
    if (lstatSync(path).isFile()) unlinkSync(path)
  }
}
