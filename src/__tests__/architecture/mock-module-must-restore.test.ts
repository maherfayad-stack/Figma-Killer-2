/**
 * Architecture Source-Scan — every `mock.module` is put back.
 *
 * ## The rule
 *
 * A test file that calls `mock.module('<specifier>', factory)` must also
 * restore that specifier's real module, by calling
 * `mock.module('<specifier>', () => <identifier>)` with an identifier holding
 * a snapshot of the real namespace, normally from an `afterAll`.
 *
 * ## Why — this is not hygiene, it is the single largest failure source
 *
 * `mock.module` is **process-wide and permanent**. `mock.restore()` restores
 * spies; it does NOT undo a module mock. And `bun test --parallel=4` (see
 * `bunfig.toml`) gives each WORKER a process, not each FILE — one worker runs
 * hundreds of files back to back. So a module mock registered by file 3 is
 * still in force for file 300.
 *
 * Measured on this repo, one unrestored mock in `server/liveOrigin.test.ts`
 * replaced `server/handlers/studioProjects.ts` with a two-export stand-in.
 * **129 later test files** then failed to LINK with
 * `SyntaxError: Export named 'rethrowProjectDirRefusal' not found` — the
 * entire `server/handlers/**`, `server/ai/mcp/**` and `src/__tests__/server/**`
 * tail of the suite, none of which had anything to do with the live origin.
 * A second one in `src/admin/spotlight/__tests__/projectsProvider.test.ts`
 * replaced `requestCmsSiteReload` with a recorder, so eight save-path
 * assertions in three unrelated files counted zero reloads. Every one of
 * those files passed in isolation.
 *
 * ## The pattern
 *
 * ```ts
 * import { afterAll, mock } from 'bun:test'
 *
 * // Snapshot FIRST, as a plain object: the ESM namespace object is live and
 * // `mock.module` rewrites it in place, so `() => ns` would hand back the mock.
 * const realThing = { ...(await import('./thing')) }
 *
 * mock.module('./thing', () => ({ ...realThing, doIt: myDouble }))
 *
 * afterAll(() => {
 *   mock.module('./thing', () => realThing)
 * })
 * ```
 *
 * Spreading `realThing` into the replacement is strongly preferred too: a
 * factory that omits an export makes that export stop existing, and a static
 * `import { thatName }` anywhere else in the graph then fails to link.
 */
import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { toPosixPath } from './pathHelpers'

const ROOT = join(import.meta.dir, '../../..')
const SCAN_ROOTS = [join(ROOT, 'src'), join(ROOT, 'server')]

/** This gate's own path — it writes the pattern out in prose and must not scan itself. */
const SELF = 'src/__tests__/architecture/mock-module-must-restore.test.ts'

/**
 * ALLOWLIST — files exempt from the rule, each with the reason.
 *
 * An entry is a promise that someone else is fixing the same thing, not a
 * permanent exception. Delete the entry when the referenced work lands.
 */
const ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: 'src/__tests__/canvas/useDevServerReadiness.test.tsx',
    reason: 'owned by PR #139 (Z3), which lands the same afterAll restore — do not edit in parallel',
  },
  {
    file: 'src/__tests__/canvas/liveBoardFrame.test.tsx',
    reason: 'owned by PR #139 (Z3), which lands the same afterAll restore — do not edit in parallel',
  },
]

function collectTestFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTestFiles(full, out)
      continue
    }
    const ext = extname(entry)
    if ((ext === '.ts' || ext === '.tsx') && /\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Every specifier passed to `mock.module(...)` in `source`, deduplicated. */
function mockedSpecifiers(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\bmock\.module\(\s*['"]([^'"]+)['"]/g)) {
    found.add(match[1]!)
  }
  return [...found]
}

/**
 * True when `source` hands the specifier back a bare identifier —
 * `mock.module('x', () => realX)`. An object literal is a mock, not a
 * restore, so it deliberately does not count.
 */
function hasRestore(source: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const restore = new RegExp(
    `mock\\.module\\(\\s*['"]${escaped}['"]\\s*,\\s*\\(\\)\\s*=>\\s*[A-Za-z_$][\\w$]*\\s*\\)`,
  )
  return restore.test(source)
}

describe('mock.module must be restored — a module mock outlives the file that set it', () => {
  it('every mocked specifier is handed its real namespace back', () => {
    const allowed = new Set(ALLOWLIST.map((entry) => entry.file))
    const violations: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const file of collectTestFiles(root)) {
        // POSIX on both sides: `path.relative` yields backslashes on win32
        // and the allowlist is written with `/`.
        const rel = toPosixPath(relative(ROOT, file))
        if (allowed.has(rel)) continue
        // This file spells the pattern out in prose and would match itself.
        if (rel === SELF) continue

        const source = readFileSync(file, 'utf8')
        for (const specifier of mockedSpecifiers(source)) {
          if (hasRestore(source, specifier)) continue
          violations.push(`  ${rel}  →  mocks '${specifier}' and never restores it`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[mock-module-must-restore] ${violations.length} unrestored module mock(s).\n\n` +
          `\`mock.module\` is PROCESS-WIDE and PERMANENT — \`mock.restore()\` does not undo it —\n` +
          `and \`bun test --parallel=4\` runs hundreds of files per worker process. An unrestored\n` +
          `mock is therefore in force for every file that runs after this one in the same worker.\n` +
          `One of these once cost the suite 129 files (see this file's header).\n\n` +
          `FIX — snapshot the real namespace BEFORE mocking, hand it back in an afterAll:\n\n` +
          `    const realThing = { ...(await import('./thing')) }\n` +
          `    mock.module('./thing', () => ({ ...realThing, doIt: myDouble }))\n` +
          `    afterAll(() => { mock.module('./thing', () => realThing) })\n\n` +
          `The snapshot must be a plain object copy: the ESM namespace object is live and\n` +
          `\`mock.module\` rewrites it in place, so \`() => ns\` would hand back the mock.\n` +
          `If a file genuinely cannot restore, add it to this file's ALLOWLIST with a reason.\n\n` +
          `Violations:\n${violations.join('\n')}`,
      )
    }

    expect(violations).toEqual([])
  })

  it('every ALLOWLIST entry still names a real file that still mocks a module', () => {
    // An allowlist entry that outlives its violation silently widens the gate.
    for (const entry of ALLOWLIST) {
      const full = join(ROOT, ...entry.file.split('/'))
      expect(existsSync(full), `ALLOWLIST names a file that no longer exists: ${entry.file}`).toBe(true)
      const source = readFileSync(full, 'utf8')
      expect(
        mockedSpecifiers(source).length > 0,
        `ALLOWLIST entry for ${entry.file} is stale — it no longer calls mock.module. Delete the entry.`,
      ).toBe(true)
    }
  })
})
