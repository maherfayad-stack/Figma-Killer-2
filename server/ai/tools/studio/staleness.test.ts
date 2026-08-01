/**
 * The staleness rule (WS-12 §2.2) — every test uses its OWN
 * `createStalenessTracker()` instance (never the shared
 * `studioSnapshotStaleness` singleton), so this file's assertions can never
 * leak into or out of another test file's run — see `staleness.ts`'s own
 * doc comment for why that specific shape of pollution is a real, previously
 * hit failure mode in this codebase (`claudeCli.test.ts`'s roster tests).
 */
import { describe, expect, it } from 'bun:test'
import { createStalenessTracker } from './staleness'

function fakeStatSync(mtimesByPath: Record<string, number>) {
  return ((path: string) => {
    const mtimeMs = mtimesByPath[path]
    if (mtimeMs === undefined) throw new Error(`ENOENT: ${path}`)
    return { mtimeMs } as ReturnType<typeof import('node:fs').statSync>
  }) as typeof import('node:fs').statSync
}

describe('staleness tracker (WS-12 §2.2)', () => {
  it('never warns on the very first turn for a conversation — nothing to compare against yet', () => {
    const tracker = createStalenessTracker(fakeStatSync({ '/p/a.tsx': 1 }))
    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false)
  })

  it('warns when the same file\'s mtime changed since the last recorded turn (a write landed)', () => {
    const mtimes: Record<string, number> = { '/p/a.tsx': 1 }
    const statSyncFn = ((path: string) => {
      const v = mtimes[path]
      if (v === undefined) throw new Error('ENOENT')
      return { mtimeMs: v }
    }) as typeof import('node:fs').statSync
    const tracker = createStalenessTracker(statSyncFn)

    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false) // first look
    mtimes['/p/a.tsx'] = 2 // a write happened between turns
    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(true)
  })

  it('does not warn when the file is unchanged between turns', () => {
    const tracker = createStalenessTracker(fakeStatSync({ '/p/a.tsx': 1 }))
    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false)
    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false)
  })

  it('does not warn across a page switch — a different file has nothing to compare against', () => {
    const tracker = createStalenessTracker(fakeStatSync({ '/p/a.tsx': 1, '/p/b.tsx': 1 }))
    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false)
    expect(tracker.checkAndRecord('conv-1', '/p/b.tsx')).toBe(false) // switched pages
  })

  it('keeps conversations independent — one conversation\'s write never warns another\'s', () => {
    const mtimes: Record<string, number> = { '/p/a.tsx': 1 }
    const statSyncFn = ((path: string) => ({ mtimeMs: mtimes[path]! })) as typeof import('node:fs').statSync
    const tracker = createStalenessTracker(statSyncFn)

    expect(tracker.checkAndRecord('conv-1', '/p/a.tsx')).toBe(false)
    mtimes['/p/a.tsx'] = 2
    expect(tracker.checkAndRecord('conv-2', '/p/a.tsx')).toBe(false) // conv-2's first look, not a change FOR IT
  })

  it('never throws for a missing/unreadable file — reports no warning rather than crashing prompt assembly', () => {
    const tracker = createStalenessTracker(fakeStatSync({}))
    expect(() => tracker.checkAndRecord('conv-1', '/does/not/exist.tsx')).not.toThrow()
    expect(tracker.checkAndRecord('conv-1', '/does/not/exist.tsx')).toBe(false)
  })
})
