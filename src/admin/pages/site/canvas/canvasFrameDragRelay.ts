/**
 * canvasFrameDragRelay — what a native HTML5 drag that happens INSIDE a design
 * frame's document means to the board (D2 G15, hardened by `sec-17`).
 *
 * Extracted out of `useIframeEventForwarding`'s fourth effect so the rule can
 * be driven directly: the effect around it is React lifecycle, but the rule
 * itself is two listeners on a document and has one security-relevant
 * decision in it.
 *
 * ## The default action is the danger, and it is not only files
 *
 * A design frame's document is a rendering of the user's parsed source, hosted
 * in an iframe the editor portals React into. It has no native drop behaviour
 * anyone wants. The BROWSER, however, has one for every drop a page leaves
 * uncancelled — it navigates the document that received it. Drop a file and
 * the frame becomes a bare image; drop a link, a bookmark, a selected URL, or
 * an image dragged out of another tab and the frame becomes THAT PAGE, loaded
 * cross-origin inside the editor's own chrome. Either way the portal's React
 * root is gone and the frame is dead until a reload.
 *
 * So the cancel is unconditional and comes first. The earlier shape only
 * cancelled a drag it recognised as carrying files, which left every
 * `text/uri-list` drag — the single easiest one to perform by accident, and
 * the one whose result is an attacker-chosen page rendered where the user's
 * own design was — going through to the browser's default.
 *
 * The RELAY carries what `useCanvasFileDrop` can turn into an `<img>`:
 * files, and — since IMG-5 — a LINK, because an image dragged out of another
 * browser tab arrives as `text/uri-list`. The link is not trusted here, and
 * cannot even be read (the drag data store is protected until `drop`); the
 * board's own intake (`canvasDropIntake.ts`) reads it at drop and refuses a
 * link that is not an image, or not http(s)/`data:image`, without a single
 * request. A relayed link therefore never navigates anything: the original
 * event was cancelled above, and the clone reaches a handler that either
 * lands an image or says no. Every other drag (plain text, an in-page drag)
 * is cancelled and not relayed — nothing happens, which is what a design
 * frame should do with it.
 *
 * Design frames only. A live (Tier 2) frame belongs to the running project:
 * its document is the app's, a drop there is the app's, and Studio does not
 * reach into it. `useIframeEventForwarding` is what makes that call.
 */
import { carriesLink } from './canvasDropIntake'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'

/** True when this drag carries something the board's drop intake reads: files, or a link (IMG-5). */
function carriesDroppable(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  const types = Array.from(transfer.types)
  return types.includes('Files') || carriesLink(types)
}

/**
 * Listen for `dragover`/`drop` in a design frame's document: cancel every one
 * of them, and re-dispatch the ones carrying files or a link on the iframe ELEMENT in the
 * parent document so they bubble to the board's own `window` handler.
 *
 * The ORIGINAL `DataTransfer` is carried through on the clone rather than
 * copied: `DataTransferItemList` is read-only outside a drag's own event
 * handlers, so there is nothing to copy it into, and the files (or the link)
 * are the whole payload.
 *
 * Returns the teardown.
 */
export function installFrameDragRelay(iframeDoc: Document, iframe: HTMLIFrameElement): () => void {
  const relay = (event: DragEvent) => {
    // Unconditional, and before the files test — see this module's own doc.
    // `dragover` has to be cancelled as well, or `drop` is never delivered at
    // all and the browser performs its default on the document directly.
    event.preventDefault()
    if (!carriesDroppable(event.dataTransfer)) return

    const rect = iframe.getBoundingClientRect()
    const clientPoint = iframeLocalPointToParentClientPoint(
      rect,
      { width: iframe.clientWidth, height: iframe.clientHeight },
      { x: event.clientX || 0, y: event.clientY || 0 },
    )
    iframe.dispatchEvent(
      new DragEvent(event.type, {
        bubbles: true,
        cancelable: true,
        clientX: clientPoint.x,
        clientY: clientPoint.y,
        dataTransfer: event.dataTransfer,
        // P5-B — the held keys ARE part of what a drop means (⌥ inserts
        // beside an image instead of replacing it, ⇧ sets a background, ⌘
        // places at the pointer), and a clone that dropped them would make a
        // drop inside a frame mean something different from the same drop
        // over the frame's edge.
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      }),
    )
  }

  iframeDoc.addEventListener('dragover', relay)
  iframeDoc.addEventListener('drop', relay)
  return () => {
    iframeDoc.removeEventListener('dragover', relay)
    iframeDoc.removeEventListener('drop', relay)
  }
}
