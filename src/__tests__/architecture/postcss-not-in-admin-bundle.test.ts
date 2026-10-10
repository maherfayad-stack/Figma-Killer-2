/**
 * Architecture gate — the editor (browser) bundle's STATIC import graph never
 * reaches postcss, ts-morph, `@babel/*`, or a Node builtin.
 *
 * The audit (2026-10-10) found ~130 Vite "Module path / fs / url /
 * source-map-js has been externalized for browser compatibility" warnings on
 * every editor open. Cause: `@core/css-codemods`' barrel (postcss) was imported
 * by the editor for three one-line helpers, `@core/siteImport` carried postcss
 * for an `@layer` pre-pass, and the launcher's folder walk pulled the
 * `@core/page-parser` barrel (ts-morph, `node:fs`, `node:path`) for one
 * constant. The editor needs none of those at load; each was a barrel import
 * dragging a server-side parser into the browser.
 *
 * ## The rule
 *
 * Starting from EVERY non-test file under `src/admin/`, follow value imports
 * (type-only imports are erased by the compiler and do not count; `@core/*`,
 * `@ui/*`, `@site/*` … aliases are resolved) and fail if a forbidden package is
 * reachable. A dynamic `import()` is NOT followed: it is the sanctioned lazy
 * boundary, a separate chunk fetched at the moment of use
 * (`keyframesStepEdit.ts` — the postcss-backed keyframe writers, loaded on the
 * first keyframe edit).
 *
 * Roots that exist only to be dynamically imported are listed in
 * {@link LAZY_ONLY_ROOTS}; they are exempt as ROOTS but are still checked for
 * every static importer, so one static `import` of them from the editor fails
 * the gate with the full chain.
 *
 * What to do when this fails: import the pure leaf (`@core/css-codemods/browser`,
 * `@core/utils/excludedWorkspaceDirs`, …) instead of the barrel, or move the
 * work behind a dynamic `import()` in the handler that needs it, or do it on
 * the server. Do not add to the allow-list to make a warning go away.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { readSource, walkSourceTree } from './helpers/sourceTree'

const REPO_ROOT = join(import.meta.dir, '../../../')

/** Files that are only ever reached through a dynamic `import()`. Exempt as roots, never as importees. */
const LAZY_ONLY_ROOTS = new Set(['src/admin/pages/site/panels/PropertiesPanel/keyframesStepEdit.ts'])

const FORBIDDEN =
  /^(postcss|source-map-js|ts-morph|@ts-morph\/.*|@babel\/.*|node:.*|fs|path|url|crypto|os|module|child_process|perf_hooks|worker_threads)$/

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@core/', 'src/core/'],
  ['@modules/', 'src/modules/'],
  ['@ui/', 'src/ui/'],
  ['@admin/', 'src/admin/'],
  ['@site/', 'src/admin/pages/site/'],
  ['@content/', 'src/admin/pages/content/'],
  ['@plugins/', 'src/admin/pages/plugins/'],
  ['@users/', 'src/admin/pages/users/'],
]

const SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/')
}

function resolveImport(spec: string, from: string): string | null {
  let base: string | null = null
  for (const [alias, target] of ALIASES) {
    if (spec.startsWith(alias)) base = resolve(REPO_ROOT, target + spec.slice(alias.length))
  }
  if (base === null && spec.startsWith('.')) base = resolve(dirname(from), spec)
  if (base === null) return null
  for (const suffix of SUFFIXES) {
    const candidate = resolve(base + suffix)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
}

/** Static value imports of `file` (type-only imports and dynamic `import()` excluded). */
function staticImports(file: string): string[] {
  const loader = file.endsWith('.tsx') ? 'tsx' : 'ts'
  return transpilers[loader]
    .scanImports(readSource(file))
    .filter((imp) => imp.kind !== 'dynamic-import')
    .map((imp) => imp.path)
}

const isTestFile = (file: string): boolean => /[\\/]__tests__[\\/]|\.test\.tsx?$/.test(file)

describe('postcss-not-in-admin-bundle gate', () => {
  const adminFiles = walkSourceTree(join(REPO_ROOT, 'src/admin'), ['.ts', '.tsx']).filter((f) => !isTestFile(f))

  it('walks a real tree (a scan over zero files passes forever)', () => {
    expect(adminFiles.length).toBeGreaterThan(500)
    expect(existsSync(join(REPO_ROOT, [...LAZY_ONLY_ROOTS][0]!))).toBe(true)
  })

  it('no editor file statically reaches postcss, ts-morph, @babel/* or a Node builtin', () => {
    const parent = new Map<string, string>()
    const seen = new Set<string>()
    const queue: string[] = []
    for (const file of adminFiles) {
      if (LAZY_ONLY_ROOTS.has(repoRelative(file))) continue
      seen.add(file)
      queue.push(file)
    }

    const violations: string[] = []
    for (let next = 0; next < queue.length; next += 1) {
      const file = queue[next]!
      for (const spec of staticImports(file)) {
        if (FORBIDDEN.test(spec)) {
          const chain = [file]
          for (let up = parent.get(file); up !== undefined; up = parent.get(up)) chain.push(up)
          violations.push(`${spec}  <-  ${chain.reverse().map(repoRelative).join('  ->  ')}`)
          continue
        }
        const target = resolveImport(spec, file)
        if (target !== null && !seen.has(target)) {
          seen.add(target)
          parent.set(target, file)
          queue.push(target)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[postcss-not-in-admin-bundle] the editor's static import graph reaches a server-only package:\n` +
          `${violations.map((v) => `  ${v}`).join('\n')}\n\n` +
          `Import the pure leaf (@core/css-codemods/browser, @core/utils/excludedWorkspaceDirs, …) instead of the barrel, ` +
          `or move the work behind a dynamic import() / onto the server. See this file's header.`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
