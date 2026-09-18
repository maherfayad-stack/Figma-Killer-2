/**
 * The disposable E2E stack's addresses and data roots — one source of truth for
 * the three processes that have to agree on them.
 *
 * Who reads this, and why it cannot be three copies of the same literals:
 *
 *   - `playwright.config.ts` needs the admin origin (its `baseURL` and its
 *     `webServer.url` readiness probe) and has to hand the ports plus the CSRF
 *     origin down to the stack it spawns.
 *   - `scripts/e2e-dev.ts` binds the two servers to those ports and creates the
 *     throwaway workspace copy at {@link E2E_WORKSPACE_DIR}.
 *   - `tests/e2e/helpers/constants.ts` re-exports them to the specs, three of
 *     which write fixture projects into the workspace root and would 404 on
 *     `resolveProjectDir`'s containment check if they wrote to a different one
 *     than the server reads.
 *
 * Every value is overridable by the matching environment variable, so a second
 * agent can run an isolated stack on its own ports without editing anything —
 * but the OVERRIDE has to reach all three processes, which is why they read the
 * same variable through the same module rather than each inventing a default.
 *
 * Paths resolve against `process.cwd()`, which is the repository root for all
 * three: `bun run test:e2e` is run from there, Playwright starts `webServer`
 * with `cwd` set to the config's own directory (the repo root), and the specs
 * inherit the runner's cwd.
 */
import { resolve } from 'node:path'

/** Vite dev server port — the origin a browser actually talks to. */
export const E2E_VITE_PORT = process.env.E2E_VITE_PORT ?? '5174'

/** Bun CMS/API port. Also the public (visitor-facing) origin. */
export const E2E_CMS_PORT = process.env.E2E_CMS_PORT ?? '3002'

/** Admin origin. `VITE_ALLOWED_ORIGIN` must equal this or every POST 403s. */
export const E2E_ADMIN_ORIGIN = process.env.E2E_ADMIN_BASE_URL ?? `http://127.0.0.1:${E2E_VITE_PORT}`

/** Public (visitor-facing) origin. Different port → always a fresh context. */
export const E2E_PUBLIC_ORIGIN = process.env.E2E_PUBLIC_BASE_URL ?? `http://127.0.0.1:${E2E_CMS_PORT}`

/**
 * The Studio workspace root the e2e stack reads and writes — a THROWAWAY COPY
 * of the repository's `studio-workspace/`, not the tracked tree itself.
 *
 * `scripts/e2e-dev.ts` re-creates it from `studio-workspace/` on every start
 * and exports it to both servers as `STUDIO_WORKSPACE_DIR`, the documented
 * override `server/handlers/studioProjects.ts`'s `projectsRootDir()` reads per
 * call. That is what keeps `git status --porcelain studio-workspace/` empty
 * after a run: `auth.setup.ts` stamping `lastOpenedAt`, the shell scaffolder
 * regenerating `prototype/*`, and the framework compiler dropping a
 * `.studio/framework.json` all land in here instead.
 *
 * It lives under `.tmp/` (git-ignored, and on `vite.config.ts`'s watcher
 * ignore list) rather than an OS temp dir so that a failed run leaves the
 * evidence next to the disposable database and uploads it belongs with.
 */
export const E2E_WORKSPACE_DIR = resolve(process.env.E2E_WORKSPACE_DIR ?? '.tmp/e2e-workspace')

/** The tracked workspace the throwaway copy is made from. Never written by a run. */
export const E2E_WORKSPACE_SOURCE_DIR = resolve('studio-workspace')
