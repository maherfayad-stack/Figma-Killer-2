/**
 * idempotentReplay — durable replay protection for the Studio write routes
 * where a lost response must never turn into a second effect: `POST
 * /admin/api/studio/save` (structural edits — duplicate/insert/wrap/group/
 * move/…), `POST`/`DELETE /admin/api/studio/page`, `POST
 * /admin/api/studio/boards`, and `POST /admin/api/studio/asset-drop` (IMG-1:
 * a retried image landing would otherwise write `photo-2.png`; that route is
 * also idempotent by content, since `landAssetBytes` dedupes, so a retry whose
 * record was lost still reuses the first file rather than copying it).
 *
 * ## The gap this closes
 *
 * `@core/http`'s gateway-retry (`src/core/http/apiClient.ts`) is provably
 * safe for ECONNREFUSED: an empty-bodied 502/503/504 from the dev proxy when
 * nothing is listening means the request never reached a handler. It is NOT
 * provably safe for a connection RESET mid-flight — `bun --watch` restarts
 * on a file change (often the very file the handler just wrote), and a
 * handler can finish its disk write and then die before the response
 * headers go out. Vite's dev proxy collapses both failure shapes into the
 * same empty-bodied 502, so the client cannot tell "never ran" apart from
 * "ran and died before answering". A blind retry of the second case would
 * re-run a `duplicate` edit and write a second copy into the user's source.
 *
 * The fix moves the safety proof from the client (a guess based on the
 * response shape) to the server (a fact): the client mints one request id
 * per logical write attempt and resends the SAME id on every retry of that
 * attempt (`X-Studio-Idempotency-Key` — see `apiClient.ts`'s
 * `IDEMPOTENT_REPLAY_PATHS`). The first time this server sees a key, it runs
 * the route and durably records the response against the key before
 * returning it. Every later request carrying the SAME key gets that stored
 * response back, verbatim, WITHOUT running the route again.
 *
 * ## Where the record lives, and why
 *
 * `.data/studio-idempotency/<key>.json` — the server's own data root, the
 * same convention `mcpServerSecretStore.ts`'s `resolveMcpServerSecretsRoot`
 * already uses for state that must survive a restart and must never ride
 * along with a project's own repo. Deliberately NOT `.studio/`, even though
 * that folder already hosts a gitignored cache tier
 * (`pageVerificationStore.ts`'s `.studio/cache/`): this record has nothing
 * to do with any one project's content, and the one failure mode this
 * feature exists to survive is `bun --watch` restarting because a file
 * under the WORKSPACE ROOT changed — writing this store's own churn into a
 * directory the file watcher already reacts to would be exactly the kind of
 * scratchpad use `.studio/` must not become. `.data/` is watched by
 * nothing, is entirely git-ignored, and lives outside `studio-workspace/**`.
 *
 * Deliberately ON DISK, not an in-memory `Map`: the failure this module
 * exists to survive IS the server process dying and a fresh one starting —
 * an in-memory record is erased in exactly the instant a retry needs it.
 *
 * ## The window this does NOT close
 *
 * The record is written AFTER the route's handler has produced its result,
 * so a crash between "the edit landed on disk" and "this module's own
 * write-then-rename finished" is still unprotected — a retry landing in
 * that instant would still re-run and double-write. That window shrank from
 * "the whole codemod batch plus a network round trip" to "one small JSON
 * file's own write, immediately after the handler returns" — several orders
 * of magnitude smaller, but not zero. Closing it completely would need the
 * idempotency record and the source edit to commit in one transaction,
 * which two separate filesystem writes cannot offer without deeper coupling
 * into the codemod/writeback engine itself (out of this change's scope).
 * Named here rather than pretended away.
 *
 * ## TTL, not a growing ledger
 *
 * Records expire after {@link RECORD_TTL_MS} — long enough to outlast a
 * `bun --watch` restart and the client's own retry ladder several times
 * over, short enough that this directory never becomes a real store.
 * Pruned opportunistically on every successful write; nothing needs a cron.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'

const DEFAULT_DATA_ROOT_SEGMENT = ['.data', 'studio-idempotency'] as const

/** Resolve (without creating) the data root — overridable via env, same convention as `resolveMcpServerSecretsRoot`. */
export function resolveIdempotencyRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.STUDIO_IDEMPOTENCY_DATA_DIR
  return configured ? resolve(configured) : resolve(process.cwd(), ...DEFAULT_DATA_ROOT_SEGMENT)
}

/** How long a record answers a replay for — see the module doc's TTL section. */
export const RECORD_TTL_MS = 5 * 60 * 1000

/** The exact shape `crypto.randomUUID()` mints — the only shape accepted as a filename-safe key. */
const KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The header carrying the client's per-attempt request id — the SAME value
 * on the original send and every retry of it. `null` for an absent or
 * malformed value (an older client, a route this feature doesn't cover, or
 * a tampered header); never let an arbitrary header value become a
 * filename.
 */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get('x-studio-idempotency-key')
  return raw && KEY_SHAPE.test(raw) ? raw.toLowerCase() : null
}

/** Validated at the read boundary — no `JSON.parse(...) as` cast on a file this module itself controls the shape of, but which a stale/half-written/foreign file on disk could still fail to match. */
const StoredReplaySchema = Type.Object({
  status: Type.Number(),
  contentType: Type.String(),
  body: Type.String(),
  storedAtMs: Type.Number(),
})
type StoredReplay = Static<typeof StoredReplaySchema>

function recordPath(root: string, key: string): string {
  return join(root, `${key}.json`)
}

function readRecord(root: string, key: string): StoredReplay | null {
  let raw: string
  try {
    raw = readFileSync(recordPath(root, key), 'utf8')
  } catch {
    return null
  }
  const parsed = safeParseJson(raw, StoredReplaySchema)
  if (!parsed.ok) return null
  if (Date.now() - parsed.value.storedAtMs > RECORD_TTL_MS) return null
  return parsed.value
}

/** Write-to-a-fresh-name-then-rename: a reader never sees a half-written record, and a crash mid-write leaves no record at all — the safe direction (falls back to "never seen this key", not to a corrupt one). */
function writeRecord(root: string, key: string, record: StoredReplay): void {
  mkdirSync(root, { recursive: true })
  const path = recordPath(root, key)
  const staging = `${path}.${crypto.randomUUID()}.tmp`
  writeFileSync(staging, JSON.stringify(record))
  renameSync(staging, path)
}

/** Best-effort cleanup of expired records. Never throws, never blocks the response it runs alongside. */
function pruneExpired(root: string): void {
  let entries: string[]
  try {
    entries = existsSync(root) ? readdirSync(root) : []
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const full = join(root, entry)
    try {
      if (now - statSync(full).mtimeMs > RECORD_TTL_MS) rmSync(full, { force: true })
    } catch {
      // Another process already removed it, or it's mid-write via the staging
      // rename above — either way, leave it for the next prune.
    }
  }
}

/**
 * Wraps a Studio write route with idempotent replay. `run` is the route's
 * existing try/catch body, unchanged — this only decides whether to call it.
 *
 *   - No key on the request (an older client, or a route this feature
 *     doesn't cover) → runs `run()` directly, exactly as before this module
 *     existed.
 *   - A key the store has never seen (or whose record expired) → runs
 *     `run()`. If it SUCCEEDED (2xx) the response is durably recorded before
 *     being returned — a non-2xx (a 404/409 refusal) is safe to just
 *     recompute on the next attempt, since nothing changed on disk to make
 *     the recomputed answer differ, so it is never cached.
 *   - A key the store already has a fresh record for → returns that record
 *     verbatim, WITHOUT calling `run()` at all. This is the whole point: the
 *     route's real side effect, if any, already happened exactly once.
 */
export async function withIdempotentReplay(
  req: Request,
  run: () => Promise<Response>,
  root: string = resolveIdempotencyRoot(),
): Promise<Response> {
  const key = readIdempotencyKey(req)
  if (!key) return run()

  const existing = readRecord(root, key)
  if (existing) {
    return new Response(existing.body, {
      status: existing.status,
      headers: { 'content-type': existing.contentType },
    })
  }

  const res = await run()
  if (res.status >= 200 && res.status < 300) {
    const body = await res.clone().text()
    writeRecord(root, key, {
      status: res.status,
      contentType: res.headers.get('content-type') ?? 'application/json',
      body,
      storedAtMs: Date.now(),
    })
    pruneExpired(root)
  }
  return res
}
