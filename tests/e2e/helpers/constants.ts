/**
 * Shared constants for the automated Playwright E2E suite.
 *
 * The Playwright `webServer` (`scripts/e2e-dev.ts`) resets the disposable
 * `.tmp/e2e-*` database, uploads dir AND Studio workspace once per run and then
 * serves a single shared stack: one admin origin, one public origin, one SQLite
 * database, one throwaway copy of `studio-workspace/`. Every spec runs serially
 * against that shared state (`workers: 1`), so these constants are the single
 * source of truth for the suite identities, origins, and data roots.
 *
 * The addresses themselves live in `scripts/lib/e2eStack.ts`, which
 * `playwright.config.ts` and the stack script read too — see that module for why
 * one copy rather than three.
 */
import { E2E_PUBLIC_ORIGIN, E2E_WORKSPACE_DIR } from '../../../scripts/lib/e2eStack'

/** First-run owner created by the `setup` project and reused by ordinary specs. */
export const OWNER = {
  email: 'owner.e2e@example.com',
  password: 'qwerty123456',
  siteName: 'Automated E2E Site',
} as const

/** Public (visitor-facing) origin. Different port → always a fresh context. */
export const PUBLIC_BASE_URL = E2E_PUBLIC_ORIGIN

/**
 * The Studio workspace root THIS RUN's server reads and writes — a throwaway
 * copy of the repository's `studio-workspace/`, recreated by `scripts/e2e-dev.ts`
 * on every start.
 *
 * Any spec that puts a fixture project on disk, or reads one back, must join
 * onto this and never onto `process.cwd() + 'studio-workspace'`. Two reasons,
 * both load-bearing:
 *
 *   1. A project outside the root the server resolved is rejected by
 *     `resolveProjectDir`'s containment check, and the route answers 404 — so
 *     a spec that writes to the tracked tree simply cannot open what it wrote.
 *   2. A run must leave `git status --porcelain studio-workspace/` empty. Every
 *     write a spec makes — and every write the PRODUCT makes while a spec has
 *     a project open — lands in the copy.
 */
export const WORKSPACE_ROOT = E2E_WORKSPACE_DIR

/**
 * Saved owner authentication state. The `setup` project writes this after
 * first-run setup; specs that opt in start already logged in as the owner.
 */
export const OWNER_STATE_FILE = '.tmp/e2e-owner-state.json'

/**
 * An empty (logged-out) storage state. Specs that **publish** (which triggers a
 * step-up) or **sign out** must opt into this and `login()` fresh, because both
 * actions rotate the session token server-side — reusing the shared owner state
 * would invalidate it for every later spec. Read-only specs keep the fast shared
 * owner state.
 */
export const ANONYMOUS_STATE = { cookies: [], origins: [] }
