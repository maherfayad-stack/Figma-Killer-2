/**
 * No canvas overlay may swallow `pointerdown` with `stopPropagation`.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * `CanvasRoot` binds `@use-gesture`'s drag (for the middle-button and
 * space+primary pan) with `filterTaps: true`. That option makes use-gesture
 * suppress the `click` that follows anything it classified as a drag — it
 * calls `stopPropagation()` on the click during React's dispatch, at the React
 * ROOT container.
 *
 * An overlay that calls `event.stopPropagation()` in `onPointerDown` therefore
 * does something much worse than it intends: use-gesture never sees the press,
 * so its tap state stays stale from the last real drag, and it then suppresses
 * EVERY subsequent click inside the canvas. The comment popover shipped with
 * exactly this, and the result was that Reply, Resolve, Cancel, Delete and the
 * kebab were all completely dead to a real mouse — while still working for a
 * synthetic `element.click()`, which is why unit tests and a naive browser
 * check both passed.
 *
 * The swallow was never needed: `CanvasRoot`'s `handleCanvasClick` already
 * ignores any target that is not the canvas root or the transform layer, and
 * `useMarqueeSelection`'s pointerdown already ignores any target but the
 * canvas root. Guard by target, not by stopping propagation.
 *
 * Stopping `click` is fine and NOT flagged: by then use-gesture has already
 * seen the full press/release pair, so its tap state is correct.
 */
import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const CANVAS_ROOT = join(import.meta.dir, '../../admin/pages/site/canvas')

/** `onPointerDown={(e) => e.stopPropagation()}` and near-identical spellings. */
const SWALLOWS_POINTERDOWN =
  /onPointerDown=\{\s*\(\s*(\w+)\s*\)\s*=>\s*\1\.stopPropagation\(\)\s*\}/

/**
 * PRE-EXISTING, NOT ENDORSED.
 *
 * Each of these swallows `pointerdown` on a single focusable control (a
 * frame's inline rename input, a ladder row, a doc block's editable surface)
 * rather than on a container full of buttons, which is why none of them is as
 * visibly broken as the comment popover was — the thing you click IS the thing
 * that stopped the event, and its own handler still runs.
 *
 * They are still latent instances of the same hazard: after clicking into one
 * of these, use-gesture's tap state is stale, so the NEXT click anywhere in
 * the canvas can be suppressed. Fixing them means guarding the canvas gestures
 * by target instead, which is a change to the shared pan/drag plumbing and
 * wants its own pass — see STATE.md `comment-01`.
 *
 * Do not add to this list to make a new failure go away. Guard by target.
 */
const ALLOWLIST = new Set<string>([
  'BoardFramesLayer/BoardFrameView.tsx',
  'CanvasTreeLadderRowButton.tsx',
  'BoardDocsLayer/DocBlockView.tsx',
])

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full))
    else if (extname(entry) === '.tsx') out.push(full)
  }
  return out
}

describe('canvas overlays do not swallow pointerdown', () => {
  it('no overlay stops pointerdown propagation', () => {
    const offenders = tsxFiles(CANVAS_ROOT)
      .filter((file) => ![...ALLOWLIST].some((allowed) => file.endsWith(allowed)))
      .filter((file) => SWALLOWS_POINTERDOWN.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(file.indexOf('src/')))

    expect(offenders).toEqual([])
  })
})
