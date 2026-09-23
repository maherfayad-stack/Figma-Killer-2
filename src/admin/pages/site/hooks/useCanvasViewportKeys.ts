/**
 * useCanvasViewportKeys — the keys that move the VIEW, as one scope on the
 * editor key ladder (`global` rung): + / = zoom in, − / _ zoom out, ⌘0 / ⇧0 zoom
 * to 100%, ⇧1 fit, ⇧2 fit the selection, and Space held to pan.
 *
 * ## What it replaced (P2-B, IX-15)
 *
 * Three key paths `useCanvas` owned outside the dispatcher:
 *
 *   - a React `onKeyDown` on the canvas div for + / − / ⇧1 / ⇧2, which only
 *     fires while a canvas descendant holds DOM focus — so one click into the
 *     Properties panel killed zoom for the session. The same defect class
 *     `board-02` fixed for ⌘A and `select-01` fixed for Escape;
 *   - a raw `document` listener for Space, and another for ⌘0, each with a
 *     hand-copied "am I typing?" guard, and neither standing down during an
 *     inline edit on its own.
 *
 * `keybindings-single-dispatcher.test.ts` only scanned `canvas/`, so all three
 * passed the gate unseen. It scans `hooks/` too now.
 *
 * ## Why `global`, the bottom rung
 *
 * None of these keys means anything to a higher rung: the `node` and `board`
 * scopes never claim a bare `-` or a Space. Being last means anything more
 * specific wins without negotiation, and the `inline-edit` halt at the top
 * already covers "`-` typed mid-edit must not zoom" — which the old React
 * handler had to re-check by hand because a synthetic event crosses the iframe.
 *
 * ## Space is a hold
 *
 * keydown raises the `parentDocument` pan source (every auto-repeat re-asserts
 * it), and the keyup broadcast lowers BOTH keyboard sources — for a Space
 * released, and for `null`, "every key is up" (the window lost focus, ERR-11).
 * `releaseCanvasKeyboardPan` says why both. The hand tool's latch is never
 * touched here: only another tool puts it away.
 */
import { useEffect, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useEditorKeyScope } from '@site/canvas/useEditorKeyDispatcher'
import { isInsideKeyOwningOverlay, isSpaceOwningControlTarget, isTextInputTarget } from '@site/canvas/editorKeyGuards'
import { releaseCanvasKeyboardPan, setCanvasSpacePanActive } from '@site/canvas/canvasPanInput'

interface CanvasViewportKeysOptions {
  /** False in live view: there is no board to move. The keyup release still runs. */
  enabled: boolean
  /** Zoom +/− anchor on the middle of this element's visible box. */
  canvasRootRef: RefObject<HTMLElement | null>
  resetCanvasView: () => void
  zoomToFit: () => void
  zoomToSelection: () => void
}

type ViewportIntent = 'zoomIn' | 'zoomOut' | 'zoomReset' | 'zoomToFit' | 'zoomToSelection'

const VIEWPORT_INTENTS: ReadonlyArray<ViewportIntent> = [
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'zoomToFit',
  'zoomToSelection',
]

function matchViewportIntent(event: KeyboardEvent): ViewportIntent | null {
  for (const intent of VIEWPORT_INTENTS) {
    if (getKeybindingForCommand(`canvas.${intent}`)?.match(event)) return intent
  }
  return null
}

function isSpacePanKey(event: KeyboardEvent): boolean {
  return getKeybindingForCommand('canvas.spacePan')?.match(event) === true
}

export function useCanvasViewportKeys({
  enabled,
  canvasRootRef,
  resetCanvasView,
  zoomToFit,
  zoomToSelection,
}: CanvasViewportKeysOptions): void {
  const zoomAroundViewportCenter = (direction: 'in' | 'out') => {
    const store = useEditorStore.getState()
    const zoom = direction === 'in' ? store.zoomIn : store.zoomOut
    const el = canvasRootRef.current
    if (!el) {
      zoom()
      return
    }
    const rect = el.getBoundingClientRect()
    zoom(rect.width / 2, rect.height / 2)
  }

  useEditorKeyScope(
    'global',
    () => enabled,
    (event) => {
      if (isSpacePanKey(event)) {
        // A focused checkbox / select / field keeps Space — see the guard.
        if (isSpaceOwningControlTarget(event.target)) return false
        event.preventDefault()
        setCanvasSpacePanActive(document, 'parentDocument', true)
        return true
      }

      const intent = matchViewportIntent(event)
      if (!intent) return false
      if (isTextInputTarget(event.target)) return false
      if (isInsideKeyOwningOverlay(event.target)) return false

      event.preventDefault()
      switch (intent) {
        case 'zoomIn':
          zoomAroundViewportCenter('in')
          return true
        case 'zoomOut':
          zoomAroundViewportCenter('out')
          return true
        case 'zoomReset':
          resetCanvasView()
          return true
        case 'zoomToFit':
          zoomToFit()
          return true
        case 'zoomToSelection':
          zoomToSelection()
          return true
      }
    },
    (event) => {
      if (event === null || isSpacePanKey(event)) releaseCanvasKeyboardPan(document)
    },
  )

  // A canvas unmounted mid-hold (a view switch while Space is down) must not
  // leave the flag behind for the next one.
  useEffect(() => () => releaseCanvasKeyboardPan(document), [])
}
