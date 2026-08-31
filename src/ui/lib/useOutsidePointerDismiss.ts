/**
 * useOutsidePointerDismiss — "a pointer went down somewhere that isn't mine".
 *
 * Non-modal dismissal for floating surfaces: menus, dropdowns, the canvas's
 * comment thread popover. The pointer event is observed in the CAPTURE phase
 * and never cancelled, so the same click still reaches whatever is underneath
 * — closing a popover and clicking the thing behind it is one gesture, not
 * two.
 *
 * WHY IT LISTENS ON MORE THAN `document`
 * ──────────────────────────────────────
 * The editor renders its preview inside same-origin iframes. A pointer event
 * inside one of those fires on the IFRAME's document and never bubbles to the
 * parent, so a listener on `document` alone leaves the surface stuck open
 * until the user clicks the surrounding chrome. `collectSameOriginDocuments`
 * enumerates every reachable document; `isNode` then does the cross-realm-safe
 * target check, because a node from an iframe realm fails the parent realm's
 * `instanceof Node`.
 *
 * This was `ContextMenu`'s private effect. The comment popover needed exactly
 * the same behaviour — including both iframe subtleties, which are the kind of
 * thing a second copy gets wrong six months later — so it moved here and
 * `ContextMenu` now calls it.
 */
import { useEffect, useEffectEvent, type RefObject } from 'react'
import { collectSameOriginDocuments, isNode } from './sameOriginDocuments'

interface OutsidePointerDismissOptions {
  /** Runs when a pointer goes down outside every `ignore` element. */
  onDismiss: () => void
  /**
   * Elements that count as "inside". The surface itself belongs here, and so
   * does the trigger that opened it — otherwise clicking the trigger to close
   * would dismiss on the way down and reopen on the way up. Nulls are skipped,
   * so callers can pass refs that are not populated yet.
   */
  ignore: ReadonlyArray<RefObject<HTMLElement | null> | undefined>
  /** Set false to detach the listeners entirely (surface closed). */
  enabled?: boolean
}

export function useOutsidePointerDismiss({
  onDismiss,
  ignore,
  enabled = true,
}: OutsidePointerDismissOptions): void {
  // `ignore` is a fresh array literal and `onDismiss` is usually an inline
  // arrow, so both change identity every render. `useEffectEvent` reads the
  // latest of each at EVENT time, which leaves the effect below depending on
  // `enabled` alone — one subscribe per open/close rather than one per render.
  // That matters here: subscribing walks every same-origin iframe document.
  const handlePointerDown = useEffectEvent((event: MouseEvent) => {
    const target = event.target
    if (!isNode(target)) return
    if (ignore.some((ref) => ref?.current?.contains(target))) return
    onDismiss()
  })

  useEffect(() => {
    if (!enabled) return undefined

    const docs = collectSameOriginDocuments()
    for (const doc of docs) {
      doc.addEventListener('mousedown', handlePointerDown, true)
      doc.addEventListener('contextmenu', handlePointerDown, true)
    }
    return () => {
      for (const doc of docs) {
        doc.removeEventListener('mousedown', handlePointerDown, true)
        doc.removeEventListener('contextmenu', handlePointerDown, true)
      }
    }
  }, [enabled])
}
