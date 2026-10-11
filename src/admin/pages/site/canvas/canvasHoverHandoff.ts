/**
 * canvasHoverHandoff — where a portal frame's hover goes when the pointer
 * LEAVES a node's element (perf-12's side note, fixed by live-frame parity).
 *
 * `mouseleave` from a child into its own parent fires on the child only. The
 * parent never gets a `mouseenter` — the pointer never left it — so a leave
 * that cleared the hover left the parent with no ring while the pointer sat
 * on it. The leave hands the hover to the node the pointer went INTO
 * (`relatedTarget`) instead: the parent in that case, the sibling when it
 * crossed straight into one (whose own `mouseenter` then agrees), and nothing
 * when it left the frame or went onto the editor's own chrome.
 *
 * A live frame never had this bug: its runtime resolves the node under every
 * coalesced pointer move (`gestureForwarding.ts`), so hover follows position,
 * not enter/leave pairs.
 */
import { SELECTION_OVERLAY_ROOT_ID, STUDIO_NODE_ID_ATTR as NODE_ID_ATTR } from '@core/studio-runtime'

/** Duck-typed, not `instanceof Element`: the target lives in the frame's own realm. */
function asElement(target: EventTarget | null): Element | null {
  return target !== null && typeof (target as Partial<Element>).closest === 'function' ? (target as Element) : null
}

/** The node id the pointer moved INTO on a leave, or `null` when it moved onto no node (outside the frame, or onto the selection chrome). */
export function canvasNodeIdEnteredOnLeave(relatedTarget: EventTarget | null): string | null {
  const entered = asElement(relatedTarget)
  if (!entered || entered.closest(`#${SELECTION_OVERLAY_ROOT_ID}`)) return null
  return entered.closest(`[${NODE_ID_ATTR}]`)?.getAttribute(NODE_ID_ATTR) ?? null
}
