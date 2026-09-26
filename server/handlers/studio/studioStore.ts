/**
 * studioStore — the ONE door to a project's `.studio/` folder: every read and
 * every write of Studio's own records goes through here.
 *
 * `.studio/` is Studio's control plane inside the user's repository: the trust
 * tier and approved MCP servers (`meta.json`), the board (`boards.json`),
 * review threads, prototype links, share records, tokens, fonts, variables,
 * the launcher thumbnail, the agent's caches and logs. Most of it is meant to
 * be committed, so it arrives with a clone — and git stores symlinks. A
 * repository that ships `.studio/thumbnail.png -> ~/.ssh/id_rsa` turned the
 * thumbnail route into a file-read primitive; one that ships
 * `.studio/boards.json -> ~/.bashrc` had the next board drag overwrite it.
 * Every store used to call `readFileSync`/`writeFileSync` on its own
 * `join(dir, '.studio', …)`, so every store had the hole, and a fix to one was
 * a fix to one.
 *
 * ## The rules, in one place
 *
 * - **No link anywhere from `.studio` down.** The entry, and every directory
 *   between it and the project root, must be a plain directory entry — not a
 *   symlink, not a junction, dangling or not (`isUnlinkedWorkspacePath`). Studio
 *   never needs to reach its own records through a link, whether it leads in or
 *   out, so it never does. A READ through one answers "absent" (and logs once);
 *   a WRITE throws {@link StudioStoreLinkError}, never lands anywhere else,
 *   and never echoes a path.
 * - **Names are Studio's, not the caller's.** A store path is `/`-separated
 *   segments of `[A-Za-z0-9_-]` plus inner dots — no `..`, no separators, no
 *   drive letters, no trailing dot or space (Windows opens `meta.json.` as
 *   `meta.json`), no `:` (an NTFS stream).
 * - **Validated on read.** JSON comes back through a TypeBox schema
 *   ({@link readStudioStoreJson}) or the store's own normalising parser from
 *   `@core` ({@link readStudioStoreDocument}); a malformed file is the
 *   fallback, never a throw and never an `as`.
 * - **Atomic on write.** `writeFileAtomic`: a crash or a reader mid-write never
 *   sees half a `meta.json`.
 *
 * `agentCheckpoints.ts` keeps its own, stricter store under
 * `.studio/agent-checkpoints/` (it distrusts its own files' contents too, and
 * refuses hard links); the free canvas's layer modules (`.studio/canvas/`) are
 * written by the writeback, which applies the same link rule
 * (`sourceFileWrite.ts`). `studio-store-single-door.test.ts` holds every
 * other module to this one.
 */
import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  type Dirent,
  type Stats,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isUnlinkedWorkspacePath, writeFileAtomic } from '@core/page-parser'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { Static, TSchema } from '@core/utils/typeboxHelpers'

/** The folder every store lives under, at the project root. */
export const STUDIO_STORE_DIR = '.studio'

const STORE_SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/

/**
 * A write refused because the store path runs through a link. The message is
 * written for the person who opened the project and names no path — route
 * handlers answer it with their generic failure.
 */
export class StudioStoreLinkError extends Error {
  constructor() {
    super(
      "This project's .studio folder contains a link to somewhere else, so Studio will not write its records through it. Replace the link with an ordinary file or folder.",
    )
    this.name = 'StudioStoreLinkError'
  }
}

function storeSegments(rel: string): string[] {
  const segments = rel.split('/')
  if (segments.length === 0 || segments.some((segment) => !STORE_SEGMENT.test(segment) || segment === '..')) {
    throw new Error(`Invalid .studio store path: ${JSON.stringify(rel)}`)
  }
  return segments
}

/**
 * The absolute path of `.studio/<rel>` under project `dir`. Path arithmetic
 * only — it says nothing about links. For a caller that must NAME the file
 * (a cache key, a watcher filter); reading or writing it is this module's job.
 */
export function studioStorePath(dir: string, rel: string): string {
  return join(resolve(dir), STUDIO_STORE_DIR, ...storeSegments(rel))
}

/**
 * `.studio/<rel>` as a project-relative POSIX path — a NAME for a caller that
 * hands it to another helper (the static-file server, a fingerprint label),
 * never a path to open on its own.
 */
export function studioStoreProjectRel(rel: string): string {
  return [STUDIO_STORE_DIR, ...storeSegments(rel)].join('/')
}

/**
 * Whether `.studio/<rel>` is reached from `dir` through plain directory entries
 * only, with none at `rel` itself — true for an entry that does not exist yet
 * but whose existing ancestors are all plain.
 */
export function isStudioStorePathUnlinked(dir: string, rel: string): boolean {
  return isUnlinkedWorkspacePath(dir, studioStorePath(dir, rel))
}

const refusalsLogged = new Set<string>()

function logRefusedRead(dir: string, rel: string): void {
  const key = `${resolve(dir)}\0${rel}`
  if (refusalsLogged.has(key)) return
  refusalsLogged.add(key)
  console.warn(`[studio:store] .studio/${rel} is reached through a link; Studio ignores it.`)
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR'
}

/**
 * The entry at `.studio/<rel>` and its `lstat`, or `null` when there is
 * nothing there or the way to it runs through a link (logged once per path).
 *
 * Absent is answered first and cheaply — one `lstat`, no realpath chain. A
 * read of nothing discloses nothing, and the public share route asks this of
 * every project on disk for every unknown token. Only an entry that EXISTS
 * (a dangling link included: `lstat` sees the link) pays the full link check,
 * and it pays it before a byte of it is read.
 */
function readableEntry(dir: string, rel: string): { abs: string; stat: Stats } | null {
  const abs = studioStorePath(dir, rel)
  let stat: Stats
  try {
    stat = lstatSync(abs)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  if (!isUnlinkedWorkspacePath(dir, abs)) {
    logRefusedRead(dir, rel)
    return null
  }
  return { abs, stat }
}

/** The bytes of a plain file at `.studio/<rel>`, or `null` when it is absent, not a file, or reached through a link. */
export function readStudioStoreBytes(dir: string, rel: string): Buffer<ArrayBuffer> | null {
  const entry = readableEntry(dir, rel)
  if (entry === null || !entry.stat.isFile()) return null
  try {
    return readFileSync(entry.abs)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

/** {@link readStudioStoreBytes} as UTF-8 text. For a store that is not one JSON document (a JSONL log). */
export function readStudioStoreText(dir: string, rel: string): string | null {
  return readStudioStoreBytes(dir, rel)?.toString('utf8') ?? null
}

/**
 * `.studio/<rel>` parsed and validated against `schema`; `fallback` when it is
 * absent, reached through a link, not JSON, or the wrong shape.
 */
export function readStudioStoreJson<T extends TSchema, F = Static<T>>(dir: string, rel: string, schema: T, fallback: F): Static<T> | F {
  const raw = readStudioStoreText(dir, rel)
  if (raw === null || raw === '') return fallback
  const result = safeParseJson(raw, schema)
  return result.ok ? result.value : fallback
}

/**
 * `.studio/<rel>` through the store's own validating parser — the board,
 * comment and prototype documents normalise item by item (`@core`'s
 * `parse*File`) rather than reject a whole file over one bad entry.
 * `fallback()` when the file is absent or reached through a link.
 */
export function readStudioStoreDocument<T>(dir: string, rel: string, parse: (raw: string) => T, fallback: () => T): T {
  const raw = readStudioStoreText(dir, rel)
  return raw === null ? fallback() : parse(raw)
}

/** The `lstat` of a plain file at `.studio/<rel>`, or `null` (absent, a directory, or reached through a link). */
export function statStudioStoreFile(dir: string, rel: string): Stats | null {
  const entry = readableEntry(dir, rel)
  return entry !== null && entry.stat.isFile() ? entry.stat : null
}

/**
 * The plain files and directories directly inside `.studio/<rel>`. A link in
 * the listing is left out; the directory itself absent or linked is `[]`.
 */
export function listStudioStoreDir(dir: string, rel: string): Dirent[] {
  const found = readableEntry(dir, rel)
  if (found === null || !found.stat.isDirectory()) return []
  try {
    return readdirSync(found.abs, { withFileTypes: true }).filter((entry) => entry.isFile() || entry.isDirectory())
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
}

/** The path a write may use, with its folder made; throws {@link StudioStoreLinkError} before and after the `mkdir`. */
function writablePath(dir: string, rel: string): string {
  const abs = studioStorePath(dir, rel)
  if (!isUnlinkedWorkspacePath(dir, abs)) throw new StudioStoreLinkError()
  mkdirSync(dirname(abs), { recursive: true })
  // `mkdir` cannot have made a link; a racing writer could have. Cheap to ask again.
  if (!isUnlinkedWorkspacePath(dir, abs)) throw new StudioStoreLinkError()
  return abs
}

/**
 * Make the folder `.studio/<rel>` (and its parents) and return its absolute
 * path, for the one writer that is not this process: the component-bundle
 * worker writes its artefact to a path. Throws {@link StudioStoreLinkError}
 * when anything from `.studio` down is a link.
 */
export function makeStudioStoreDir(dir: string, rel: string): string {
  const abs = studioStorePath(dir, rel)
  if (!isUnlinkedWorkspacePath(dir, abs)) throw new StudioStoreLinkError()
  mkdirSync(abs, { recursive: true })
  if (!isUnlinkedWorkspacePath(dir, abs)) throw new StudioStoreLinkError()
  return abs
}

/** Replace `.studio/<rel>` in one step (`writeFileAtomic`), creating its folders. Returns the absolute path. */
export function writeStudioStoreFile(dir: string, rel: string, content: string | Uint8Array): string {
  const abs = writablePath(dir, rel)
  writeFileAtomic(abs, content)
  return abs
}

/** {@link writeStudioStoreFile} of `value` as JSON — indented by two when `pretty`, with a trailing newline when `trailingNewline`. */
export function writeStudioStoreJson(
  dir: string,
  rel: string,
  value: unknown,
  options: { pretty?: boolean; trailingNewline?: boolean } = {},
): string {
  const text = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
  return writeStudioStoreFile(dir, rel, options.trailingNewline ? `${text}\n` : text)
}

/**
 * Append `text` to `.studio/<rel>` (a JSONL log). Not atomic — an append is
 * the one write whose partial state a reader already tolerates — but never
 * through a link: `O_NOFOLLOW` where the OS has it, and the check above
 * everywhere.
 */
export function appendStudioStoreText(dir: string, rel: string, text: string): void {
  const abs = writablePath(dir, rel)
  const noFollow = constants.O_NOFOLLOW
  if (noFollow === undefined) {
    appendFileSync(abs, text, 'utf8')
    return
  }
  const fd = openSync(abs, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o666)
  try {
    appendFileSync(fd, text, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Remove one entry — a file, or with `recursive` a whole folder — without
 * following any link: a link inside is removed as a link, never entered. A
 * store path that is itself reached through a link is refused.
 */
export function removeStudioStoreEntry(dir: string, rel: string, options: { recursive?: boolean } = {}): void {
  const abs = studioStorePath(dir, rel)
  if (!isUnlinkedWorkspacePath(dir, abs)) throw new StudioStoreLinkError()
  let stat: Stats
  try {
    stat = lstatSync(abs)
  } catch (err) {
    if (isMissing(err)) return
    throw err
  }
  if (!stat.isDirectory()) {
    unlinkSync(abs)
    return
  }
  if (!options.recursive) throw new Error(`.studio/${rel} is a folder`)
  removeTreeWithoutFollowing(abs)
}

/** Remove a link entry itself, never what it points at. A Windows directory junction answers `rmdir`, not `unlink`. */
function removeLinkEntry(abs: string): void {
  try {
    unlinkSync(abs)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EISDIR') throw err
    rmdirSync(abs)
  }
}

function removeTreeWithoutFollowing(abs: string): void {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = join(abs, entry.name)
    const stat = lstatSync(child)
    if (stat.isSymbolicLink()) removeLinkEntry(child)
    else if (stat.isDirectory()) removeTreeWithoutFollowing(child)
    else unlinkSync(child)
  }
  rmdirSync(abs)
}

/** What {@link stripStudioStoreLinks} removed, for the caller's log and summary. */
export interface StrippedStudioLinks {
  /** `.studio` itself was a link (or a plain file) and was removed; Studio makes a real folder on its first write. */
  readonly rootReplaced: boolean
  /** Link entries removed from inside a real `.studio` folder, as `.studio`-relative paths. */
  readonly removed: readonly string[]
}

/**
 * Make a freshly cloned project's `.studio/` link-free BEFORE Studio writes a
 * single record into it (`gitClone.ts`; the decision is recorded there). A
 * `.studio` that is a link is removed as a link; inside a real one, every link
 * — at any depth — is removed as a link. Nothing is followed, and every plain
 * file is kept: `.studio/boards.json` and friends are meant to be committed,
 * and cloning your own project back must keep its board.
 */
export function stripStudioStoreLinks(dir: string): StrippedStudioLinks {
  const root = join(resolve(dir), STUDIO_STORE_DIR)
  let stat: Stats
  try {
    stat = lstatSync(root)
  } catch (err) {
    if (isMissing(err)) return { rootReplaced: false, removed: [] }
    throw err
  }
  if (stat.isSymbolicLink()) {
    removeLinkEntry(root)
    return { rootReplaced: true, removed: [] }
  }
  if (!stat.isDirectory()) {
    // A plain FILE named `.studio`: not Studio's, and every store write would
    // fail on it. Removed like a link — it can only have come from the repository.
    unlinkSync(root)
    return { rootReplaced: true, removed: [] }
  }
  const removed: string[] = []
  const walk = (abs: string, prefix: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const childStat = lstatSync(child)
      if (childStat.isSymbolicLink()) {
        removeLinkEntry(child)
        removed.push(rel)
      } else if (childStat.isDirectory()) {
        walk(child, rel)
      }
    }
  }
  walk(root, '')
  return { rootReplaced: false, removed }
}
