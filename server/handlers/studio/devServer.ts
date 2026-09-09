/**
 * Dev-server runtime registry — the reverse `projectKey -> status` lookup
 * `server/liveOrigin.ts` (L2) needs to know whether a project's own dev
 * server is running before it proxies to it.
 *
 * **This is a stub.** The real implementation (L1, `STATE.md` `live-01`)
 * owns spawning, reusing, and idle-tearing-down one dev-server subprocess
 * per project, gated on `trust === 'run-project'` — none of that exists yet.
 * Until L1 lands and replaces this function's body with a live in-memory
 * registry keyed by `projectKey` (`registeredMcpServerProjectKey(dir)`),
 * `getDevServerStatus` always reports "no such project" so every caller
 * (currently only L2's proxy) fails closed to a 404/503 instead of ever
 * proxying to something that doesn't exist. The exported types are the real,
 * final contract L1 must implement — only the function body below is
 * temporary.
 */

export type DevServerPhase = 'stopped' | 'booting' | 'ready' | 'failed'

export interface DevServerStatus {
  /** Absolute path of the project directory this status describes. */
  dir: string
  phase: DevServerPhase
  /** The dev server's own origin, e.g. `http://127.0.0.1:5173`. Never sent to the browser — server-internal only. */
  url: string
}

/**
 * Synchronous, in-memory lookup of a project's dev-server runtime status by
 * its `projectKey` (`registeredMcpServerProjectKey(dir)` —
 * `server/ai/drivers/registeredMcpServers.ts`). No filesystem or network
 * call: this reads an in-process registry only.
 *
 * Always `undefined` until L1 ships. See module doc comment.
 */
export function getDevServerStatus(_projectKey: string): DevServerStatus | undefined {
  return undefined
}
