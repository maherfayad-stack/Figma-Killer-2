/**
 * Canvas drags that cross into a frame must arm the cross-iframe pointer relay.
 *
 * THE FAILURE THIS EXISTS TO STOP
 * ───────────────────────────────
 * Every board frame is an `<iframe>`. A left-click pointer event inside one
 * never reaches the parent document's `window`, so a drag whose move/up
 * listeners live on the parent `window` goes SILENT the moment the cursor
 * enters a frame. `markCanvasPointerRelay(pointerId)` sets the flag each
 * `IframeFrameSurface` reads to forward pointermove / pointerup / pointercancel
 * back out; `clearCanvasPointerRelay()` takes it down when the gesture ends.
 *
 * The bug is invisible in every test that does not mount real iframes, and it
 * fails in the most confusing possible way: the gesture works perfectly over
 * empty board and dies exactly when it touches the thing it was aiming at.
 *
 * WHY A GATE AND NOT A CODE REVIEW
 * ────────────────────────────────
 * Two drags got this right, then the prototype-link handle shipped without it
 * and could never drop a link on a page — the frames it needed to reach were
 * the frames that killed it. The rule was real and written down nowhere, so it
 * was rediscovered by breaking. Anything under `canvas/` that attaches a
 * pointermove listener to the parent `window` is making the same bet, so the
 * check follows the SHAPE rather than a list of known files.
 *
 * If a new drag genuinely cannot leave the parent document, it does not belong
 * on `window` — scope its listeners to the element that owns it, and this gate
 * will not see it.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const CANVAS_ROOT = join(import.meta.dir, '../../admin/pages/site/canvas')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Files that start a drag by listening for pointermove on the parent window. */
function windowPointerDragOwners(): Array<{ path: string; source: string }> {
  const owners: Array<{ path: string; source: string }> = []
  for (const file of sourceFiles(CANVAS_ROOT)) {
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    if (!/window\.addEventListener\(\s*['"]pointermove['"]/.test(source)) continue
    owners.push({ path: relative(CANVAS_ROOT, file), source })
  }
  return owners
}

describe('Cross-iframe pointer relay', () => {
  const owners = windowPointerDragOwners()

  it('finds the window-pointer drags it is meant to guard', () => {
    // A rename or a move that silently empties this list would turn every
    // assertion below into a vacuous pass.
    expect(owners.length).toBeGreaterThanOrEqual(4)
  })

  for (const { path, source } of owners) {
    it(`${path} arms the relay for the duration of the drag`, () => {
      // Reported as a list of what is MISSING: asserting `toContain` on the
      // whole file prints the whole file on failure, which buries the answer.
      const missing = [
        source.includes('markCanvasPointerRelay(') ? null : 'markCanvasPointerRelay(event.pointerId)',
        source.includes('clearCanvasPointerRelay()') ? null : 'clearCanvasPointerRelay()',
      ].filter((call): call is string => call !== null)
      expect(missing).toEqual([])
    })
  }
})
