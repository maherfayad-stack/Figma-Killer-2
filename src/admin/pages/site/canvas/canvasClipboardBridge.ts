/**
 * canvasClipboardBridge — ⌘C / ⌘X / ⌘V driven by the browser's own clipboard
 * EVENTS, heard in every document the canvas owns (P5-A; the sixth bridged
 * event in `docs/agent-refs/canvas-internals.md`).
 *
 * ## Why the events, and not the keydown
 *
 * ⌘V used to be handled entirely on `keydown`, which called
 * `preventDefault()` — and cancelling the keydown cancels the paste itself,
 * so no `paste` event ever fired. That is the only place a page can read the
 * clipboard WITHOUT a permission prompt (`ClipboardEvent.clipboardData`), so
 * an image or an SVG on the OS clipboard was unreachable. The keydown now
 * only ARMS a paste ({@link armCanvasPaste}) and lets the browser run its
 * default; the `paste` event that follows carries the data.
 *
 * Copy is the mirror image: a node copy lets its keydown through, and the
 * `copy` / `cut` event that follows writes the Studio MARKER onto the OS
 * clipboard (`canvasClipboardData.ts` says why the marker exists).
 *
 * ## Why every frame document
 *
 * A native clipboard event does not cross the iframe boundary. Clicking a node
 * focuses its frame's iframe, so the paste that ⌘V raises fires in THAT
 * document, not the editor's. `useIframeEventForwarding` installs this bridge
 * on each portal frame's document, and `useCanvasClipboardBridge` on the
 * editor's own. The keyboard clone the key relay dispatches on the parent
 * `document` does NOT produce a clipboard event — only the original, in the
 * frame, does — which is why this is a bridge of its own rather than a ride
 * on the key relay.
 *
 * ## The fallback: when no event comes
 *
 * Safari fires `paste` / `copy` only on an editable target or a text
 * selection, and a Tier 2 BRIDGE frame is cross-origin, so its events are
 * never heard at all (its keys arrive as messages, after the fact). Every
 * engine raises the clipboard event synchronously inside the keydown's
 * default action — the same task — so a timer armed at keydown runs only
 * when no event came. Then:
 *
 *   - paste reads `navigator.clipboard.read()` (the first use may show the
 *     browser's permission prompt or Safari's "Paste" callout); a refusal or a
 *     missing API reads as "unreadable", and the decision falls back to the
 *     layers the clipboard slice holds — what ⌘V did before;
 *   - the marker is written with `navigator.clipboard.write()` (`text/html`),
 *     or `writeText` where `ClipboardItem` is missing.
 *
 * A copy made WITHOUT a keystroke (a context menu, the palette) has no event
 * coming either, and takes the same fallback — which is why the marker is
 * announced by the clipboard slice's entry changing (`useCanvasClipboardBridge`)
 * rather than by the ⌘C handler.
 *
 * ## What this module does not decide
 *
 * Whether a clipboard event belongs to the canvas, and what a paste does, are
 * the registered {@link CanvasClipboardSink}'s (`useCanvasClipboardBridge` /
 * `canvasPaste.ts`). This module only moves data between the browser and it.
 */
import {
  STUDIO_NODES_MIME,
  UNREADABLE_CLIPBOARD,
  snapshotFromClipboardItems,
  snapshotFromDataTransfer,
  studioMarkerHtml,
  type ClipboardSnapshot,
} from './canvasClipboardData'

export interface CanvasClipboardSink {
  /** Whether a clipboard event raised at `target` is the canvas's to answer (not a text field's, a dialog's, an inline edit's). */
  owns: (target: EventTarget | null) => boolean
  paste: (snapshot: ClipboardSnapshot) => void
}

type Timer = ReturnType<typeof setTimeout>

let sink: CanvasClipboardSink | null = null
/** Armed by ⌘V's keydown; cleared by the `paste` event it raises, or run when none came. */
let pasteFallback: Timer | null = null
/** The marker a copy owes the OS clipboard, until a `copy`/`cut` event or the fallback writes it. */
let pendingMarker: { copiedAt: number; fallback: Timer } | null = null

/** One sink at a time — the mounted canvas's. Returns the unregister. */
export function registerCanvasClipboardSink(next: CanvasClipboardSink): () => void {
  sink = next
  return () => {
    if (sink !== next) return
    sink = null
    if (pasteFallback !== null) clearTimeout(pasteFallback)
    pasteFallback = null
    if (pendingMarker) clearTimeout(pendingMarker.fallback)
    pendingMarker = null
  }
}

/**
 * ⌘V's keydown: a paste is coming. The `paste` event this keystroke's default
 * action raises carries the data; if none arrives in this task, the async
 * Clipboard API is asked instead.
 */
export function armCanvasPaste(): void {
  if (pasteFallback !== null) clearTimeout(pasteFallback)
  pasteFallback = setTimeout(() => {
    pasteFallback = null
    void pasteFromAsyncClipboard()
  }, 0)
}

async function pasteFromAsyncClipboard(): Promise<void> {
  const snapshot = await readAsyncClipboard()
  sink?.paste(snapshot)
}

/** `navigator.clipboard.read()`, reduced to a snapshot; never throws. */
export async function readAsyncClipboard(): Promise<ClipboardSnapshot> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard || typeof clipboard.read !== 'function') return UNREADABLE_CLIPBOARD
  try {
    return await snapshotFromClipboardItems(await clipboard.read())
  } catch (err) {
    // Refused (no permission, the document is not focused) — an expected
    // answer, not a fault: the decision falls back to the slice's layers.
    console.warn('[canvas-clipboard] the clipboard could not be read:', err)
    return UNREADABLE_CLIPBOARD
  }
}

/**
 * A copy put new layers in the clipboard slice: the OS clipboard owes a
 * marker. Written by the `copy`/`cut` event this keystroke raises, else by
 * the async API once this task ends.
 */
export function announceStudioCopy(copiedAt: number): void {
  if (pendingMarker) clearTimeout(pendingMarker.fallback)
  const fallback = setTimeout(() => {
    if (pendingMarker?.fallback !== fallback) return
    pendingMarker = null
    void writeMarkerToAsyncClipboard(copiedAt)
  }, 0)
  pendingMarker = { copiedAt, fallback }
}

async function writeMarkerToAsyncClipboard(copiedAt: number): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard) return
  const html = studioMarkerHtml(copiedAt)
  try {
    if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
      await clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }) })])
    } else if (typeof clipboard.writeText === 'function') {
      await clipboard.writeText(html)
    }
  } catch (err) {
    // The layers are still in the slice; only the OS clipboard's tie-break
    // is missing, so an older image there could win the next ⌘V.
    console.warn('[canvas-clipboard] the copy marker could not be written:', err)
  }
}

/**
 * Listen for `copy`, `cut` and `paste` in one document — the editor's own, or
 * a frame's. Returns the uninstall.
 */
export function installCanvasClipboardBridge(doc: Document): () => void {
  const onCopyOrCut = (event: ClipboardEvent) => {
    const marker = pendingMarker
    if (!marker || !event.clipboardData) return
    clearTimeout(marker.fallback)
    pendingMarker = null
    event.preventDefault()
    event.clipboardData.setData(STUDIO_NODES_MIME, String(marker.copiedAt))
    event.clipboardData.setData('text/html', studioMarkerHtml(marker.copiedAt))
  }

  const onPaste = (event: ClipboardEvent) => {
    // The event came: whatever ⌘V armed is answered here or by whoever owns
    // the target, never by the fallback as well.
    if (pasteFallback !== null) clearTimeout(pasteFallback)
    pasteFallback = null
    if (event.defaultPrevented) return
    const current = sink
    if (!current || !current.owns(event.target)) return
    event.preventDefault()
    current.paste(snapshotFromDataTransfer(event.clipboardData))
  }

  doc.addEventListener('copy', onCopyOrCut)
  doc.addEventListener('cut', onCopyOrCut)
  doc.addEventListener('paste', onPaste)
  return () => {
    doc.removeEventListener('copy', onCopyOrCut)
    doc.removeEventListener('cut', onCopyOrCut)
    doc.removeEventListener('paste', onPaste)
  }
}
