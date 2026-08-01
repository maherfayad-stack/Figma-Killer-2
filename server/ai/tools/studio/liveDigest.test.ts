/**
 * `buildStudioLiveDigest` (WS-12 §2.1) — cost discipline (trap #11: never
 * walk every page's nodes) exercised directly, against a real multi-page
 * fixture, so the "only the active page, never the whole project" claim is
 * checked by CORRECTNESS (does another page's data leak in) rather than by a
 * timing benchmark, which is a flaky signal in a shared CI environment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStudioLiveDigest } from './liveDigest'
import { createStalenessTracker } from './staleness'
import type { StudioAgentSnapshot } from './snapshot'

/** `n` distinct buttons with `{...spreadProps}` — a reliable, already-verified way to manufacture N nodes with a real `lockReason` ("spread props", `checkNoSpreadProps`'s own rule) per page. */
function pageWithLockedButtons(n: number): string {
  const buttons = Array.from({ length: n }, (_, i) => `      <button {...spreadProps${i}}>Go</button>`).join('\n')
  const consts = Array.from({ length: n }, (_, i) => `const spreadProps${i} = { label: 'Go' }`).join('\n')
  return [
    consts,
    'export default function Page() {',
    '  return (',
    '    <div className="hero">',
    buttons,
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

describe('buildStudioLiveDigest — cost discipline (trap #11)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-livedigest-'))
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0' } }))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the fidelity digest reflects ONLY the active page — a heavier sibling page never leaks in', async () => {
    // Active page: 2 code-valued nodes. Sibling: 40 — if the digest ever
    // summed across pages, this test would catch it immediately.
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(2))
    writeFileSync(join(dir, 'pages', 'Big.tsx'), pageWithLockedButtons(40))

    const { loadStudioPages } = await import('../../../handlers/studioPageLoad')
    const { pages } = await loadStudioPages(dir)
    const small = pages.find((p) => p.id === 'small')
    if (!small) throw new Error('fixture page "small" did not parse')

    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId: 'small', x: 0, y: 0 }, { pageId: 'big', x: 400, y: 0 }],
      activePageId: 'small',
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-1', { staleness: createStalenessTracker() })
    expect(digest.fidelity?.locked).toBe(2)
    // Board metadata (titles) is fine to include for every frame — that's
    // bounded by frame count, not node count, and IS part of the design
    // (WS-12 §2.1: "the snapshot reads board metadata... only").
    expect(digest.board.frames).toHaveLength(2)
  })

  it('the selection lookup never scans a page other than the active one', async () => {
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(1))
    writeFileSync(join(dir, 'pages', 'Big.tsx'), pageWithLockedButtons(40))

    const snapshot: StudioAgentSnapshot = {
      activeBoardId: 'board-1',
      frames: [{ pageId: 'small', x: 0, y: 0 }],
      activePageId: 'small',
      // A node id shaped like it belongs to the OTHER page — must not resolve.
      selectedNodeId: 'pages/Big.tsx:1:1',
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-2', { staleness: createStalenessTracker() })
    expect(digest.selection).toBeNull()
  })

  it('never throws when the active page id names a page that does not exist', async () => {
    writeFileSync(join(dir, 'pages', 'Small.tsx'), pageWithLockedButtons(1))
    const snapshot: StudioAgentSnapshot = {
      activeBoardId: null,
      frames: [],
      activePageId: 'does-not-exist',
      selectedNodeId: null,
      axes: { direction: 'ltr', colorScheme: 'light' },
    }
    const digest = await buildStudioLiveDigest(dir, snapshot, 'conv-3', { staleness: createStalenessTracker() })
    expect(digest.activePage).toBeNull()
    expect(digest.fidelity).toBeNull()
  })
})
