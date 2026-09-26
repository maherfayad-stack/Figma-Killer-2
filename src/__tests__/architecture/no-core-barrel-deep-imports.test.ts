/**
 * Architecture Source-Scan — Core Barrel Deep Imports
 *
 * These `src/core/` engine modules publish a public `index.ts` barrel as their
 * canonical entrypoint:
 *   - `@core/page-tree`
 *   - `@core/module-engine`
 *   - `@core/visualComponents`
 *   - `@core/publisher`
 *   - `@core/framework`
 *   - `@core/framework-schema`
 *   - `@core/fonts`
 *   - `@core/design-tokens`
 *   - `@core/studio-comments`
 *   - `@core/studio-anchor`
 *   - `@core/studio-prototype`
 *   - `@core/studio-runtime`
 *   - `@core/vector`
 *
 * Per the barrel convention (CLAUDE.md → "Barrel imports"): everything OUTSIDE
 * a module imports through its barrel; files INSIDE the module import each
 * other via relative paths. External code must NOT reach past the barrel into a
 * concrete file (`@core/<module>/<file>`) — that bypasses the public surface
 * and re-couples callers to the module's internal layout.
 *
 * This gate fails on any `import … from '@core/<module>/<subpath>'` (or the
 * `export … from` / dynamic `import('@core/<module>/<subpath>')` forms) found
 * outside the owning module. The bare barrel path `@core/<module>` is allowed.
 */

import { describe, it, expect } from 'bun:test'
import { readSource, walkSourceTree } from './helpers/sourceTree'
import { existsSync } from 'fs'
import { join, relative } from 'path'
import { toPosixPath } from './pathHelpers'

const ROOT = join(import.meta.dir, '../../..')

const BARRELLED_MODULES = [
  'page-tree',
  'module-engine',
  'visualComponents',
  'publisher',
  'framework',
  'framework-schema',
  'fonts',
  'design-tokens',
  // Studio review comments. `agentGate.ts`'s `isAgentActionable` is the single
  // predicate deciding whether the agent may act on a thread — a deep import
  // past the barrel is how a second, looser copy of that decision gets made.
  'studio-comments',
  // The comment anchor model, split out of `studio-comments/anchorResolve.ts`.
  // `resolve.ts` is the one place that decides whether a comment still points at
  // anything; `studio-comments`' write gate is a consumer of that single answer,
  // so the two must stay one barrel apart rather than reach into each other.
  'studio-anchor',
  // Authored prototype links plus the flow map derived from the project's own
  // navigation code. `codeFlow.ts`'s AST rules are what the connector layer and
  // the panel both read; neither may reach past the barrel to a looser variant.
  'studio-prototype',
  // The live-frame runtime bridge (Track L, `live-04`). `runtime.ts` is built
  // to one standalone ESM file served to a real browser from the live
  // origin, and the four rule modules it shares with the portal-mode canvas
  // injectors (`hoverSuppressionRules`/`scrollUnrollRules`/
  // `animationFreezeRules`/`selectionChromeCss`) must stay ONE implementation
  // each — a deep import is how a second, drifted copy would get made.
  'studio-runtime',
  // The pure vector engine (P5-D SVG-1): path data, geometry, and the ONE
  // SVG attribute-name table and reference policy the parser, the importer,
  // the sanitizer and the canvas renderer share. A deep import is how a
  // second, drifted name table or a looser fragment check would get made.
  'vector',
]

// Scan production + test sources in both the app and the server.
const SCAN_ROOTS = [join(ROOT, 'src'), join(ROOT, 'server')]

// A module never deep-imports itself, so its own directory is exempt (its
// internal files legitimately use relative paths, not deep `@core/<self>`).
// Trailing separator so `framework` does not prefix-match `framework-schema`.
const OWN_MODULE_DIRS = BARRELLED_MODULES.map((m) => join(ROOT, 'src', 'core', m) + '/')

const collectFiles = (dir: string): string[] => walkSourceTree(dir, ['.ts', '.tsx', '.mts', '.cts'])

const DEEP_IMPORT = new RegExp(
  `(?:from|import\\()\\s*['"](@core/(?:${BARRELLED_MODULES.join('|')})/[^'"]+)['"]`,
)

/**
 * ALLOWLIST — deep imports that are correct, each with the reason it is.
 *
 * Both entries reach `@core/studio-runtime/generated/*`, which is not module
 * surface: those two files are ~2 MB committed STRING constants produced by
 * `scripts/sync-studio-runtime.ts` and written verbatim into a scaffolded
 * workspace by the prototype-shell generator. The barrel deliberately does
 * NOT re-export them — its own header states the rule for `vitePlugin.ts`,
 * and `babel-not-in-admin-bundle.test.ts` plus `bundle-size-budgets.test.ts`
 * are the gates that would fail if it did, because every admin file that
 * imports `@core/studio-runtime` for a rule module would then carry those
 * 2 MB in its import graph.
 *
 * The risk this gate exists to stop — a second, drifted copy of a shared
 * implementation reached past the barrel — cannot apply to a generated string
 * constant with exactly one producer. Scoped to the exact file AND the exact
 * specifier, so a deep import of any other `studio-runtime` file, or of
 * `generated/*` from anywhere else, still fails.
 */
const ALLOWLIST: { file: string; specifier: string; reason: string }[] = [
  {
    file: 'server/handlers/studio/prototypeShell/runtimeBridgeShellFile.ts',
    specifier: '@core/studio-runtime/generated/runtimeBridgeBundle',
    reason: 'generated 2 MB string artefact; the barrel must not pull it into the admin graph',
  },
  {
    file: 'server/handlers/studio/prototypeShell/studioRuntimeShellFile.ts',
    specifier: '@core/studio-runtime/generated/vitePluginBundle',
    reason: 'generated 2 MB string artefact; the barrel must not pull it into the admin graph',
  },
]

function isAllowed(relPosixFile: string, specifier: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === relPosixFile && entry.specifier === specifier)
}

describe('Core barrel deep imports — external callers use the barrel, never a concrete file', () => {
  it('no external file deep-imports a barrelled @core module concrete file', () => {
    const violations: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectFiles(root)) {
        if (OWN_MODULE_DIRS.some((dir) => filePath.startsWith(dir))) continue

        // POSIX on both sides of every comparison — `path.relative` returns
        // backslashes on win32, and the allowlist is written with `/`.
        const relPosix = toPosixPath(relative(ROOT, filePath))
        const source = readSource(filePath)
        source.split('\n').forEach((line, i) => {
          const match = DEEP_IMPORT.exec(line)
          if (!match) return
          if (isAllowed(relPosix, match[1]!)) return
          violations.push(`${relPosix}:${i + 1}  ${line.trim()}`)
        })
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Deep imports into a barrelled core module found.\n\n` +
          `FIX: import through the module barrel (e.g. '@core/publisher') instead of a\n` +
          `concrete file. If the symbol is not exported from the barrel, export it there\n` +
          `— that is the module's public surface, and adding to it is the point.\n\n` +
          `If the target is genuinely NOT module surface (a generated artefact the barrel\n` +
          `must not pull into the admin import graph), add an entry to this file's\n` +
          `ALLOWLIST naming the importing file, the exact specifier, and the reason.\n\n` +
          `Violations:\n${violations.join('\n')}`,
      )
    }

    expect(violations).toEqual([])
  })

  it('every ALLOWLIST entry still names a real file that still has that import', () => {
    // An allowlist that outlives its violation silently widens the gate.
    for (const entry of ALLOWLIST) {
      const filePath = join(ROOT, ...entry.file.split('/'))
      expect(existsSync(filePath), `ALLOWLIST names a file that no longer exists: ${entry.file}`).toBe(true)
      const source = readSource(filePath)
      expect(
        source.includes(`'${entry.specifier}'`) || source.includes(`"${entry.specifier}"`),
        `ALLOWLIST entry for ${entry.file} is stale — it no longer imports '${entry.specifier}'. Delete the entry.`,
      ).toBe(true)
    }
  })
})
