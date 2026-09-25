/**
 * useVectorEditKeys — the `vector-edit` rung (P5-D), directly under
 * `inline-edit` on the editor's key ladder.
 *
 * While a graphic is in vector edit mode the keyboard means points, not nodes:
 *
 *   - Escape / ⏎ leave the mode (Figma's; the selection stays on the svg).
 *   - Arrows nudge the selected anchor 1 px (⇧ 10 px) — in CSS pixels, mapped
 *     into the path's own user space. A burst of presses is ONE write, posted
 *     `NUDGE_COMMIT_MS` after the last (Penpot's `move-selected` debounce):
 *     holding an arrow down must not queue a save per repeat.
 *   - Delete / Backspace are CLAIMED and do nothing yet. Without the claim the
 *     `node` rung below would delete the whole svg the user is editing the
 *     points of. Removing an anchor is a follow-up (it needs a segment merge
 *     in `@core/vector`).
 *
 * ⌘Z is deliberately NOT claimed: every drag and nudge is already a real,
 * undoable source write, so the global undo is the right one — after flushing
 * a nudge burst still waiting to post, so ⌘Z undoes it rather than racing it.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { moveAnchor, type PathModel } from '@core/vector'
import { useEditorKeyScope } from '../useEditorKeyDispatcher'
import { exitVectorEdit, getVectorEditTarget } from './vectorEditState'
import type { VectorPart } from './vectorEditParts'
import { applyLinear } from './vectorGeometry'

/** Which anchor is selected: the end of `segment` in part `part`. */
export interface VectorSelection {
  part: number
  segment: number
}

/** How long after the last arrow press a nudge burst is written. */
export const NUDGE_COMMIT_MS = 400

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

interface NudgeBurst {
  part: number
  segment: number
  startModel: PathModel
  startD: string
  dx: number
  dy: number
  timer: ReturnType<typeof setTimeout> | null
}

export interface VectorEditKeysInput {
  selectionRef: MutableRefObject<VectorSelection | null>
  /** The part as it stands now. */
  readPart: (part: number) => VectorPart | undefined
  /** Show `model` on the part: the overlay and the real element (the layer owns the parts). */
  previewPart: (part: number, model: PathModel) => void
  commitPart: (part: number, startModel: PathModel, startD: string, label: string) => void
}

export function useVectorEditKeys({ selectionRef, readPart, previewPart, commitPart }: VectorEditKeysInput): void {
  const burstRef = useRef<NudgeBurst | null>(null)

  const flushNudge = () => {
    const burst = burstRef.current
    if (!burst) return
    burstRef.current = null
    if (burst.timer !== null) clearTimeout(burst.timer)
    commitPart(burst.part, burst.startModel, burst.startD, 'Nudge point')
  }
  const flushRef = useRef(flushNudge)
  useEffect(() => {
    flushRef.current = flushNudge
  })
  // Leaving the mode (or the graphic going away) still writes what was nudged.
  useEffect(() => () => flushRef.current(), [])

  const nudge = (dx: number, dy: number): boolean => {
    const selection = selectionRef.current
    const part = selection ? readPart(selection.part) : undefined
    if (!selection || !part) return false
    let previous = burstRef.current
    if (previous && (previous.part !== selection.part || previous.segment !== selection.segment)) {
      flushNudge()
      previous = null
    }
    if (previous?.timer != null) clearTimeout(previous.timer)
    const base = previous ?? { part: selection.part, segment: selection.segment, startModel: part.model, startD: part.d, dx: 0, dy: 0 }
    const burst: NudgeBurst = {
      ...base,
      dx: base.dx + dx,
      dy: base.dy + dy,
      timer: setTimeout(() => flushRef.current(), NUDGE_COMMIT_MS),
    }
    burstRef.current = burst
    previewPart(burst.part, moveAnchor(burst.startModel, burst.segment, applyLinear(part.toLocal, { x: burst.dx, y: burst.dy })))
    return true
  }

  useEditorKeyScope(
    'vector-edit',
    () => getVectorEditTarget() !== null,
    (event) => {
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        flushNudge()
        exitVectorEdit()
        return true
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        return true
      }
      const arrow = ARROWS[event.key]
      if (arrow && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const step = event.shiftKey ? 10 : 1
        if (nudge(arrow[0] * step, arrow[1] * step)) {
          event.preventDefault()
          return true
        }
        return false
      }
      // Anything else (⌘Z first of all) goes down the ladder — after the burst posts.
      flushNudge()
      return false
    },
  )
}
