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
import { isCanvasViewportActive, onCanvasViewportActivityChange } from '../canvasViewportActivity'

/** How long the board must be quiet before any poster is rasterized. */
const QUIET_PERIOD_MS = 700

/** Gap between two captures, so each one is its own macrotask. */
const CAPTURE_GAP_MS = 32

/**
 * How long a frame that has just finished arriving is left alone before its
 * picture is taken (fonts and images land after the node tree commits). The
 * board having been quiet for {@link QUIET_PERIOD_MS} already does not shorten
 * this: it is about the frame, not the hands.
 */
const ARRIVAL_SETTLE_MS = 350

type Capture = () => Promise<void>

const pending = new Map<object, Capture>()
let quietTimer: ReturnType<typeof setTimeout> | null = null
let draining = false
let pointerHeld = false
let listening = false
/** `performance.now()` of the last input event or viewport movement; 0 until there has been one. */
let lastBusyAt = 0
/** Callers parked in {@link waitForBoardQuiet}: their frames' input must be heard too. */
let quietWaiters = 0
/** Detaches the per-frame listeners; non-null exactly while any request is pending. */
let stopFrameListening: (() => void) | null = null

/** Any of these means the user is working; a poster can wait. */
const BUSY_EVENTS = ['wheel', 'pointerdown', 'pointerup', 'pointercancel', 'keydown'] as const

function onBusyEvent(event: Event): void {
  if (event.type === 'pointerdown') pointerHeld = true
  else if (event.type === 'pointerup' || event.type === 'pointercancel') pointerHeld = false
  noteBusy()
}

/** Milliseconds until the board has been quiet for {@link QUIET_PERIOD_MS}: 0 when it already is. */
function msUntilQuiet(): number {
  if (pointerHeld || isCanvasViewportActive()) return QUIET_PERIOD_MS
  return Math.max(0, QUIET_PERIOD_MS - (performance.now() - lastBusyAt))
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
      noteBusy()
    }),
    adapter.on('wheel', noteBusy),
    adapter.on('key', noteBusy),
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
 * The editor document is listened to from the first request on and left
 * attached: the board is open for the whole session, the listeners are
 * passive and capture-phase (so nothing in the canvas can hide a gesture from
 * them), and a teardown hook would need an owner component this module
 * deliberately does not have.
 *
 * The frames are listened to only while a request is PENDING — that is the
 * only time their input can hold anything back. Frames come and go with the
 * mount pool, so those listeners follow the adapter registry, and they are
 * detached (registry subscription included) the moment the queue is empty.
 */
function listenForInput(): void {
  if (typeof document === 'undefined') return
  if (!listening) {
    listening = true
    listenOnDocument(document)
  }
  if (stopFrameListening) return
  syncFrameListeners()
  const unsubscribeRegistry = onFrameAdapterRegistryChange(syncFrameListeners)
  stopFrameListening = () => {
    unsubscribeRegistry()
    for (const detach of frameListeners.values()) detach()
    frameListeners.clear()
    stopFrameListening = null
  }
}

function stopFrameListeningIfIdle(): void {
  if (pending.size === 0 && !draining && quietWaiters === 0) stopFrameListening?.()
}

/** The user (or a gesture) just touched the board: nothing is rasterized until it has been quiet again. */
function noteBusy(): void {
  lastBusyAt = performance.now()
  if (pending.size > 0 || draining) armQuietTimer(QUIET_PERIOD_MS)
}

/** Wait `delayMs`, then drain unless the user is mid-gesture. */
function armQuietTimer(delayMs: number): void {
  if (quietTimer !== null) clearTimeout(quietTimer)
  quietTimer = setTimeout(() => {
    quietTimer = null
    // A held pointer, or a pan/zoom still in flight, is a gesture in progress even with no input event to
    // show for it (a programmatic pan sends none): keep waiting rather than rasterizing under it.
    if (pointerHeld || isCanvasViewportActive()) {
      armQuietTimer(QUIET_PERIOD_MS)
      return
    }
    void drain()
  }, delayMs)
}

// A pan or zoom that ends re-arms the wait, so a picture never starts in the 150 ms after the board stopped moving.
onCanvasViewportActivityChange(noteBusy)

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
    stopFrameListeningIfIdle()
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
  // An arrival does not mean the hands are busy: it waits for its own settle, or for the quiet that input
  // already started, whichever is later. A board that has been idle for a while (the background fill) is
  // therefore photographed one settle after each frame lands, not one full quiet period.
  armQuietTimer(Math.max(ARRIVAL_SETTLE_MS, msUntilQuiet()))
}

/** `setTimeout` that also ends the moment `signal` aborts, so a cancelled waiter lets go of its listeners at once. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/**
 * Resolve once nothing has touched the board for the quiet period. `false`
 * when `signal` aborts first. The background fill waits here before it mounts
 * the next frame, so it never starts a mount under the user's hands.
 */
export async function waitForBoardQuiet(signal: AbortSignal): Promise<boolean> {
  quietWaiters += 1
  try {
    listenForInput()
    for (;;) {
      if (signal.aborted) return false
      const waitMs = msUntilQuiet()
      if (waitMs <= 0) return true
      await sleepUnlessAborted(waitMs, signal)
    }
  } finally {
    quietWaiters -= 1
    stopFrameListeningIfIdle()
  }
}

/** Withdraw a request that has not run yet. A capture already in flight finishes. */
export function cancelFramePoster(token: object): void {
  pending.delete(token)
  stopFrameListeningIfIdle()
}

/** Test seam: drop every queued request and disarm the timer. */
export function resetFramePosterQueue(): void {
  pending.clear()
  stopFrameListening?.()
  if (quietTimer !== null) clearTimeout(quietTimer)
  quietTimer = null
  pointerHeld = false
  lastBusyAt = 0
}
