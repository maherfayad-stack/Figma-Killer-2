/**
 * The canvas iframe's bootstrap document, and the one-time claim that proves a
 * given `contentDocument` is ours.
 *
 * An iframe hands its `load` event to more than one document: the initial
 * `about:blank`, then the `srcDoc` we set. Both are same-origin and both look
 * alike, so the frame needs a way to tell "the document I asked for" from "the
 * placeholder the browser gave me first" — otherwise the editor injects
 * stylesheets and portals into a document that is about to be replaced.
 *
 * `IFRAME_SRC_DOC` carries a sentinel attribute for exactly that. The claim is
 * destructive on purpose: the attribute is removed the first time we recognise
 * the document, because the editor's `<html>` must end up structurally
 * identical to published output — no editor-only attributes survive into what
 * the user sees or what a snapshot captures. The identity then lives on an
 * off-DOM property, so a second call still answers yes.
 *
 * Split out of `IframeFrameSurface.tsx`, which is at its module-size cap: this
 * is a self-contained document-identity concern with no React in it.
 */

const IFRAME_DOCUMENT_SENTINEL = 'data-studio-canvas-document'
const IFRAME_DOCUMENT_FLAG = '__studioCanvasDocument'

type StudioIframeDocument = Document & { [IFRAME_DOCUMENT_FLAG]?: true }

/** The `srcDoc` every canvas iframe boots from — an empty document carrying {@link IFRAME_DOCUMENT_SENTINEL}. */
export const IFRAME_SRC_DOC = `<!doctype html><html ${IFRAME_DOCUMENT_SENTINEL}><head></head><body></body></html>`

/**
 * Whether `doc` is the frame's own bootstrap document. Idempotent: the first
 * call consumes the sentinel attribute and records the identity off-DOM, every
 * later call reads that record. `false` means this is still the initial
 * `about:blank` and nothing should be injected into it yet.
 */
export function claimIframeSrcDocument(doc: Document): boolean {
  const taggedDocument = doc as StudioIframeDocument
  if (taggedDocument[IFRAME_DOCUMENT_FLAG]) return true
  if (!doc.documentElement.hasAttribute(IFRAME_DOCUMENT_SENTINEL)) return false

  doc.documentElement.removeAttribute(IFRAME_DOCUMENT_SENTINEL)
  Object.defineProperty(taggedDocument, IFRAME_DOCUMENT_FLAG, {
    configurable: true,
    value: true,
  })
  return true
}
