/**
 * frameFitMutationScheduler — decides WHEN a frame's fit pin is re-derived
 * from scratch after its DOM mutated. One implementation for both halves of
 * the canvas: the portal frame's `useIframeFrameAutoHeight` and the live
 * runtime's layout observer (`runtime.ts`). It lives in `@core/studio-runtime`
 * because the runtime ships to a real browser with zero admin imports.
 *
 * Re-deriving the fit (`resolveFrameFitHeight.ts`) resets the pin to the
 * viewport floor and re-runs `collectScrollDeficits` — an O(every element)
 * forced layout, up to `MAX_FRAME_FIT_PASSES` times. It is the only way a
 * frame can SHRINK after content is removed, so it must run after a real
 * content change, and must not run for anything else.
 *
 * ## What never resets the fit
 *
 *   - **The editor's own selection chrome** (`isSelectionChromeMutation`,
 *     audit PERF-2). A hover ring appearing is a `childList` record under
 *     `<body>`; before this filter, every hover crossing re-ran the forced
 *     layout in every frame that mounted a ring.
 *   - **Attribute-only batches** (audit PERF-9). A JS-animated app
 *     (framer-motion, a carousel) writes `style`/`class` every frame; each
 *     one used to reset the live frame's fit and could make its height
 *     oscillate. The portal observer never subscribes to attributes at all,
 *     so this is the same rule on both sides.
 *   - So the live runtime's OWN writes need no special case: its pin on
 *     `body.style`, its resize preview stamp and its optimistic style stamp
 *     are all attribute records.
 *
 * ## What does, and when
 *
 *   - **Text-only** (`characterData`) debounces to the next pause
 *     (`textDebounceMs`). Inline text editing mutates a text node once per
 *     keystroke; a burst collapses into one re-derivation. It only delays
 *     when the pin can shrink — growth rides the cheap ResizeObserver path.
 *   - **Structural** (`childList`) settles after `structuralDebounceMs`:
 *     `0` (immediate) for a portal frame, whose DOM changes only when the
 *     user does something (a delete should shrink the frame right away);
 *     a trailing debounce for a live frame, whose app may add and remove
 *     nodes every frame on its own. A structural record cancels a pending
 *     text debounce — "type, then delete a block" must not leave a stale
 *     settle to fire later.
 *
 * A batch with nothing relevant in it is a no-op: it neither settles nor
 * cancels a pending settle.
 */
import { isSelectionChromeMutation } from './selectionChromeMutation'

export interface FrameFitMutationSchedulerOptions {
  /** Runs the reset-to-floor + re-measure. Called at most once per settle. */
  onSettle: () => void
  /** How long a text-only mutation burst can stay quiet before settling. */
  textDebounceMs: number
  /** How long a structural burst can stay quiet before settling; `0` settles synchronously. */
  structuralDebounceMs: number
  /** Injectable for tests; defaults to the real global timer. */
  setTimeoutFn?: typeof setTimeout
  /** Injectable for tests; defaults to the real global timer. */
  clearTimeoutFn?: typeof clearTimeout
}

export interface FrameFitMutationScheduler {
  /** Feed one MutationObserver callback's records through. */
  handle(records: readonly MutationRecord[]): void
  /** Cancel any pending debounced settle — call on unmount. */
  dispose(): void
}

/** Typing-pause debounce window: long enough to collapse ordinary typing
 * cadence (well under 150ms between keystrokes) into one settle, short
 * enough that the pause after the user stops is imperceptible. */
export const FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS = 200

/**
 * A live frame's structural debounce. An app that re-renders a list every
 * animation frame produces a `childList` batch every 16 ms; 250 ms of quiet
 * is several frames of "the app stopped moving" before the forced layout runs.
 */
export const LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS = 250

export function createFrameFitMutationScheduler({
  onSettle,
  textDebounceMs,
  structuralDebounceMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: FrameFitMutationSchedulerOptions): FrameFitMutationScheduler {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const clearPending = () => {
    if (timeoutId !== null) {
      clearTimeoutFn(timeoutId)
      timeoutId = null
    }
  }

  const settleAfter = (delayMs: number) => {
    clearPending()
    if (delayMs <= 0) {
      onSettle()
      return
    }
    timeoutId = setTimeoutFn(() => {
      timeoutId = null
      onSettle()
    }, delayMs)
  }

  return {
    handle(records) {
      let structural = false
      let text = false
      for (const record of records) {
        if (record.type === 'attributes') continue
        if (isSelectionChromeMutation(record)) continue
        if (record.type === 'childList') structural = true
        else text = true
      }
      if (structural) settleAfter(structuralDebounceMs)
      else if (text) settleAfter(textDebounceMs)
    },
    dispose() {
      clearPending()
    },
  }
}
