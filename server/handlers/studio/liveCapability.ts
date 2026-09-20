/**
 * liveCapability — can this project's real app actually be RUN by Studio,
 * and if not, why not, in one word the UI can say out loud.
 *
 * Two consumers, one answer:
 *   - the `Static · Live` pill in the canvas chrome, which has to say which
 *     runtime the user is looking at, and — for a project that can never go
 *     live — say why instead of claiming "Live" over a static fallback;
 *   - `devServer.ts`'s spawner, which refuses to start anything this says it
 *     cannot frame. That is the gate that matters: every project is Tier 2
 *     by default (`DEFAULT_TRUST_TIER`) and the canvas prewarms the dev
 *     server on mount, so without it any imported repository's `dev`/`start`
 *     script — `next dev`, `node server.js`, `curl … | sh` — would run on
 *     first open whether or not Studio could do anything with the result
 *     (`sec-20`).
 *
 * ## The one condition: the script Studio would run is `vite`
 *
 * Running the app means spawning its dev server and framing it
 * (`devServer.ts` + `server/liveOrigin.ts`), and the whole live path — the
 * `virtual:studio-runtime` module, the `data-node-id` stamping plugin, the
 * `/p/<projectKey>/` base path — is a Vite plugin. So the rule is stated on
 * the one thing that will actually execute: the `dev` (else `start`) script
 * in `package.json` must invoke `vite`, optionally through a runner
 * (`npx vite`, `bunx vite --port 4000`). Anything else is `not-vite` — the
 * pill says "Live needs Vite", the spawner never spawns. A Next/CRA project
 * is not "unsupported forever", it is §6 decision 5: deferred.
 *
 * Deliberately NOT the probed `framework`, and NOT "has a `vite.config`":
 * Studio's own shell scaffold writes a `vite.config.js` into every project
 * it opens, so a config-shaped rule would be satisfied by Studio itself; and
 * the cached profile can lag (a project probed before the shell existed says
 * `unknown` for good). The script text is what runs; judge that.
 *
 * Deliberately NOT a check for a lockfile or `node_modules` either: a dev
 * server with nothing installed simply fails to boot, `devServer.ts` records
 * `'failed'` with the log, and the board stays on its static fallback — the
 * honest outcome, and the Dependencies panel is the fix.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppRoot } from './appRoot'

export type LiveBlockedReason = 'not-vite'

export interface LiveCapability {
  /** The real app can be run and framed: its dev script is a `vite` invocation. */
  capable: boolean
  /** Why not, when `capable` is false. Absent when it is true. */
  reason?: LiveBlockedReason
}

/** The script `devServer.ts` would run: `dev` when present, else `start`. */
export interface DevScript {
  name: 'dev' | 'start'
  command: string
}

/** Reads `package.json` at `appRoot` and picks the script a dev server would run. `null` when there is none. Never throws. */
export function resolveDevScript(appRoot: string): DevScript | null {
  const pkgPath = join(appRoot, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const scripts = (parsed as Record<string, unknown>).scripts
    if (!scripts || typeof scripts !== 'object') return null
    const map = scripts as Record<string, unknown>
    if (typeof map.dev === 'string') return { name: 'dev', command: map.dev }
    if (typeof map.start === 'string') return { name: 'start', command: map.start }
    return null
  } catch {
    return null
  }
}

/** `vite`, `vite dev --port 4000`, `npx vite`, `bunx vite`, `pnpm exec vite`, `yarn vite` — and nothing else. */
const VITE_INVOCATION = /^\s*(?:(?:npx|bunx|pnpm|yarn)\s+(?:exec\s+)?)?vite(?:\s|$)/

export function resolveLiveCapability(dir: string): LiveCapability {
  const script = resolveDevScript(resolveAppRoot(dir))
  if (!script || !VITE_INVOCATION.test(script.command)) return { capable: false, reason: 'not-vite' }
  return { capable: true }
}
