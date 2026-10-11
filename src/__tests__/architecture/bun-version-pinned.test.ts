/**
 * One Bun version, named in one place.
 *
 * `package.json` → `engines.bun` is the single source of truth for which Bun
 * this repository runs on, and it is an EXACT version, not a range. Two facts
 * make a range wrong here (P0-I, measured 2026-09-24):
 *
 *  1. **`bun run test` depends on it.** The script is `bun test --parallel=4`,
 *     and `--parallel` (one isolated worker per file — the suite's correctness
 *     model, see `bunfig.toml`) does not exist in Bun 1.3.6 or 1.3.11. Those
 *     versions accept the flag and silently ignore it, so `bun run test` there
 *     is the shared-global bare `bun test` the whole suite is written against.
 *  2. **The generated bundles depend on it.** `Bun.build` output differs between
 *     PATCH releases (1.3.6 emits different `__export` helpers than 1.3.11 /
 *     1.3.13), so the `studio-runtime` freshness gate only means "the source
 *     drifted" when every machine builds with the same Bun.
 *
 * So every other place that names a Bun version must read it from, or agree
 * with, `engines.bun`:
 *  - every `oven-sh/setup-bun` step in `.github/workflows/` reads it through
 *    `bun-version-file: package.json` and never hardcodes `bun-version:`;
 *  - every `FROM oven/bun:<tag>` in the Dockerfile uses exactly that tag.
 */
import { describe, expect, it } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { safeParseJson } from '@core/utils/jsonValidate'

const REPO_ROOT = join(import.meta.dir, '../../../')
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows')

const PackageEnginesSchema = Type.Object({
  engines: Type.Object({ bun: Type.String() }),
})

function readEnginesBun(): string {
  const parsed = safeParseJson(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'), PackageEnginesSchema)
  if (!parsed.ok) throw new Error(`package.json has no engines.bun: ${parsed.error.message}`)
  return parsed.value.engines.bun
}

/** Each `uses: oven-sh/setup-bun@…` step, as the lines up to the next step. */
function setupBunSteps(workflow: string): string[] {
  const steps = workflow.split(/\r?\n(?=\s*- (?:name|uses):)/)
  return steps.filter((step) => /uses:\s*oven-sh\/setup-bun@/.test(step))
}

describe('Bun version pin', () => {
  it('engines.bun is one exact version, not a range', () => {
    expect(readEnginesBun()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('every setup-bun step reads the version from package.json', () => {
    const offenders: string[] = []
    let seen = 0
    for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      for (const step of setupBunSteps(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'))) {
        seen++
        if (!/bun-version-file:\s*package\.json\s*$/m.test(step) || /\bbun-version:/.test(step)) {
          offenders.push(`${file}: ${step.trim().split(/\r?\n/)[0]}`)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it('every Dockerfile stage uses the engines.bun image tag', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8')
    const tags = [...dockerfile.matchAll(/^FROM oven\/bun:(\S+)/gm)].map((m) => m[1])
    expect(tags.length).toBeGreaterThan(0)
    expect(new Set(tags)).toEqual(new Set([readEnginesBun()]))
  })
})
