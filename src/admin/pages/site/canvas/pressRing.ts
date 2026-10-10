/**
 * pressRing — the selection ring on the press itself, before React has
 * rendered the selection.
 *
 * Selecting a layer is one synchronous React flush: every selection consumer
 * (the ring and toolbar, the Layers rows, the inspector's ~14 sections, the
 * class picker) re-renders in the same task, and the browser cannot paint
 * until that task ends. That flush is tens of milliseconds, so a ring that
 * waits for it lands a frame or three after the finger did. Pressing into
 * another board frame also activates that frame's page - a second flush, in
 * the same task, before the selection's.
 *
 * Two moves take the ring off that path:
 *
 *  1. **The hover ring already knows.** While the pointer travelled to the
 *     element, the hover ring was sitting on exactly the layer a press means
 *     (hover and press resolve through the same `canvasPressTarget` rule). At
 *     press time it is restyled as a selection ring with one attribute write
 *     (`data-canvas-press-ring`; the rule is in `selectionChromeCss.ts`) - no
 *     DOM added, so none of the childList mutations the frame's layout
 *     observers re-measure for. A press that had no hover ring on that layer
 *     (a touch, a synthetic click) places the hover ring itself.
 *  2. **The store work runs one paint later.** The page activation and the
 *     selection are queued ({@link afterPressPaint}) and run after a frame
 *     has been presented, in order, in ONE task - so one React flush. (Run as
 *     two tasks they cost 60% more end to end: the activation clears the
 *     selection, unmounting the inspector, and the selection then mounts it
 *     again, where together they just update it.)
 *
 * The queue never outlives what needs it: a release, a context menu, a key, or
 * a press that turns into a drag runs it at once ({@link flushPressQueue}), so
 * nothing reads a selection or an active page the press has not made yet; and
 * a backgrounded tab - where `requestAnimationFrame` never fires - runs it on a
 * short fallback timer. The borrowed attribute comes off once the real ring
 * has had its measure pass, and on the next press.
 */
import { useEditorStore } from '@site/store/store'
import { measureIframeLocalRect } from './canvasOverlayGeometry'
import { positionOverlayElement } from './canvasSelectionOverlayPositioning'

const PRESS_RING_ATTR = 'data-canvas-press-ring'
/** A frame has been presented well within this; past it the queue runs regardless. */
const QUEUE_FALLBACK_MS = 64
/** The real ring is measured and painted a frame or two after its commit; the outer bound on the borrowed one. */
const RING_RELEASE_MS = 600
/** What ends the wait: the gesture moved on from "the finger just landed". */
const FLUSH_EVENTS = ['pointerup', 'contextmenu', 'keydown', 'dblclick'] as const

/** The modifiers of the selection a press makes: none - ⇧ presses are the click's toggle, ⌘/Ctrl only chose WHICH layer. */
export const NO_MODIFIERS = { shiftKey: false, metaKey: false, ctrlKey: false }

let queue: Array<() => void> = []
let disarm: (() => void) | null = null
let armedWindow: Window | null = null
let paintTimer: ReturnType<typeof setTimeout> | undefined
let releasePreviousRing: (() => void) | null = null

function endWait(): void {
  disarm?.()
  disarm = null
  armedWindow = null
}

/** Run what a press queued, now, in order - and stop waiting for the paint. */
export function flushPressQueue(): void {
  endWait()
  const tasks = queue
  queue = []
  for (const task of tasks) task()
}

/**
 * Queue `task` to run after the press has been painted - or at once, when the
 * gesture moves on before that (see {@link FLUSH_EVENTS}).
 */
export function afterPressPaint(win: Window, task: () => void): void {
  // Armed on another frame's window (a press moved between frames, or that
  // frame's document went away): its wait is over, and its listeners are not
  // this window's.
  if (disarm && armedWindow !== win) flushPressQueue()
  queue.push(task)
  if (disarm) return
  armedWindow = win
  // A frame, then a task: `requestAnimationFrame` runs BEFORE the frame is
  // painted, so the queue waits one more task for the paint to have happened.
  const frame = win.requestAnimationFrame(() => {
    paintTimer = setTimeout(flushPressQueue, 0)
  })
  const fallback = setTimeout(flushPressQueue, QUEUE_FALLBACK_MS)
  for (const type of FLUSH_EVENTS) win.addEventListener(type, flushPressQueue, { capture: true })
  disarm = () => {
    win.cancelAnimationFrame(frame)
    clearTimeout(paintTimer)
    clearTimeout(fallback)
    for (const type of FLUSH_EVENTS) win.removeEventListener(type, flushPressQueue, { capture: true })
  }
}

/** Show the hover ring as a selection ring on `target`; returns how to put it back. */
function borrowHoverRing(doc: Document, nodeId: string, target: Element): (() => void) | null {
  const ring = doc.querySelector<HTMLElement>('[data-canvas-hover-ring]')
  if (!ring) return null
  const onThisLayer = ring.getAttribute('data-canvas-overlay-node-id') === nodeId && ring.style.display !== 'none'
  if (!onThisLayer) {
    const rect = measureIframeLocalRect(target)
    if (!rect) return null
    positionOverlayElement(ring, rect)
  }
  ring.setAttribute(PRESS_RING_ATTR, 'true')
  return () => ring.removeAttribute(PRESS_RING_ATTR)
}

/**
 * Select `nodeId` for a press on `element`: its ring now, the selection one
 * paint later (`select` is the ordinary click selection).
 */
export function selectOnPress(element: Element, nodeId: string, select: () => void): void {
  releasePreviousRing?.()
  releasePreviousRing = null
  const doc = element.ownerDocument
  const win = doc.defaultView
  const target = doc.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`) ?? element
  const release = win ? borrowHoverRing(doc, nodeId, target) : null
  if (!win || !release) {
    flushPressQueue()
    select()
    return
  }
  const releaseTimer = setTimeout(() => finish(), RING_RELEASE_MS)
  function finish(): void {
    clearTimeout(releaseTimer)
    release?.()
    if (releasePreviousRing === finish) releasePreviousRing = null
  }
  releasePreviousRing = finish
  afterPressPaint(win, () => {
    if (!useEditorStore.getState().selectedNodeIds.includes(nodeId)) select()
    // The real ring is placed by the overlay's measure pass, the frame after
    // its commit: hand the hover ring back once that has had two.
    win.requestAnimationFrame(() => win.requestAnimationFrame(finish))
  })
}
