/**
 * The capture page's inspect surface — the browser end of
 * `frameInspectWire.ts`.
 *
 * `captureReadiness.ts` answers "is every frame finished"; this answers "now
 * tell me something about one of them". They are separate because the driver
 * uses them at different moments and in different ways: readiness is POLLED
 * until it flips, an inspect is CALLED once, afterwards, with an argument.
 *
 * All this module owns is the map from page id to the settled iframe document
 * plus the global the driver calls. The reading itself is
 * `@core/studio-capture`'s `inspectFrameDocumentJson`, shared verbatim with the
 * live editor canvas.
 *
 * A document is registered only once its frame has genuinely SETTLED. An
 * inspect of a mid-layout frame would report fonts that had not loaded and
 * boxes that were about to move — numbers that look like measurements and are
 * not, which is the exact failure this whole tool family exists to remove.
 */
import { AGENT_CAPTURE_INSPECT_GLOBAL, inspectFrameDocumentJson } from '@core/studio-capture'

interface InspectWindow {
  [AGENT_CAPTURE_INSPECT_GLOBAL]?: (requestJson: string) => string
}

const settledDocuments = new Map<string, Document>()

/** Called by each frame once its settle loop has succeeded — never before. */
export function registerSettledFrameDocument(pageId: string, doc: Document): void {
  settledDocuments.set(pageId, doc)
}

/**
 * Installs the driver-facing global. Called once at module load, next to
 * `markCaptureLoading()`, so a driver that evaluates it always finds a function
 * rather than `undefined` — even for a page that failed before mounting a
 * single frame, where the honest answer is a validated `{ ok: false }`.
 */
export function installFrameInspector(): void {
  ;(window as unknown as InspectWindow)[AGENT_CAPTURE_INSPECT_GLOBAL] = (requestJson: string) =>
    inspectFrameDocumentJson((pageId) => {
      const doc = settledDocuments.get(pageId)
      const view = doc?.defaultView
      return doc && view ? { doc, view } : null
    }, requestJson)
}
