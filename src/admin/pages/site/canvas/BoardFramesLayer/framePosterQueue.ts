/**
 * framePosterQueue — one rasterization at a time, and never while frames are
 * still arriving (S1).
 *
 * ## The measurement this exists for
 *
 * `useFramePosterCapture` used to arm its own `setTimeout` per frame, so a
 * gesture that admitted a dozen frames armed a dozen independent timers that
 * all fired inside the same gesture. Each one runs `html-to-image`'s
 * `toCanvas`, which clones the whole document and reads + writes a computed
 * style for every element in it — measured at **~85 ms each** on an 18-frame
 * board. A zoom-out from 4 to 18 live frames therefore spent **~100 ms of a
 * single 354 ms animation frame** rasterizing posters *for frames the user was
 * at that moment zooming towards*, which is the least useful moment possible:
 * the picture is only ever looked at once the frame has LEFT the viewport.
 *
 * With posters disabled entirely, the same gesture's worst animation frame
 * dropped from 354 ms to 255 ms and its mean from 41 ms to 22 ms. That is the
 * size of the prize, and none of it needed the poster feature removed — only
 * moved out of the gesture.
 *
 * ## The rule
 *
 * A request never runs while the user's hands are on the board. Every
 * `request`, and every wheel / pointer / key event on the editor document or
 * inside any mounted canvas frame (P2-I), re-arms one shared quiet timer, so a burst of arrivals and the gesture that
 * caused them collapse into a single settle; only when nothing has happened
 * for `QUIET_PERIOD_MS` does the queue drain. It then drains **serially**, one
 * capture per macrotask, so two posters can never land in one animation frame
 * and the browser gets a chance to paint between them.
 *
 * The input listeners are what make this a fix rather than a reshuffle.
 * Measured: with the queue settling on arrivals ALONE, a 1.8 s scripted
 * zoom-out still ended in four ~350 ms animation frames, because the frames
 * all arrived in the first third of the gesture and the queue then drained
 * happily while the user was still zooming. Wheel events fire throughout a
 * zoom — `useIframeEventForwarding` replays the ones that start inside a
 * frame onto this document — so listening for them is what actually holds the
 * queue for the duration of the gesture. A pointer that is DOWN counts as
 * busy on its own: a drag can easily run longer than the quiet period without
 * producing any event this cares to listen to per-move.
 *
 * FOLLOW-UP, once `perf/sandbox-selectors-event-driven-overlay` (PR #140) is
 * on the integration branch: it introduces `canvasViewportActivity.ts`, which
 * `useCanvas.ts` marks from `applyTransformToDOM` — a first-class "the
 * viewport is moving" signal. That is a strictly better input for the quiet
 * timer than the event sniffing below (it cannot miss a programmatic pan, e.g.
 * `centerOnBreakpointFrame` or Ctrl+0), and this module should read it instead
 * of, not alongside, its own listeners. It is not available on this branch.
 *
 * ## Why a `setTimeout` and not an rAF / idle chain
 *
 * `STATE.md`'s perf-hunter landmine is explicit: a predecessor's
 * `requestAnimationFrame` → `setTimeout` → `requestIdleCallback` staging
 * chain could strand frames as skeletons forever in a backgrounded tab or a
 * headless runner, because `rAF` simply never fires there. A poster is
 * best-effort decoration, but the same trap applies — a queue that never
 * drains is a feature that silently stops existing. `setTimeout` always
 * fires, so this always drains.
 */

import { listFrameAdapters, onFrameAdapterRegistryChange } from '../frameAdapter/canvasFrameAdapterRegistry'
import type { FrameDocumentAdapter } from '../frameAdapter/FrameDocumentAdapter'
import { isPortalFrameAdapter } from '../frameAdapter/PortalFrameAdapter'

/** How long the board must be quiet before any poster is rasterized. */
const QUIET_PERIOD_MS = 700

/** Gap between two captures, so each one is its own macrotask. */
const CAPTURE_GAP_MS = 32

type Capture = () => Promise<void>

const pending = new Map<object, Capture>()
let quietTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let pointerHeld = false
let listening = false

/** Any of these means the user is working; a poster can wait. */
const BUSY_EVENTS = ['wheel', 'pointerdown', 'pointerup', 'pointercancel', 'keydown'] as const

function onBusyEvent(event: Event): void {
  if (event.type === 'pointerdown') pointerHeld = true
  else if (event.type === 'pointerup' || event.type === 'pointercancel') pointerHeld = false
  armQuietTimer()
}

function listenOnDocument(doc: Document): () => void {
  for (const type of BUSY_EVENTS) doc.addEventListener(type, onBusyEvent, { capture: true, passive: true })
  return () => {
    for (const type of BUSY_EVENTS) doc.removeEventListener(type, onBusyEvent, { capture: true })
  }
}

/**
 * P2-I (PERF-5) — the same busy signal from INSIDE a canvas frame. A click,
 * a key or a resize drag that starts in a frame never reaches the editor
 * document (`useIframeEventForwarding` forwards a pointerdown only when it
 * starts a pan), so with editor-document listeners alone a capture could
 * start the moment the user pressed on a node. A portal frame is listened to
 * directly; a bridge (Tier-2) frame reports its input over the adapter.
 */
function listenOnFrame(adapter: FrameDocumentAdapter): () => void {
  if (isPortalFrameAdapter(adapter)) {
    const frameDocument = adapter.getPortalWindow()?.document
    return frameDocument ? listenOnDocument(frameDocument) : () => {}
  }
  const unsubscribes = [
    adapter.on('pointer', (event) => {
      if (event.phase === 'move') return
      if (event.phase === 'down') pointerHeld = true
      else if (event.phase === 'up') pointerHeld = false
      armQuietTimer()
    }),
    adapter.on('wheel', armQuietTimer),
    adapter.on('key', armQuietTimer),
  ]
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}

/** Keyed by adapter, not iframe: a frame gets a fresh adapter per document it boots. */
const frameListeners = new Map<FrameDocumentAdapter, () => void>()

function syncFrameListeners(): void {
  const registered = new Set(listFrameAdapters().values())
  for (const [adapter, detach] of frameListeners) {
    if (registered.has(adapter)) continue
    detach()
    frameListeners.delete(adapter)
  }
  for (const adapter of registered) {
    if (!frameListeners.has(adapter)) frameListeners.set(adapter, listenOnFrame(adapter))
  }
}

/**
 * Attached to the editor document, and to every mounted canvas frame, on the
 * first request and left attached: the board is open for the whole session,
 * the listeners are passive and capture-phase (so nothing in the canvas can
 * hide a gesture from them), and a teardown hook would need an owner
 * component this module deliberately does not have. Frames come and go with
 * the mount pool, so their listeners follow the adapter registry.
 */
function listenForInput(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  listenOnDocument(document)
  syncFrameListeners()
  onFrameAdapterRegistryChange(syncFrameListeners)
}

function armQuietTimer(): void {
  if (quietTimer !== null) clearTimeout(quietTimer)
  quietTimer = setTimeout(() => {
    quietTimer = null
    // A held pointer is a gesture in progress even with no event to show for
    // it — keep waiting rather than rasterizing under a drag.
    if (pointerHeld) {
      armQuietTimer()
      return
    }
    void drain()
  }, QUIET_PERIOD_MS)
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.size > 0) {
      // A fresh arrival re-armed the timer while we were mid-drain — stop and
      // let that settle decide, rather than racing the gesture that caused it.
      if (quietTimer !== null) return
      const [token, capture] = pending.entries().next().value as [object, Capture]
      pending.delete(token)
      await capture()
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_GAP_MS))
    }
  } finally {
    draining = false
  }
}

/**
 * Ask for `capture` to run once the board has been quiet. `token` identifies
 * the requester so a second request from the same frame replaces the first
 * rather than queueing twice; pass it to {@link cancelFramePoster} when the
 * frame goes offscreen or unmounts.
 */
export function requestFramePoster(token: object, capture: Capture): void {
  listenForInput()
  pending.set(token, capture)
  armQuietTimer()
}

/** Withdraw a request that has not run yet. A capture already in flight finishes. */
export function cancelFramePoster(token: object): void {
  pending.delete(token)
}

/** Test seam: drop every queued request and disarm the timer. */
export function resetFramePosterQueue(): void {
  pending.clear()
  if (quietTimer !== null) clearTimeout(quietTimer)
  quietTimer = null
  pointerHeld = false
}
