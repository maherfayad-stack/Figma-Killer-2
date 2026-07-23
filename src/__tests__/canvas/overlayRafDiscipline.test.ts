/**
 * Overlay RAF discipline (Phase 5B verification).
 *
 * `BreakpointSelectionOverlay`'s per-frame measurement loop must only run
 * while there is visible overlay work (`hasOverlayWork`) — an always-on RAF
 * loop across N breakpoint frames would keep the main thread from idling and
 * defeat frame virtualization (Phase 5A). Board objects (sticky notes, doc
 * blocks, board frame drag headers) drag via pointer-capture handlers and
 * must NOT feed `hasOverlayWork` or run their own RAF loop that forces the
 * canvas to stay hot while otherwise idle.
 *
 * This is a source-shape check (like the other architecture gates) rather
 * than a React-mount test: the invariant is about which effect governs the
 * loop and which files never reference it or `requestAnimationFrame`, which
 * a static read pins more directly and far more cheaply than mounting the
 * real canvas + iframes.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SITE_ROOT = join(import.meta.dir, '../../admin/pages/site')

function read(relPath: string): string {
  // Normalize CRLF -> LF so `\n`-based regexes below are line-ending-agnostic
  // (this repo's checkout uses CRLF on Windows).
  return readFileSync(join(SITE_ROOT, relPath), 'utf8').replace(/\r\n/g, '\n')
}

describe('BreakpointSelectionOverlay RAF loop', () => {
  const source = read('canvas/BreakpointSelectionOverlay.tsx')

  it('gates its tick loop on hasOverlayWork, with exactly one kick-off + one reschedule + one teardown cancel', () => {
    // Isolate the specific effect (there is an unrelated one-shot RAF
    // elsewhere in this file, for portal-root detection on mount — scoping to
    // this block keeps the count assertions below meaningful).
    const effectMatch = source.match(
      /useEffect\(\(\) => \{\n\s*if \(!hasOverlayWork\) return[\s\S]*?\}, \[hasOverlayWork, iframeElement\]\)/,
    )
    expect(effectMatch).not.toBeNull()
    const effectBody = effectMatch![0]

    // One kick-off call plus one recursive reschedule inside `tick`, paired
    // with exactly one teardown cancel. Guards against a second, independent
    // (ungated) RAF loop being folded into this effect.
    const rafCallCount = (effectBody.match(/requestAnimationFrame\(/g) ?? []).length
    const cancelCallCount = (effectBody.match(/cancelAnimationFrame\(/g) ?? []).length
    expect(rafCallCount).toBe(2)
    expect(cancelCallCount).toBe(1)
  })

  it('hasOverlayWork is derived only from toolbar/ring/hover visibility, not board-object state', () => {
    const match = source.match(/const hasOverlayWork =\s*([\s\S]*?)\n\n/)
    expect(match).not.toBeNull()
    const definition = match![1]
    expect(definition).toMatch(/showToolbar/)
    expect(definition).toMatch(/showSelectorHighlight/)
    expect(definition).toMatch(/showRings/)
    // No sticky-note / doc-block / board-frame-drag concept leaks in.
    expect(definition.toLowerCase()).not.toMatch(/sticky|doc|board/)
  })
})

describe('Board object drags stay off the overlay RAF loop', () => {
  const boardDragFiles = [
    'canvas/BoardFramesLayer/BoardFramesLayer.tsx',
    'canvas/BoardDocsLayer/DocBlockView.tsx',
    'canvas/BoardNotesLayer/StickyNoteView.tsx',
  ]

  for (const file of boardDragFiles) {
    it(`${file} drags via pointer capture, not requestAnimationFrame`, () => {
      const source = read(file)
      expect(source).toMatch(/setPointerCapture/)
      expect(source).not.toMatch(/requestAnimationFrame/)
    })
  }
})
