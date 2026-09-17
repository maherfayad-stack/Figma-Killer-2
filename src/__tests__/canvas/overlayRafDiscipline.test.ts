/**
 * Overlay RAF discipline (Phase 5B verification, tightened by S4).
 *
 * Phase 5B gated `BreakpointSelectionOverlay`'s measurement loop on
 * `hasOverlayWork`, which stopped it running over an EMPTY canvas. S4 finished
 * the job: the loop no longer runs over an idle canvas that merely has
 * something selected either. Measurement is event-driven
 * (`overlayMeasureScheduler.ts`) and a per-frame loop is armed only while
 * something is genuinely moving the geometry every frame.
 *
 * So this file now pins two different things:
 *
 *  1. **Source shape** — the overlay owns no self-rescheduling rAF loop of its
 *     own, and the scheduler's loop reschedules only while a hold is up. Board
 *     objects (sticky notes, doc blocks, board frame drag headers) drag via
 *     pointer-capture handlers and must never feed `hasOverlayWork` or grow a
 *     loop that forces the canvas to stay hot while otherwise idle.
 *  2. The BEHAVIOUR — "an idle board with a selection is 0 rAF/s" — which a
 *     static read cannot express at all. That lives next door in
 *     `overlayMeasureScheduler.test.ts`, against a fake rAF.
 *
 * A source-shape check is still the right tool for (1): the invariant is about
 * which files reference `requestAnimationFrame` at all, which a static read
 * pins more directly and far more cheaply than mounting the real canvas +
 * iframes.
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

  it('gates its measurement on hasOverlayWork and delegates the schedule to overlayMeasureScheduler', () => {
    const effectMatch = source.match(
      /useEffect\(\(\) => \{\n\s*if \(!hasOverlayWork\) return[\s\S]*?\}, \[hasOverlayWork, iframeElement, overlayRoot, continuousGesture\]\)/,
    )
    expect(effectMatch).not.toBeNull()
    const effectBody = effectMatch![0]

    // The effect creates the scheduler and disposes it. It must NOT drive a
    // loop of its own — that is precisely the shape S4 removed.
    expect(effectBody).toMatch(/createOverlayMeasureScheduler\(/)
    expect(effectBody).toMatch(/\.dispose\(\)/)
    expect(effectBody).not.toMatch(/requestAnimationFrame\(/)
  })

  it('keeps exactly one requestAnimationFrame call in the whole component — the one-shot portal-root read', () => {
    // The overlay used to own a self-rescheduling loop (one kick-off + one
    // recursive reschedule). All that is left is the single mount-time frame
    // that reads the canvas root ref, which cancels itself on cleanup.
    expect((source.match(/requestAnimationFrame\(/g) ?? []).length).toBe(1)
    expect((source.match(/cancelAnimationFrame\(/g) ?? []).length).toBe(1)
  })

  it('the scheduler reschedules only while a continuous hold is up', () => {
    const scheduler = read('canvas/overlayMeasureScheduler.ts')
    // The rAF pump's ONLY reschedule is guarded by the hold set. Without the
    // guard this module would simply be the old permanent loop, relocated.
    expect(scheduler).toMatch(/measure\(\)\n\s*if \(holds\.size > 0\) schedule\(\)/)
    // And the pump is the only thing that requests a frame.
    expect((scheduler.match(/requestAnimationFrame\(/g) ?? []).length).toBe(1)
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
