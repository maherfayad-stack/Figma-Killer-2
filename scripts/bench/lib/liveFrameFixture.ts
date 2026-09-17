/**
 * liveFrameFixture — L8 Phase B (`perf-06`, STATE.md). Produces a bootable
 * Tier-2 project for benches that need a REAL live board (warm-reopen →
 * first paint, memory-per-live-frame) — neither buildable in this SAME
 * change (both are blocked on `perf-06`'s own Phase A "human dogfood" gate;
 * see `studioBoard.bench.ts`'s header doc and STATE.md's `perf-06` entry).
 * This file is written and ready anyway, so whoever picks this up once that
 * gate clears doesn't also have to re-derive the fixture shape from scratch.
 *
 * `studioBoard.bench.ts`'s own `generateSyntheticProject` writes bare
 * `.tsx` files with no `package.json`/`node_modules` — perfect for a
 * pure-parse/pure-canvas budget, but it cannot boot a real Vite dev server
 * at all (Tier 2's whole premise). Rather than making that 20k-node
 * synthetic fixture npm-installable, this COPIES `studio-workspace/test4
 * copy` — already real, already has `node_modules`, already the Track L
 * dogfood target (`live-08`'s own PR #106 dogfood used the same source
 * project) — into an ephemeral `studio-workspace/__bench-live-synth/`, then
 * flips the COPY's `.studio/meta.json` `trust` to `'run-project'`.
 *
 * The source project is LOCAL dogfooding data and is not tracked in git
 * (`.gitignore`, plan §6 decision 4) — a fresh clone has to supply it, and
 * `createLiveFrameFixture()` says exactly that when it is absent.
 *
 * Two invariants this file exists to get right, both landmines a previous
 * session already hit once:
 *
 *   1. **MUST generate under `studio-workspace/`.** `resolveProjectDir`
 *      (`server/handlers/studioProjects.ts`) 404s any `dir` outside
 *      `projectsRootDir()`'s containment check — `panel-23`'s own
 *      `__bench-synth` fixture hit exactly this bug first (see
 *      `studioBoard.bench.ts`'s own doc comment on `projectDir`). A fixture
 *      generated anywhere else (e.g. under this repo's `.tmp/`) 404s
 *      silently on load, with no diagnostic beyond a hung `waitForSelector`.
 *   2. **Copy `test4 copy`, never touch it.** The checked-in project can
 *      carry in-flight, uncommitted edits from other parallel sessions at
 *      any given moment (this repo's own multi-agent posture — see
 *      `CLAUDE.md`'s "Parallel sessions" section) — mutating its
 *      `.studio/meta.json` directly would leak a bench-only trust
 *      promotion into someone else's working tree. This fixture copies
 *      `node_modules` too (not symlinked — Vite's own module resolution
 *      needs to be proven against a real copy before anyone trusts a
 *      symlink shortcut under time pressure), specifically so no bench run
 *      ever needs a network `npm install`.
 */
import { existsSync, cpSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { mergeStudioMeta } from '../../../server/handlers/studio/studioMeta'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

/** The Track L dogfood project this fixture copies from — never mutated directly. */
export const LIVE_FRAME_FIXTURE_SOURCE_DIR = resolve(REPO_ROOT, 'studio-workspace/test4 copy')

/** The ephemeral copy every `createLiveFrameFixture()` call produces and `cleanup()` removes. Fixed name (not per-PID) so a crashed prior run's leftovers are visibly reused/overwritten rather than accumulating `__bench-live-synth-<pid>` directories. */
export const LIVE_FRAME_FIXTURE_DIR = resolve(REPO_ROOT, 'studio-workspace/__bench-live-synth')

export interface LiveFrameFixtureHandle {
  /** Absolute path to the ephemeral, Tier-2-promoted copy — pass this straight to whatever opens `/admin/site` (same shape `studioBoard.bench.ts`'s `projectDir` is used for). */
  dir: string
  /** Removes the ephemeral copy. Idempotent — safe to call even if `createLiveFrameFixture` itself partially failed. Callers MUST call this in a `finally`, mirroring `generateSyntheticProject`'s own lifecycle in `studioBoard.bench.ts`. */
  cleanup: () => void
}

/**
 * Copies `LIVE_FRAME_FIXTURE_SOURCE_DIR` to `LIVE_FRAME_FIXTURE_DIR` (wiping
 * any stale copy from a previous, uncleanly-terminated run first) and sets
 * the copy's trust tier to `'run-project'` via the SAME `mergeStudioMeta`
 * the real `/admin/api/studio/trust-tier` route uses — not hand-rolled JSON
 * editing, so this fixture can never drift from what a real promotion writes.
 *
 * Throws (does not silently no-op) if the source project is missing — a
 * caller getting a confusing 404 later, with no idea why, is worse than a
 * clear failure here naming exactly what's missing.
 */
export function createLiveFrameFixture(): LiveFrameFixtureHandle {
  if (!existsSync(LIVE_FRAME_FIXTURE_SOURCE_DIR)) {
    throw new Error(
      `liveFrameFixture: source project not found at "${LIVE_FRAME_FIXTURE_SOURCE_DIR}" — "studio-workspace/test4 copy" is local dogfooding data, not tracked in git (see .gitignore, plan §6 decision 4), so a fresh clone will not have it. Copy a real Vite project there, or point this bench at one you already have.`,
    )
  }

  rmSync(LIVE_FRAME_FIXTURE_DIR, { recursive: true, force: true })
  cpSync(LIVE_FRAME_FIXTURE_SOURCE_DIR, LIVE_FRAME_FIXTURE_DIR, { recursive: true })
  mergeStudioMeta(LIVE_FRAME_FIXTURE_DIR, { trust: 'run-project' })

  return {
    dir: LIVE_FRAME_FIXTURE_DIR,
    cleanup: () => {
      rmSync(LIVE_FRAME_FIXTURE_DIR, { recursive: true, force: true })
    },
  }
}
