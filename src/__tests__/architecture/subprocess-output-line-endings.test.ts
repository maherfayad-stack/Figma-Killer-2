/**
 * Architecture Source-Scan — subprocess output is cut with `splitLines`, never `'\n'`
 *
 * Studio runs other people's command-line tools on the user's machine: `git`,
 * `bun`/`npm`/`pnpm`, `tsc`, `vercel`, `netlify`, the project's own dev server,
 * the `claude` CLI. **On Windows those tools print CRLF.** A `text.split('\n')`
 * therefore leaves a `\r` glued to the end of every line, and the damage lands
 * on whatever the LAST field of a line happens to be:
 *
 *   - `gitSyncOperations.listGitBranches` reads `%(HEAD)` last and tests it
 *     with `head === '*'` — with a `\r` that is false for every branch, so the
 *     panel reports no current branch at all.
 *   - `gitOperations.readGitLog` strips the record separator's own newline with
 *     `/^\n/` — `\r\n` slips past it and every commit but the first gets a
 *     41-character sha.
 *   - `tscDiagnostics` anchors its header pattern with `(.*)$`, and `.` does
 *     not match `\r`.
 *
 * Every one of those is silent: no throw, no log, just a value that compares
 * unequal to the one it should equal. So this is a gate, not a convention.
 *
 * ## The rule
 *
 * A file under `server/` that reads **captured** subprocess output must cut it
 * with `splitLines` (or normalise with `toLf`) from `@core/utils/lineEndings` —
 * the same leaf `parser-13` introduced for the user's source files. A literal
 * `.split('\n')` / `.split("\n")` / `.split(\`\n\`)` / `.split(/\n/)` in one of
 * those files fails this test.
 *
 * ## Which files
 *
 * Two groups, both computed rather than hand-listed where possible:
 *
 * 1. **Spawners** — any non-test `server/**\/*.ts` that imports
 *    `subprocessRunner`/`gitRunner`/`deployRunner` or calls `Bun.spawn`. This
 *    set is derived from the source, so a new spawner is covered the day it is
 *    written.
 * 2. **The pure text parsers those spawners feed** — they take a `string` and
 *    so have no import to detect. Named in {@link SUBPROCESS_TEXT_PARSERS},
 *    with an existence assertion so a rename can never silently drop coverage.
 *
 * ## What the rule does NOT cover, and why
 *
 * `buffer.indexOf('\n')` incremental framing over a LIVE stream
 * (`claudeCliSpawn.ts`, `claudeCliWarmSession.ts`) is deliberately out of
 * scope. You cannot `splitLines` a stream that has not finished arriving, and
 * both readers feed each framed line straight to `JSON.parse`, for which a
 * trailing `\r` is legal whitespace. Changing them would be motion without a
 * defect behind it.
 *
 * Writing `'\n'` (`lines.join('\n')`, a template literal) is untouched: Studio
 * emits LF, always. Only READS are constrained.
 *
 * @see src/core/utils/lineEndings.ts — the helper, and the model it implements
 * @see docs/server.md — "Line endings — subprocess output"
 */

import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const SERVER_ROOT = join(PROJECT_ROOT, 'server')

/** Modules whose export is "a spawned child's stdout/stderr". Importing one means this file reads subprocess output. */
const RUNNER_MODULES = ['subprocessRunner', 'gitRunner', 'deployRunner'] as const

/**
 * Pure parsers of command-line-tool text. They take a `string`, so nothing in
 * their source says "subprocess" — they have to be named. Paths are relative
 * to `server/`; the test asserts each one exists.
 */
const SUBPROCESS_TEXT_PARSERS = [
  // `tsc --pretty false` diagnostics.
  'handlers/studio/tscDiagnostics.ts',
  // `vercel`/`netlify` preview URLs, auth probes, "not linked" detection.
  'handlers/studio/deployProviders.ts',
  // `git status --porcelain=v2 -z` (NUL-delimited, so it has no newline read
  // today — listed so it cannot acquire one unnoticed), `remote -v`,
  // `log --format=…`, `for-each-ref`.
  'handlers/studio/gitOutputParse.ts',
  // The two modules those parsers were split out of. They still read git's
  // stdout directly in a few places (`rev-parse`, `log --format=%s`).
  'handlers/studio/gitOperations.ts',
  'handlers/studio/gitSyncOperations.ts',
] as const

/**
 * The gates share one cached walk of the tree (`shared-source-tree-walk.test.ts`):
 * a private `readdirSync` recursion here would re-walk `server/` for this rule
 * alone. `.ts` only — this rule is about TypeScript that reads a child's stdout.
 */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return walkSourceTree(dir, ['.ts'])
}

function isTestFile(file: string): boolean {
  const posix = file.replace(/\\/g, '/')
  return posix.endsWith('.test.ts') || posix.endsWith('.testHelpers.ts') || posix.includes('/__tests__/')
}

/** Replaces every non-newline byte of a comment with a space, so line numbers in violations still line up. */
function stripComments(src: string): string {
  return src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, ' '))
}

function readsSubprocessOutput(source: string): boolean {
  if (/\bBun\.spawn\b/.test(source)) return true
  return RUNNER_MODULES.some((mod) => new RegExp(`from\\s+'[^']*\\b${mod}'`).test(source))
}

/** `.split` on a bare newline literal, in any of the four spellings TypeScript allows. */
const BARE_NEWLINE_SPLIT = /\.split\(\s*(?:'\\n'|"\\n"|`\\n`|\/\\n\/[a-z]*)\s*\)/

function scanFile(file: string): string[] {
  const source = stripComments(readSource(file))
  const violations: string[] = []
  source.split('\n').forEach((line, i) => {
    if (BARE_NEWLINE_SPLIT.test(line)) {
      violations.push(`${relative(PROJECT_ROOT, file).replace(/\\/g, '/')}:${i + 1}  ${line.trim()}`)
    }
  })
  return violations
}

describe('architecture: subprocess output is read through splitLines', () => {
  test('every server file that spawns or consumes a subprocess avoids a bare newline split', () => {
    const spawners = walk(SERVER_ROOT)
      .filter((file) => !isTestFile(file))
      .filter((file) => readsSubprocessOutput(readSource(file)))

    // Sanity: the derivation must find the runners themselves plus real callers.
    expect(spawners.length).toBeGreaterThan(5)

    const violations = spawners.flatMap(scanFile)
    expect(violations).toEqual([])
  })

  test('the named text parsers exist and avoid a bare newline split', () => {
    const missing: string[] = []
    const violations: string[] = []
    for (const rel of SUBPROCESS_TEXT_PARSERS) {
      const file = join(SERVER_ROOT, rel)
      if (!existsSync(file)) {
        missing.push(rel)
        continue
      }
      violations.push(...scanFile(file))
    }
    // A renamed parser must be re-pointed here, not silently dropped.
    expect(missing).toEqual([])
    expect(violations).toEqual([])
  })

  test('the helper this gate points at is the one `parser-13` shipped', () => {
    const helper = join(PROJECT_ROOT, 'src/core/utils/lineEndings.ts')
    expect(existsSync(helper)).toBe(true)
    const source = readSource(helper)
    expect(source).toContain('export function splitLines')
    expect(source).toContain('export function toLf')
  })
})
