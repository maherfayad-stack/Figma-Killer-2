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
  /**
   * Files that OWN a board-object drag gesture, and must implement it with
   * pointer capture rather than a RAF loop.
   *
   * The sticky-note and doc-card gestures used to live in their two views;
   * they now share one implementation (`useAnnotationInteraction.ts`), so that
   * hook is what this half of the gate follows. The views themselves are
   * checked separately below — they must still never grow a RAF loop of their
   * own, which is the invariant that actually protects the idle main thread.
   */
  const dragOwners = [
    // The per-frame drag/resize pointer-capture handlers live in
    // `BoardFrameView.tsx` (extracted out of `BoardFramesLayer.tsx` for
    // `module-size-budgets` — Track C2) — that's the file this gate must
    // track, not the board-level layer that only positions/virtualizes them.
    'canvas/BoardFramesLayer/BoardFrameView.tsx',
    // Sticky notes AND doc cards, both.
    'canvas/useAnnotationInteraction.ts',
  ]

  for (const file of dragOwners) {
    it(`${file} drags via pointer capture, not requestAnimationFrame`, () => {
      const source = read(file)
      expect(source).toMatch(/setPointerCapture/)
      // The CALL form, not the bare word: these files legitimately name the
      // API in a comment explaining why they do not use it.
      expect(source).not.toMatch(/requestAnimationFrame\(/)
    })
  }

  const boardObjectViews = [
    'canvas/BoardDocsLayer/DocBlockView.tsx',
    'canvas/BoardNotesLayer/StickyNoteView.tsx',
  ]

  for (const file of boardObjectViews) {
    it(`${file} runs no RAF loop of its own`, () => {
      expect(read(file)).not.toMatch(/requestAnimationFrame\(/)
    })
  }

  /**
   * The doc card's floating toolbar must not run a RAF loop either. It did
   * once — tracking its anchor card's on-screen rect every frame — and it was
   * a reported source of lag: it measured and wrote to the DOM 60 times a
   * second for the whole editing session. The position is now recomputed from
   * the canvas transform plus a ResizeObserver, which fire only when the
   * answer actually changes.
   */
  it('canvas/BoardDocsLayer/DocToolbar.tsx positions from the canvas transform, not a RAF loop', () => {
    const source = read('canvas/BoardDocsLayer/DocToolbar.tsx')
    expect(source).not.toMatch(/requestAnimationFrame\(/)
    expect(source).toMatch(/ResizeObserver/)
  })
})
