/**
 * frameFitMutationScheduler — coalesces the MutationObserver callback that
 * drives `useIframeFrameAutoHeight`'s "content really changed, re-derive the
 * fit pin from scratch" reset (`resolveFrameFitHeight.ts`).
 *
 * The defect this exists to fix
 * ──────────────────────────────
 * Inline text editing (`contentEditable="plaintext-only"`, see
 * `docs/agent-refs/canvas-internals.md` → "Inline text editing") mutates a
 * text node once per keystroke — a `characterData` record. Before this
 * module existed, the observer callback reacted to EVERY one of those
 * synchronously: reset `pinnedHeight` to the `CANVAS_VIEWPORT_HEIGHT` floor,
 * reset the pass budget, write `body.style.height`, and re-measure — which
 * re-runs `collectScrollDeficits`, an O(every element in body) forced-reflow
 * scan (`el.scrollHeight`/`el.clientHeight` on every descendant), up to
 * `MAX_FRAME_FIT_PASSES` times as each growth write retriggers the
 * `ResizeObserver`. That's a full-body forced reflow, several times over, on
 * every character typed.
 *
 * Why the fix is NOT "stop observing `characterData`"
 * ─────────────────────────────────────────────────────
 * Unlike `CanvasScrollUnrollInjector`'s tagging pass — which only cares about
 * an element's `position`/explicit-height, never its text content, so it
 * safely omits `characterData` from its own `MutationObserver` config — this
 * reset's whole job is to notice when typed content has grown or shrunk an
 * inner scroll region's deficit. A frame that never re-measured on typed text
 * would stop settling to the right height while the user types, which is a
 * worse bug than the perf cost.
 *
 * The fix: classify by mutation kind.
 * ─────────────────────────────────────
 *   - STRUCTURAL (any `childList` record — a node inserted or removed) still
 *     settles IMMEDIATELY, exactly as before. This is rare (drag/drop,
 *     delete, undo, a structural codemod write reflected back into the DOM)
 *     and wants instant feedback — a deleted section should shrink the frame
 *     right away, not after a delay.
 *   - TEXT-ONLY (every record is `characterData`) DEBOUNCES the settle to the
 *     next pause in typing. A fast-typing burst collapses into ONE
 *     re-derivation instead of one per character. This only delays WHEN the
 *     pin can shrink back down after content shrinks (deleting a paragraph
 *     doesn't shrink the frame until typing pauses); it never affects the
 *     frame's general "content grew, frame followed" behaviour, which rides
 *     the separate, cheap `ResizeObserver`-driven measurement path in
 *     `useIframeFrameAutoHeight.ts` (two `scrollHeight` property reads, not
 *     an all-elements scan) and is unaffected by this module.
 *
 * A later structural mutation cancels any pending text-only debounce (and
 * settles immediately instead) — a rapid "type, then delete a sibling block"
 * sequence must not leave a stale debounced settle to fire moments later
 * with the wrong content already gone.
 */

export interface FrameFitMutationSchedulerOptions {
  /** Runs the reset-to-floor + re-measure. Called at most once per settle. */
  onSettle: () => void
  /** How long a text-only mutation burst can stay quiet before settling. */
  debounceMs: number
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

export function createFrameFitMutationScheduler({
  onSettle,
  debounceMs,
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

  return {
    handle(records) {
      clearPending()
      const isStructural = records.some((record) => record.type === 'childList')
      if (isStructural) {
        onSettle()
        return
      }
      timeoutId = setTimeoutFn(() => {
        timeoutId = null
        onSettle()
      }, debounceMs)
    },
    dispose() {
      clearPending()
    },
  }
}
