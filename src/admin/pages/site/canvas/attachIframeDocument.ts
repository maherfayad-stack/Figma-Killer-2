/**
 * `attachIframeDocument` — the stable ref callback that turns a mounted
 * `<iframe srcDoc>` element into `IframeFrameSurface`'s `frameDocument` state.
 *
 * Split out of `IframeFrameSurface.tsx` (at its module-size cap) — this is a
 * self-contained "recognise the real document, not the initial about:blank"
 * concern with no JSX in it.
 *
 * Stable identity via a `useState` lazy initializer (not memoization — this
 * closure closes over nothing but the two stable setters/refs passed in, so
 * there is no staleness to guard against). This is load-bearing, not tidiness:
 * an inline ref callback gets a NEW function identity every render, and
 * React's callback-ref contract detaches the OLD one (calls it with `null`)
 * then attaches the NEW one (calls it with the node) on every such render —
 * even when the underlying iframe element hasn't changed at all. The detach
 * branch unconditionally nulls `frameDocument`; the immediately-following
 * attach's functional updater then sees that null as its `current` (React
 * reduces a batch's updates sequentially, not against the pre-batch state),
 * so its `current?.doc === doc` equality check can never match and it
 * constructs a BRAND NEW `{ iframe, doc }` object every time — a fresh
 * reference React can't `Object.is`-bail on, so the state "changes" every
 * render, which redefines this closure again, which churns the ref again: an
 * infinite render loop (measured: fails ~106 canvas tests with "Maximum
 * update depth exceeded" via `attachIframeDoc` → `safelyDetachRef`). A ref
 * callback with a stable identity is only invoked at real mount/unmount, so
 * the churn — and the loop — never starts.
 */
import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { claimIframeSrcDocument } from './iframeSrcDocument'

export interface FrameDocumentState {
  iframe: HTMLIFrameElement
  doc: Document
}

type IframeWithCleanup = HTMLIFrameElement & { _studioCleanup?: () => void }

/**
 * Runs and clears a departing iframe's stashed listener cleanup, if any.
 *
 * A plain module-scope function, not a hook — `useAttachIframeDocument`
 * passes its `iframeRef` argument straight through as `previousIframe` here,
 * and mutating a PROPERTY of a value derived from a hook argument, even
 * transitively, is flagged by `react-compiler/react-compiler` as if the
 * argument itself were mutated. Outside a hook/component body that rule does
 * not apply — this is an ordinary imperative DOM cleanup, not React state.
 */
function detachPreviousIframe(previousIframe: IframeWithCleanup | null, nextIframe: HTMLIFrameElement | null): void {
  if (!previousIframe || previousIframe === nextIframe) return
  previousIframe._studioCleanup?.()
  previousIframe._studioCleanup = undefined
}

/**
 * Writes `iframe` onto `ref.current`. Same rationale as
 * {@link detachPreviousIframe}: a plain function, not a hook, so assigning
 * through a `RefObject` received as an argument — the entire point of a ref
 * — isn't mistaken for mutating hook/component input.
 */
function assignIframeRef(ref: RefObject<HTMLIFrameElement | null>, iframe: HTMLIFrameElement | null): void {
  ref.current = iframe
}

/**
 * Builds the stable ref callback for `IframeFrameSurface`'s `srcDoc` iframe.
 *
 * Wire up the iframe document once it's ready. Capture both onLoad and the
 * synchronous `contentDocument` path: `srcDoc` parses immediately so
 * `contentDocument` is often already populated by the time React commits the
 * iframe element; we still listen for `load` as a fallback in case the
 * browser deferred parsing.
 */
export function useAttachIframeDocument(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  setFrameDocument: Dispatch<SetStateAction<FrameDocumentState | null>>,
): (iframe: HTMLIFrameElement | null) => void {
  const [attachIframeDoc] = useState(() => (iframe: HTMLIFrameElement | null) => {
    detachPreviousIframe(iframeRef.current as IframeWithCleanup | null, iframe)
    assignIframeRef(iframeRef, iframe)
    if (!iframe) {
      setFrameDocument(null)
      return
    }
    delete iframe.dataset.studioCanvasDocumentLoaded
    const captureSrcDoc = () => {
      const doc = iframe.contentDocument
      if (
        !doc ||
        doc.readyState === 'loading' ||
        !claimIframeSrcDocument(doc)
      ) return
      // Never portal the canvas tree into the short-lived initial about:blank
      // document. Module effects, media reads, and authored runtime scripts
      // must run once against the final srcDoc document only.
      // Marked before the element is handed to state (the React Compiler
      // treats a value in state as frozen); nothing renders in between.
      iframe.dataset.studioCanvasDocumentLoaded = 'true'
      setFrameDocument((current) => (current?.doc === doc && current.iframe === iframe ? current : { iframe, doc }))
    }
    // srcDoc often parses before the ref commits; otherwise its load event
    // retries. The bootstrap sentinel, not event timing or URL heuristics,
    // identifies the document we own; claimIframeSrcDocument removes it from
    // authored DOM before the portal mounts.
    captureSrcDoc()
    iframe.addEventListener('load', captureSrcDoc)
    // Stash the cleanup on the ref so React's ref-callback contract (the
    // function may be called again with null on unmount) doesn't leak
    // listeners.
    const cleanableIframe = iframe as IframeWithCleanup
    cleanableIframe._studioCleanup = () => {
      iframe.removeEventListener('load', captureSrcDoc)
      delete iframe.dataset.studioCanvasDocumentLoaded
      cleanableIframe._studioCleanup = undefined
    }
  })
  return attachIframeDoc
}
