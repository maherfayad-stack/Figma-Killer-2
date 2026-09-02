/**
 * Architecture Source-Scan — no case-only filename collisions
 *
 * Two files in the same directory whose names differ only by case, or only by
 * case plus extension (`agentActivity.ts` next to `AgentActivity.tsx`), are a
 * cross-platform trap:
 *
 *   - On Linux (CI, containers, most contributors' servers) they are two
 *     distinct files and everything resolves as written.
 *   - On Windows and macOS the filesystem is case-insensitive, so an import of
 *     `'./AgentActivity'` matches BOTH. Vite's resolver then picks by
 *     extension order — `.ts` before `.tsx` — and silently loads the wrong
 *     module. TypeScript reports it as "differs from file name … only in
 *     casing"; the browser reports it as a missing export from a file that
 *     visibly does export it.
 *
 * This shipped once, in this repo: a component `AgentActivity.tsx` was added
 * beside its helper `agentActivity.ts`, and the running dev server cached the
 * wrong resolution and broke the editor with "does not provide an export named
 * 'AgentActivity'" — pointing at a path that no longer existed. `tsc` caught
 * the collision, but only after the dev server had already poisoned itself,
 * and a build that ran later passed cleanly, which made it look transient.
 *
 * The fix is always the same: give the helper its own name (`activitySummary.ts`).
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const SERVER_ROOT = join(import.meta.dir, '../../../server')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite'])

interface Collision {
  dir: string
  names: string[]
}

function findCollisions(dir: string, collisions: Collision[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  /** lowercased stem → the real filenames that share it. */
  const byStem = new Map<string, string[]>()

  for (const entry of entries) {
    const full = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (!SKIP_DIRS.has(entry)) findCollisions(full, collisions)
      continue
    }
    // Compare on the STEM, not the whole filename: the damaging case is a
    // `.ts` and a `.tsx` whose names differ only by case, and those have
    // different full filenames but the same import specifier.
    const stem = basename(entry, extname(entry)).toLowerCase()
    const existing = byStem.get(stem)
    if (existing) existing.push(entry)
    else byStem.set(stem, [entry])
  }

  for (const [, names] of byStem) {
    if (names.length < 2) continue
    // Same stem AND same case is impossible on one filesystem, so any group of
    // 2+ here differs by case, by extension, or both. Only flag the ones that
    // are genuinely ambiguous to a resolver: identical stems ignoring case.
    const distinctExact = new Set(names.map((n) => basename(n, extname(n))))
    if (distinctExact.size < 2) {
      // e.g. `Button.tsx` + `Button.module.css` — same stem, same case, not
      // ambiguous: the CSS is imported with its full extension.
      continue
    }
    collisions.push({ dir, names: names.sort() })
  }
}

describe('no case-only filename collisions', () => {
  it('no two source files in a directory differ only by case', () => {
    const collisions: Collision[] = []
    findCollisions(SRC_ROOT, collisions)
    findCollisions(SERVER_ROOT, collisions)

    if (collisions.length > 0) {
      const report = collisions
        .map((c) => `  ${c.dir}\n    ${c.names.join('  ')}`)
        .join('\n')
      console.error(
        'Case-only filename collision(s) found. On Windows/macOS an import of '
        + 'either name resolves ambiguously and the resolver picks by extension '
        + 'order (.ts before .tsx), loading the wrong module:\n' + report,
      )
    }

    expect(collisions.map((c) => c.names.join(' + '))).toEqual([])
  })
})
