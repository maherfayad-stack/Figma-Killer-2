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
 * The RELAY is still files-only: `useCanvasFileDrop` listens on the parent
 * `window` and only wants the drags it can turn into an `<img>`. Cancelling
 * without relaying is the honest answer for everything else — nothing
 * happens, which is what a design frame should do with a dragged link.
 *
 * Design frames only. A live (Tier 2) frame belongs to the running project:
 * its document is the app's, a drop there is the app's, and Studio does not
 * reach into it. `useIframeEventForwarding` is what makes that call.
 */
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'

/** True when this drag is carrying files from outside the browser. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes('Files')
}

/**
 * Listen for `dragover`/`drop` in a design frame's document: cancel every one
 * of them, and re-dispatch the file-carrying ones on the iframe ELEMENT in the
 * parent document so they bubble to the board's own `window` handler.
 *
 * The ORIGINAL `DataTransfer` is carried through on the clone rather than
 * copied: `DataTransferItemList` is read-only outside a drag's own event
 * handlers, so there is nothing to copy it into, and the files are the whole
 * payload.
 *
 * Returns the teardown.
 */
export function installFrameDragRelay(iframeDoc: Document, iframe: HTMLIFrameElement): () => void {
  const relay = (event: DragEvent) => {
    // Unconditional, and before the files test — see this module's own doc.
    // `dragover` has to be cancelled as well, or `drop` is never delivered at
    // all and the browser performs its default on the document directly.
    event.preventDefault()
    if (!carriesFiles(event.dataTransfer)) return

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
