/**
 * parseCacheStore — the on-disk tier of the route parse cache (P6-B, PERF-7):
 * `<project>/.studio/cache/parse/<key>.json`, one file per route (and per
 * preview locale), so a server restart, a second project tab after an LRU
 * eviction, or the agent's Stop hook — a fresh `bun` process on every turn —
 * does not re-run a parse the last process already did. `pageParseCache.ts`
 * owns WHEN an entry is written and trusted; this module owns the file.
 *
 * ## The file is untrusted input
 *
 * It lives inside the user's repository. A `git pull` can bring one in, an
 * agent can write one, anything that can write the project can write here.
 * Three checks stand between its bytes and the board, and each alone would
 * be insufficient:
 *
 *   1. **Signature.** The first line is an HMAC-SHA256 of the rest, keyed by
 *      a secret in Studio's private data root (`STUDIO_DATA_DIR`, never the
 *      project — {@link parseCacheSigningKey}). Only a process holding that key
 *      can produce an entry the reader accepts, so a forged or edited entry is
 *      discarded unread, whatever it claims. This is what makes it safe to
 *      trust the parsed page INSIDE the entry, which no schema could vouch for.
 *   2. **Shape.** The payload is validated with TypeBox before any field is
 *      read ({@link StoredParseSchema}): an entry from a different format, or
 *      a truncated write, fails here rather than as a crash deep in the load.
 *   3. **Dependencies, by content.** Every file the parse read is re-hashed and
 *      compared (`pageParseCache.ts` does this). An mtime means nothing to a
 *      new process — a checkout rewrites every one without changing a byte —
 *      so the disk tier compares SHA-256 of the bytes, and a missing file
 *      recorded as missing must still be missing.
 *
 * On top of those, the identity fields — project directory, route, locale,
 * config hash, and the parser-code fingerprint (`parserCodeDigest.ts`) — must
 * all match, so an entry moved to another project, or written by an older
 * parser, is a miss. Anything that fails is simply not used: the route is
 * parsed afresh and the entry overwritten. Nothing here throws into a load.
 *
 * ## Writing inside someone else's repository
 *
 *   - **No symlink escapes.** Every directory from the project root down to
 *     `parse/` must be a real directory — checked with `lstat` BEFORE creating
 *     the next one, so a `.studio/cache` symlinked to elsewhere is refused
 *     before `mkdir` can follow it. Entry files are written to a fresh
 *     exclusive temp name and renamed over the target, which replaces a
 *     symlinked target rather than writing through it.
 *   - **Never committed.** `.studio/` is excluded from Studio's own staging
 *     (`gitPaths.ts` refuses the segment) and from every `.gitignore` Studio
 *     scaffolds, and this repo's `.gitignore` names `**\/.studio/cache/`. A
 *     user's pre-existing `.gitignore` is theirs and is never edited, so the
 *     store also drops a `.gitignore` of `*` into `parse/` itself: git ignores
 *     the directory from the inside, whatever the root file says.
 *   - **Bounded.** One file per route and locale, overwritten in place; a
 *     sweep keeps at most {@link MAX_ENTRIES}, oldest first.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ComponentSource, ParsedPage } from '@core/page-parser'
import { safeParseJson } from '@core/utils/jsonValidate'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { resolveStudioDataRoot } from '../../runtimeDirs'
import { sha256Hex } from './loadDigest'
import { PARSE_CACHE_FORMAT, parserCodeDigest } from './parserCodeDigest'

/** The cached result of one route's parse — what the in-memory tier holds too. */
export interface CachedRouteParse {
  expanded: ParsedPage
  componentSources: Record<string, ComponentSource>
}

/** One dependency as the disk tier records it: absolute path and SHA-256 of its bytes (`null`: the file did not exist). */
export interface StoredDependency {
  file: string
  digest: string | null
}

/** Project-relative location of the store. */
const STORE_SEGMENTS = ['.studio', 'cache', 'parse'] as const

/** Kept entries per project, and what a sweep trims back to. */
export const MAX_ENTRIES = 1_000
const SWEEP_TO = 800

/** An entry larger than this is not read — a parsed page is kilobytes to a few megabytes. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const ENTRY_NAME_RE = /^[0-9a-f]{64}\.json$/
const SIGNATURE_HEX_LENGTH = 64

/**
 * The payload's shape. `expanded`/`componentSources` are checked to their outer
 * shape only and typed through `Type.Unsafe`: the parser's own types are
 * interfaces with no schema (and a hand-written mirror of `ParsedNode` would
 * drift), and the signature — not a schema — is what vouches for the inside:
 * these bytes are exactly what this server serialised from a real parse.
 */
const StoredParseSchema = Type.Object({
  format: Type.Literal(PARSE_CACHE_FORMAT),
  parser: Type.String(),
  dir: Type.String(),
  route: Type.String(),
  preferredKey: Type.Union([Type.String(), Type.Null()]),
  configHash: Type.String(),
  deps: Type.Array(Type.Object({ file: Type.String({ minLength: 1 }), digest: Type.Union([Type.String(), Type.Null()]) })),
  result: Type.Object({
    expanded: Type.Unsafe<ParsedPage>(
      Type.Object({ rootIds: Type.Array(Type.String()), nodes: Type.Record(Type.String(), Type.Object({})) }),
    ),
    componentSources: Type.Unsafe<Record<string, ComponentSource>>(
      Type.Record(Type.String(), Type.Object({ kind: Type.String() })),
    ),
  }),
})

type StoredParse = Static<typeof StoredParseSchema>

/** What identifies one entry: whose, which route, under which locale. */
export interface StoredParseKey {
  /** Absolute project directory. */
  dir: string
  /** The route half of the in-memory cache key: a page's relative path, an App Router route file, or `story:<pageId>`. */
  route: string
  preferredKey: string | undefined
}

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

const KEY_FILE_NAME = 'parse-cache.key'
const keysByRoot = new Map<string, Buffer | null>()

function isInside(parent: string, child: string): boolean {
  const withSep = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child === parent || child.startsWith(withSep)
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path)
  } catch (_err) {
    return resolve(path)
  }
}

/**
 * The HMAC key, from `<data root>/parse-cache.key` (created on first use), or
 * `null` when there is no safe place for it — which turns the disk tier off.
 *
 * The one unsafe place is inside the project itself: a process whose data
 * root resolves under the project (the Stop hook runs with the project as its
 * working directory, and the data root falls back to `<cwd>/.data`) would
 * otherwise write the secret into the very repository it protects, next to
 * the entries it signs.
 */
export function parseCacheSigningKey(dir: string): Buffer | null {
  const root = resolveStudioDataRoot()
  if (isInside(realOrResolved(dir), realOrResolved(root))) return null
  const known = keysByRoot.get(root)
  if (known !== undefined) return known
  const keyFile = join(root, KEY_FILE_NAME)
  let key: Buffer | null = null
  try {
    key = readKey(keyFile)
  } catch (err) {
    console.error('[studio:parseCacheStore] signing key unavailable; the on-disk parse cache is off:', err)
  }
  keysByRoot.set(root, key)
  return key
}

function readKey(keyFile: string): Buffer {
  try {
    return parseKey(readFileSync(keyFile, 'utf8'))
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
  mkdirSync(resolveStudioDataRoot(), { recursive: true })
  try {
    // `wx`: two processes racing to create it — the loser reads the winner's.
    writeFileSync(keyFile, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if (!isAlreadyExists(err)) throw err
  }
  return parseKey(readFileSync(keyFile, 'utf8'))
}

function parseKey(text: string): Buffer {
  const hex = text.trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('parse cache signing key is malformed')
  return Buffer.from(hex, 'hex')
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

function isNotFound(err: unknown): boolean {
  return errorCode(err) === 'ENOENT'
}

function isAlreadyExists(err: unknown): boolean {
  return errorCode(err) === 'EEXIST'
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex')
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function entryName(key: StoredParseKey): string {
  return `${sha256Hex(JSON.stringify([resolve(key.dir), key.route, key.preferredKey ?? null]))}.json`
}

/** Whether `path` is a real directory — never a symlink, never absent. */
function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (_err) {
    return false
  }
}

/**
 * The store directory, creating what is missing — or `null` when any step of
 * the chain is not a real directory. Each existing component is `lstat`ed
 * before the next is created, so nothing is ever created through a symlink.
 */
function storeDirForWrite(dir: string): string | null {
  let current = resolve(dir)
  if (!isRealDirectory(current)) return null
  for (const segment of STORE_SEGMENTS) {
    current = join(current, segment)
    try {
      mkdirSync(current)
    } catch (err) {
      if (!isAlreadyExists(err)) return null
    }
    if (!isRealDirectory(current)) return null
  }
  ensureSelfIgnore(current)
  return current
}

/** The store directory when it already exists as a chain of real directories, else `null`. */
function storeDirForRead(dir: string): string | null {
  let current = resolve(dir)
  for (const segment of STORE_SEGMENTS) {
    current = join(current, segment)
    if (!isRealDirectory(current)) return null
  }
  return current
}

/** `parse/.gitignore` — see this module's doc. Written once, never over an existing file. */
function ensureSelfIgnore(storeDir: string): void {
  try {
    writeFileSync(join(storeDir, '.gitignore'), '# Studio parse cache: derived, disposable, never committed.\n*\n', { flag: 'wx' })
  } catch (err) {
    if (!isAlreadyExists(err)) console.error('[studio:parseCacheStore] could not write the cache .gitignore:', err)
  }
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** A stored entry whose signature and identity check out — its dependencies are still for the caller to verify. */
export interface StoredRouteParse {
  configHash: string
  deps: readonly StoredDependency[]
  result: CachedRouteParse
}

/** The stored entry for `key`, or `null` for anything short of a genuine, matching entry. See this module's doc. */
export function readStoredRouteParse(key: StoredParseKey): StoredRouteParse | null {
  const signingKey = parseCacheSigningKey(key.dir)
  const parser = parserCodeDigest()
  if (!signingKey || !parser) return null
  const storeDir = storeDirForRead(key.dir)
  if (!storeDir) return null
  const file = join(storeDir, entryName(key))

  let text: string
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) return null
    text = readFileSync(file, 'utf8')
  } catch (_err) {
    return null // no entry yet — the ordinary cold case
  }

  if (text.charAt(SIGNATURE_HEX_LENGTH) !== '\n') return null
  const signature = Buffer.from(text.slice(0, SIGNATURE_HEX_LENGTH), 'hex')
  const payload = text.slice(SIGNATURE_HEX_LENGTH + 1)
  const expected = Buffer.from(sign(signingKey, payload), 'hex')
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null

  const parsed = safeParseJson(payload, StoredParseSchema)
  if (!parsed.ok) return null
  const entry: StoredParse = parsed.value
  if (
    entry.parser !== parser ||
    entry.dir !== resolve(key.dir) ||
    entry.route !== key.route ||
    entry.preferredKey !== (key.preferredKey ?? null)
  ) {
    return null
  }
  return { configHash: entry.configHash, deps: entry.deps, result: entry.result }
}

/**
 * `result` as JSON, or `null` when it would not survive the round trip — a
 * non-finite number becomes `null`, a `Map` becomes `{}`. Such an entry is
 * simply not stored; the in-memory tier still holds the real value.
 */
function roundTrippableJson(value: unknown): string | null {
  let lossy = false
  const json = JSON.stringify(value, function replacer(this: unknown, _key, item: unknown) {
    if (typeof item === 'number' && !Number.isFinite(item)) lossy = true
    else if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') lossy = true
    else if (item instanceof Map || item instanceof Set) lossy = true
    else if (item === undefined && Array.isArray(this)) lossy = true
    return item
  })
  return lossy ? null : json
}

const writesSinceSweep = new Map<string, number>()
const SWEEP_EVERY_WRITES = 200

/** Persists one entry. Best-effort: a failure is logged and the load carries on with the in-memory tier. */
export function writeStoredRouteParse(
  key: StoredParseKey,
  configHash: string,
  deps: readonly StoredDependency[],
  result: CachedRouteParse,
): void {
  const signingKey = parseCacheSigningKey(key.dir)
  const parser = parserCodeDigest()
  if (!signingKey || !parser) return
  const resultJson = roundTrippableJson(result)
  if (resultJson === null) return
  const storeDir = storeDirForWrite(key.dir)
  if (!storeDir) return

  const envelope: Omit<StoredParse, 'result'> = {
    format: PARSE_CACHE_FORMAT,
    parser,
    dir: resolve(key.dir),
    route: key.route,
    preferredKey: key.preferredKey ?? null,
    configHash,
    deps: [...deps],
  }
  // The result is spliced in as already-serialised text, so the whole payload
  // is serialised exactly once.
  const payload = `${JSON.stringify(envelope).slice(0, -1)},"result":${resultJson}}`
  const target = join(storeDir, entryName(key))
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${sign(signingKey, payload)}\n${payload}`, { flag: 'wx' })
    renameSync(temp, target)
  } catch (err) {
    console.error('[studio:parseCacheStore] could not write a parse cache entry:', err)
    try {
      unlinkSync(temp)
    } catch (_cleanupErr) {
      // Never created, or already renamed — nothing to clean up.
    }
    return
  }

  const writes = (writesSinceSweep.get(storeDir) ?? SWEEP_EVERY_WRITES) + 1
  writesSinceSweep.set(storeDir, writes)
  if (writes > SWEEP_EVERY_WRITES) {
    writesSinceSweep.set(storeDir, 0)
    sweep(storeDir)
  }
}

/** Keeps the store at most {@link MAX_ENTRIES} entries, dropping the least recently written. Also clears temp files a crashed write left behind. */
function sweep(storeDir: string): void {
  let names: string[]
  try {
    names = readdirSync(storeDir)
  } catch (_err) {
    return
  }
  const entries: Array<{ file: string; mtimeMs: number }> = []
  for (const name of names) {
    const file = join(storeDir, name)
    if (name.endsWith('.tmp')) {
      removeQuietly(file)
      continue
    }
    if (!ENTRY_NAME_RE.test(name)) continue
    try {
      entries.push({ file, mtimeMs: statSync(file).mtimeMs })
    } catch (_err) {
      // Removed by a concurrent sweep.
    }
  }
  if (entries.length <= MAX_ENTRIES) return
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const { file } of entries.slice(0, entries.length - SWEEP_TO)) removeQuietly(file)
}

function removeQuietly(file: string): void {
  try {
    unlinkSync(file)
  } catch (_err) {
    // Already gone.
  }
}

/** Test-only: forget the cached signing keys (a test that points `STUDIO_DATA_DIR` elsewhere). */
export function clearParseCacheSigningKeys(): void {
  keysByRoot.clear()
  writesSinceSweep.clear()
}
