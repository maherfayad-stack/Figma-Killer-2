/**
 * devServerRecords — the on-disk half of `devServer.ts`'s registry (`live-11`):
 * what lets a ready dev server outlive the process that spawned it.
 *
 * `bun --watch` restarts the API server in place on every source change, and
 * a crash or a deploy restarts it for real. The registry is in-memory, the
 * Vite child is not — so without a record every restart forgot its children
 * (one orphaned Vite per restart, still bound to its port) while the proxy
 * answered `'stopped'` and the next board open spawned another. One record per
 * app root lives here, written the moment an entry reaches `'ready'`, deleted
 * on stop/exit/failure, and read back by `devServer.ts`'s `adoptEntry` on a
 * registry miss. The two default checks adoption runs — is the pid alive, does
 * the origin still answer the project's base path — live beside it.
 *
 * Machine-local and gitignored (`.tmp/dev-servers/`), never inside the user's
 * project: a pid and a port are facts about THIS machine's session.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** How long an adopted origin gets to answer its base path before the record is judged stale. */
const ADOPT_PROBE_TIMEOUT_MS = 3_000

export async function probeDevServerOrigin(baseUrl: string, basePath: string): Promise<boolean> {
  // `baseUrl` is whatever "Local:" line Vite printed — WITH the project's base
  // path when Studio spawned it (`http://127.0.0.1:5173/p/<key>`), so the
  // path is REPLACED, never appended, exactly as `liveOrigin.ts`'s
  // `resolveUpstreamUrl` does for every proxied request.
  const target = new URL(baseUrl)
  target.pathname = basePath
  target.search = ''
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(ADOPT_PROBE_TIMEOUT_MS), redirect: 'manual' })
    return res.status < 500
  } catch {
    return false
  }
}

/** Relocates the records directory; read per call so a test can point it at a temp dir. */
export const STUDIO_DEV_SERVER_STATE_DIR_ENV = 'STUDIO_DEV_SERVER_STATE_DIR'

/** Machine-local, gitignored, and never inside a user's project: a pid and a port are facts about THIS machine's session, not about the project. */
function devServerStateDir(): string {
  const override = process.env[STUDIO_DEV_SERVER_STATE_DIR_ENV]
  return override ? resolve(override) : join(process.cwd(), '.tmp', 'dev-servers')
}

const DevServerRecordSchema = Type.Object({
  appRoot: Type.String(),
  projectKey: Type.String(),
  pid: Type.Integer({ minimum: 1 }),
  baseUrl: Type.String(),
  startedAt: Type.Integer(),
  packageManager: Type.String(),
  devScript: Type.String(),
})
export type DevServerRecord = Static<typeof DevServerRecordSchema>

function recordPath(appRoot: string): string {
  return join(devServerStateDir(), `${Bun.hash(appRoot).toString(16)}.json`)
}

export function readDevServerRecord(appRoot: string): DevServerRecord | null {
  let raw: string
  try {
    raw = readFileSync(recordPath(appRoot), 'utf8')
  } catch {
    return null
  }
  // A truncated or hand-edited file is the same as no record; a hash
  // collision or a copied file must not pass as a record about THIS root.
  const parsed = safeParseJson(raw, DevServerRecordSchema)
  return parsed.ok && parsed.value.appRoot === appRoot ? parsed.value : null
}

export function writeDevServerRecord(record: DevServerRecord): void {
  try {
    mkdirSync(devServerStateDir(), { recursive: true })
    writeFileSync(recordPath(record.appRoot), JSON.stringify(record), 'utf8')
  } catch (err) {
    // A record is an optimisation for the NEXT process; this one runs fine without it.
    console.error('[devServer] could not write the dev-server record:', err)
  }
}

export function deleteDevServerRecord(appRoot: string): void {
  rmSync(recordPath(appRoot), { force: true })
}
