/**
 * Agent-turn benchmark (perf-06) — the server-side cost paid before every
 * real Studio chat turn's `claude` subprocess even spawns.
 *
 * `server/ai/drivers/claudeCli.ts` calls `generateStudioAgentRoster(dir)`
 * synchronously, on the critical path, on every real turn against an open
 * project. This bench measures that cost in isolation from the rest of the
 * chat pipeline (no subprocess, no HTTP, no database):
 *
 *   - `generateStudioAgentRoster` COLD — first-ever call for a project: no
 *     `.claude/` roster, no design-system digest cache, no persisted
 *     `ProjectProfile` in `.studio/meta.json`.
 *   - `generateStudioAgentRoster` WARM — every call after the first, with
 *     NOTHING changed. This is the case that matters: it is what every turn
 *     after the first pays, forever, for a project the user never stops
 *     chatting about.
 *   - `resolveProjectProfile` alone, uncached (no persisted profile in
 *     `.studio/meta.json` — the common case for a project imported without
 *     `package.json`, e.g. the "Import design tokens" wizard) vs. cached
 *     (after something has persisted one).
 *   - `getOrBuildDesignSystemDigest` warm (cache already built).
 *
 * Fixture: a fresh copy of `studio-workspace/untitled` (falls back to
 * `studio-workspace/__canonical-fixture`) into `.tmp/benchmarks/`. NEVER
 * mutates the real fixture under `studio-workspace/` — copies first, every
 * run. Self-skips with an `unavailable` row if neither fixture exists,
 * rather than crashing the suite.
 */
import { performance } from 'node:perf_hooks'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs } from '../lib/stats'
import { log } from '../lib/log'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

/** Preference order — `untitled` carries the real 46-file ALM design-system CSS corpus (perf-06's motivating case); `__canonical-fixture` is the fallback for an environment that only has the parser test corpus checked out. */
const CANDIDATE_FIXTURES = ['studio-workspace/untitled', 'studio-workspace/__canonical-fixture'] as const

function findFixtureSource(): string | null {
  for (const rel of CANDIDATE_FIXTURES) {
    const abs = resolve(REPO_ROOT, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

/** Fresh copy, excluding `node_modules`/`.git` (neither fixture should carry either, but this bench must never assume that). Never touches `source` itself. */
function freshFixtureCopy(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop()
      return base !== 'node_modules' && base !== '.git'
    },
  })
}

function wipeGenerated(dir: string): void {
  rmSync(join(dir, '.claude'), { recursive: true, force: true })
  rmSync(join(dir, '.studio', 'cache'), { recursive: true, force: true })
}

/** Strips any persisted `profile` key from `.studio/meta.json` (if present) so the next `resolveProjectProfile*` call is a genuine cold probe — simulates "this project has never been probed/installed", `untitled`'s real starting state. Never times out the bench's timed section — always called between iterations, never inside one. */
function stripPersistedProfile(dir: string): void {
  const path = join(dir, '.studio', 'meta.json')
  if (!existsSync(path)) return
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'profile' in parsed) {
      const { profile: _drop, ...rest } = parsed as Record<string, unknown>
      writeFileSync(path, JSON.stringify(rest, null, 2))
    }
  } catch {
    // Not parsable — leave it; the module under test degrades to {} itself.
  }
}

async function loadAgentRoster() {
  return import('../../../server/handlers/studio/agentRoster')
}
async function loadProjectProbe() {
  return import('../../../server/handlers/studio/projectProbe')
}
async function loadDesignSystemDigest() {
  return import('../../../server/handlers/studio/designSystemDigest')
}

function timeMs(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

function summaryRow(label: string, samples: number[]): BenchRow {
  const s = summarize(samples)
  return {
    label,
    inputs: { n: s.count },
    metrics: { mean: fmtMs(s.mean), p50: fmtMs(s.p50), p95: fmtMs(s.p95), max: fmtMs(s.max) },
  }
}

export const agentTurnBench: BenchModule = {
  name: 'agent-turn',
  title: 'Agent-turn latency (subagent roster generation)',
  description: 'generateStudioAgentRoster cold/warm, resolveProjectProfile, and the design-system digest — the server-side cost paid before every real chat turn spawns.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const source = findFixtureSource()
    if (!source) {
      return {
        name: this.name,
        title: this.title,
        headline: { status: 'unavailable' },
        sections: [
          {
            title: 'Unavailable',
            rows: [
              {
                label: 'fixture',
                metrics: { reason: `unavailable: neither ${CANDIDATE_FIXTURES.join(' nor ')} exists` },
              },
            ],
          },
        ],
      }
    }

    const dir = join(ctx.outputDir, 'agent-turn-fixture')
    log.step(`Copying fixture from ${source.slice(REPO_ROOT.length + 1)}`)
    freshFixtureCopy(source, dir)

    const { generateStudioAgentRoster } = await loadAgentRoster()
    const { resolveProjectProfile, reprobeProjectProfile } = await loadProjectProbe()
    const { getOrBuildDesignSystemDigest } = await loadDesignSystemDigest()

    // ── generateStudioAgentRoster COLD ──────────────────────────────────────
    const coldIters = ctx.quick ? 3 : 5
    log.step(`generateStudioAgentRoster cold x${coldIters}`)
    const coldSamples: number[] = []
    for (let i = 0; i < coldIters; i++) {
      wipeGenerated(dir)
      stripPersistedProfile(dir)
      coldSamples.push(timeMs(() => generateStudioAgentRoster(dir)))
    }

    // ── generateStudioAgentRoster WARM (nothing changed) — the case that matters ──
    const warmIters = ctx.quick ? 10 : 30
    log.step(`generateStudioAgentRoster warm x${warmIters}`)
    wipeGenerated(dir)
    stripPersistedProfile(dir)
    generateStudioAgentRoster(dir) // establish — first call, not timed
    const warmSamples: number[] = []
    for (let i = 0; i < warmIters; i++) {
      warmSamples.push(timeMs(() => generateStudioAgentRoster(dir)))
    }

    // ── resolveProjectProfile — uncached vs. persisted-cached ──────────────
    const profileIters = ctx.quick ? 10 : 30
    log.step(`resolveProjectProfile uncached x${profileIters}`)
    stripPersistedProfile(dir)
    const profileUncachedSamples: number[] = []
    for (let i = 0; i < profileIters; i++) {
      stripPersistedProfile(dir) // every call is a fresh cold probe
      profileUncachedSamples.push(timeMs(() => resolveProjectProfile(dir)))
    }

    log.step(`resolveProjectProfile cached (persisted) x${profileIters}`)
    reprobeProjectProfile(dir) // persists a profile once
    const profileCachedSamples: number[] = []
    for (let i = 0; i < profileIters; i++) {
      profileCachedSamples.push(timeMs(() => resolveProjectProfile(dir)))
    }

    // ── getOrBuildDesignSystemDigest — warm cache ───────────────────────────
    const digestIters = ctx.quick ? 10 : 30
    log.step(`getOrBuildDesignSystemDigest warm x${digestIters}`)
    const profile = resolveProjectProfile(dir)
    getOrBuildDesignSystemDigest(dir, profile.designSystems ?? []) // establish cache
    const digestSamples: number[] = []
    for (let i = 0; i < digestIters; i++) {
      digestSamples.push(timeMs(() => getOrBuildDesignSystemDigest(dir, profile.designSystems ?? [])))
    }

    const coldSummary = summarize([...coldSamples])
    const warmSummary = summarize([...warmSamples])

    return {
      name: this.name,
      title: this.title,
      headline: {
        'roster cold (mean)': fmtMs(coldSummary.mean),
        'roster warm (p50)': fmtMs(warmSummary.p50),
        'roster warm (p95)': fmtMs(warmSummary.p95),
      },
      sections: [
        {
          title: 'generateStudioAgentRoster',
          intro: `Fixture: ${source.slice(REPO_ROOT.length + 1)}. Cold = no .claude/, no digest cache, no persisted profile. Warm = everything already written, nothing changed since — the case every turn after the first pays.`,
          rows: [summaryRow('cold (first-ever call)', coldSamples), summaryRow('warm (nothing changed)', warmSamples)],
        },
        {
          title: 'resolveProjectProfile',
          intro: 'Uncached = no persisted profile in .studio/meta.json (a project with no package.json/node_modules never gets one healed automatically). Cached = after something has persisted one (reprobeProjectProfile, or agentRoster.ts\'s own resolveProjectProfilePersisting on its first call).',
          rows: [summaryRow('uncached (fresh probe every call)', profileUncachedSamples), summaryRow('cached (persisted profile)', profileCachedSamples)],
        },
        {
          title: 'getOrBuildDesignSystemDigest (warm)',
          intro: 'Cache already built — pays the stat-based cache-key scan (readdir + stat per CSS file) plus a cache-file read.',
          rows: [summaryRow('warm', digestSamples)],
        },
      ],
    }
  },
}
