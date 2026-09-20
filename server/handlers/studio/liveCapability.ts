/**
 * liveCapability — can this project's real app actually be RUN, and if not,
 * why not, in one word the UI can say out loud.
 *
 * One consumer today: the `Static · Live` pill in the canvas chrome (P8),
 * which has to say which runtime the user is looking at and, when it is the
 * static one, whether "Run the real app" is even on the table. (Until
 * 2026-09-20 this also gated `trustTier.ts`'s now-retired automatic Tier 2
 * promotion — every project starts at `run-project` by default now, so there
 * is nothing left to auto-promote.) Kept as its own module rather than a
 * helper inside the pill for the usual reason: a capability the CLIENT
 * asserts is not the same thing as a decision the SERVER computes, even with
 * one caller.
 *
 * ## The two conditions, and why each one
 *
 *   - **Vite.** Running the app means spawning its dev server and framing it
 *     (`devServer.ts` + `server/liveOrigin.ts`), and the whole live path — the
 *     `virtual:studio-runtime` module, the `data-node-id` stamping plugin, the
 *     `/p/<projectKey>/` base path — is a Vite plugin. A Next/CRA project is
 *     not "unsupported forever", it is §6 decision 5: deferred. Reported as
 *     `not-vite` so the pill can say "Live needs Vite" instead of offering a
 *     button that would fail.
 *   - **A lockfile.** A dev server with no resolved dependency set either
 *     fails to boot or boots against whatever `node_modules` happens to be
 *     lying around. A lockfile is the cheapest honest proxy for "this project
 *     has been installed at least once, on purpose". Reported as
 *     `no-lockfile`, which is actionable: the Dependencies panel installs.
 *
 * Deliberately NOT a check for `node_modules` itself: `styleCompileConsent.ts`
 * already reports that separately, and a project whose `node_modules` was
 * cleaned is still a project that can go live after one install — not one the
 * owner's rule was never meant to cover.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { joinAppRoot } from './appRoot'
import { resolveProjectProfile } from './projectProbe'

/** Every lockfile any package manager Studio recognises writes — the same four `projectProbe.ts`'s `detectPackageManager` reads. */
const LOCKFILES = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] as const

export type LiveBlockedReason = 'not-vite' | 'no-lockfile'

export interface LiveCapability {
  /** The real app can be run: a Vite project that has been installed at least once. */
  capable: boolean
  /** Why not, when `capable` is false. Absent when it is true. */
  reason?: LiveBlockedReason
}

export function resolveLiveCapability(dir: string): LiveCapability {
  const profile = resolveProjectProfile(dir)
  if (profile.framework !== 'vite') return { capable: false, reason: 'not-vite' }
  const appRootAbs = joinAppRoot(dir, profile.appRoot)
  const hasLockfile = LOCKFILES.some((name) => existsSync(join(appRootAbs, name)))
  if (!hasLockfile) return { capable: false, reason: 'no-lockfile' }
  return { capable: true }
}
