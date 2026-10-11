/**
 * useEditorKeyDispatcher — the editor workspace's ONE keyboard listener, and
 * the React side of `editorKeyDispatcher.ts`'s scope ladder.
 *
 * Mounted exactly once, in `SitePage`. Read `editorKeyDispatcher.ts` first for
 * the ladder and why it exists; this file is only the mount and the two hooks
 * everything else uses.
 *
 * ## Why `document`, and why the bubble phase
 *
 * `document`, not a React `onKeyDown` on the canvas div, for the two reasons
 * the hooks it replaces each documented at length:
 *
 *  1. **Keystrokes born inside a frame iframe.** Clicking a node focuses the
 *     clicked element in the iframe's own document, so every keystroke after a
 *     selection is raised in a different realm. `useIframeEventForwarding`
 *     re-dispatches a clone on the PARENT `document` (not on the iframe
 *     element — that would double-fire anything listening via fiber bubbling),
 *     and a raw `document` listener is the only shape guaranteed to see both
 *     that clone and an ordinary parent-document event.
 *  2. **Keystrokes pressed while a PANEL holds focus.** Selecting a node opens
 *     the Properties panel; one click in there and a focus-scoped handler is
 *     dead for the rest of the session. That defect was reported twice —
 *     `board-02` for ⌘A, `select-01` for Escape — and fixed twice by moving to
 *     `document`. Scope by INTENT, never by focus.
 *
 * BUBBLE phase, so anything that owns a key more locally — an armed comment
 * tool, a pin drag, a prototype link pick, `CanvasTreeLadderOverlay`'s Alt-hold
 * ladder, a `Dialog` — runs first and marks the event handled. The dispatcher
 * stands down on `defaultPrevented` and never calls `stopPropagation`, so a
 * `Dialog` mounted after it keeps its own Escape-to-close.
 */
import { useEffect, useEffectEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import {
  dispatchEditorKeyDown,
  dispatchEditorKeyUp,
  registerEditorKeyScope,
  releaseEditorKeysIfFocusLeft,
  type EditorKeyScope,
  type EditorKeyScopeId,
} from './editorKeyDispatcher'

/**
 * The top rung: while a canvas inline text edit is open, the contentEditable
 * element owns the keyboard and every scope below this one stands down.
 *
 * Claims without acting. It is a module constant rather than a registration
 * some hook has to remember to make, because forgetting it is how store and
 * DOM diverge permanently (⌘Z runs the store `undo()` while the DOM keeps the
 * typed text) — see `editorKeyDispatcher.ts`.
 */
const INLINE_EDIT_HALT: EditorKeyScope = {
  id: 'inline-edit',
  isActive: () => useEditorStore.getState().activeInlineEdit !== null,
  handle: () => true,
}

/**
 * Register a scope handler for as long as the calling component is mounted.
 *
 * `isActive` / `handle` / `handleKeyUp` are read through `useEffectEvent`, so
 * they always see the latest props and the registration effect never re-runs
 * just because a callback changed identity. Express "this hook is switched
 * off" (live mode, read-only, nothing selected) inside `isActive` rather than
 * by skipping the call — hooks are unconditional.
 */
export function useEditorKeyScope(
  id: EditorKeyScopeId,
  isActive: () => boolean,
  handle: (event: KeyboardEvent) => boolean,
  handleKeyUp?: (event: KeyboardEvent | null) => void,
): void {
  const isActiveEvent = useEffectEvent(isActive)
  const handleEvent = useEffectEvent(handle)
  const handleKeyUpEvent = useEffectEvent((event: KeyboardEvent | null) => handleKeyUp?.(event))

  useEffect(
    () =>
      registerEditorKeyScope({
        id,
        isActive: () => isActiveEvent(),
        handle: (event) => handleEvent(event),
        handleKeyUp: (event) => handleKeyUpEvent(event),
      }),
    [id],
  )
}

/** Mounts THE editor keydown/keyup listener. Call once, from `SitePage`. */
export function useEditorKeyDispatcher(): void {
  useEffect(() => registerEditorKeyScope(INLINE_EDIT_HALT), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Somebody nearer the event already answered it. Checked once, here,
      // instead of as the first line of nine separate handlers.
      if (event.defaultPrevented) return
      dispatchEditorKeyDown(event)
    }
    const onKeyUp = (event: KeyboardEvent) => dispatchEditorKeyUp(event)
    // ERR-11 — focus leaving the editor releases every key: whatever is still
    // held will send its keyup to some other application. A blur that only
    // moved focus INTO a frame is not a release (`releaseEditorKeysIfFocusLeft`);
    // a frame losing focus in its turn is reported by its relay.
    const onWindowBlur = () => releaseEditorKeysIfFocusLeft(document)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') dispatchEditorKeyUp(null)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
