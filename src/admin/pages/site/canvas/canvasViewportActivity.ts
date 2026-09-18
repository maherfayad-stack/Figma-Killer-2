/**
 * canvasViewportActivity — "the board is being panned or zoomed RIGHT NOW".
 *
 * ## Why this exists
 *
 * `useCanvas` keeps the live transform in `transformRef`, mutated in place on
 * every animation frame of a gesture, and commits it to the store only 100 ms
 * after the last event (see that module's docblock). That is exactly the right
 * shape for anything that can READ the ref on its own schedule — the rulers
 * repaint from it inside their own loop.
 *
 * It is the wrong shape for anything that needs to KNOW a gesture started.
 * `transformRef.current` is the same object identity forever ("do not rely on
 * identity changes to detect updates, poll the fields"), so the only way to
 * learn from the ref that a pan began is to poll it every frame — which is the
 * permanent rAF loop `S4` exists to delete. The store is no help either: its
 * `zoom`/`panX`/`panY` land 100 ms after the gesture is already over.
 *
 * So the gesture publishes itself. `useCanvas`'s single DOM-write funnel
 * (`applyTransformToDOM`) marks activity on every write; the flag self-clears
 * `CANVAS_VIEWPORT_IDLE_MS` after the last one, which makes "the pan ended" an
 * event instead of something every consumer has to discover by polling.
 *
 * ## Why a module-level broadcast, not store state or context
 *
 * `canvasGesture.ts`'s reasoning applies verbatim, and this module is its
 * sibling on the other axis (that one is "a pointer gesture is mutating the
 * PAGE"; this one is "the VIEWPORT is moving" — a pan mutates nothing and must
 * not freeze the auto-height refit the way a page-mutating gesture does, which
 * is why they are two flags and not one). The readers are rAF pumps and
 * observer callbacks, not React renders, and routing a 60 Hz flag through the
 * store would re-render every subscriber twice per gesture for a value no UI
 * displays. Context does not work either: the toolbar's zoom controls are
 * painted by `AdminCanvasLayout` ABOVE the lazy boundary that mounts the
 * canvas, so they are not descendants of `CanvasViewportActionsContext` — see
 * `canvas-internals.md`, "Chrome outside `CanvasRoot`".
 */

/**
 * How long after the last transform write the viewport is still considered
 * "active". Deliberately LONGER than `useCanvas`'s 100 ms debounced store
 * commit, so a consumer that re-measures on both signals is still armed when
 * the commit lands rather than having to re-arm for it.
 */
export const CANVAS_VIEWPORT_IDLE_MS = 150

let active = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(active: boolean) => void>()

function emit(): void {
  for (const listener of listeners) listener(active)
}

/**
 * Report a pan/zoom transform write. Called from `useCanvas`'s
 * `applyTransformToDOM` — the one place every wheel, pinch, drag, keyboard and
 * zoom-to-fit write goes through.
 *
 * `holdMs` extends the idle window for a write the browser will keep animating
 * after the call returns (the `data-animating` CSS transition on a discrete
 * zoom), so the frames are not still gliding after every consumer has been
 * told the viewport went quiet.
 */
export function markCanvasViewportActivity(holdMs = 0): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!active) return
    active = false
    emit()
  }, Math.max(holdMs, CANVAS_VIEWPORT_IDLE_MS))

  if (active) return
  active = true
  emit()
}

/** Whether a pan/zoom is in flight (or settled less than the idle window ago). */
export function isCanvasViewportActive(): boolean {
  return active
}

/** Subscribe to the active↔idle transitions. Returns an unsubscribe. */
export function onCanvasViewportActivityChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
