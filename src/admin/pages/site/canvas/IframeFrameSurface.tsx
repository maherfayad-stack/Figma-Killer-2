/**
 * IframeFrameSurface — renders one breakpoint frame inside its own iframe so
 * the canvas DOM matches the published page's DOM exactly.
 *
 * Why an iframe per frame?
 * ────────────────────────
 * The editor used to render each breakpoint frame as a `<div className=
 * "viewport">` directly inside the editor's document. That gave us "free"
 * event handling and shared CSS, but it created two structural mismatches
 * between canvas and published HTML:
 *
 *   1. `<body>` was the editor's body, so user CSS like
 *      `body { background: black; }` painted the editor chrome.
 *   2. Every authored element was wrapped in a `<div class="nodeWrapper">`
 *      for editor plumbing. CSS combinators (`>`, `+`, `~`, `:nth-child()`)
 *      couldn't traverse the wrappers, so authored direct-child / sibling
 *      relationships didn't match in the canvas.
 *
 * The iframe gives the page tree its own document, with its own real
 * `<body>` — user CSS works exactly as it does on the published site. No
 * scoping, no rewriting, no impedance mismatch. Each module also spreads
 * `nodeWrapperProps` (data-node-id, click/hover/keyboard handlers, …)
 * directly onto its own root tag, so there are no `display: contents`
 * NodeWrapper divs sitting between authored elements either — CSS
 * combinators (`>`, `+`, `~`, `:nth-child()`) match the same authored DOM
 * the publisher emits.
 *
 * How it works
 * ────────────
 *  - The iframe boots with an empty HTML skeleton via `srcDoc`.
 *  - On the iframe's `load` event we capture `contentDocument` into state.
 *  - The children passed to this component are mounted into the iframe's
 *    `<body>` via `createPortal`. React synthetic events bubble through
 *    the React tree (not the DOM tree), so click/hover/keyboard handlers
 *    attached in NodeRenderer still fire — the React fiber sees these as
 *    same-tree events.
 *  - `AuthoredCssInjector`, `ClassStyleInjector` and `UserStylesheetInjector`
 *    mount with `targetDocument={iframeDoc}` so raw/registry/user CSS lands in the iframe's `<head>`.
 *  - `data-breakpoint-id` is set on the iframe's `<body>` so the
 *    per-breakpoint class CSS (which uses `[data-breakpoint-id="..."]
 *    .myClass` selectors) matches inside the iframe.
 *
 * A mount is THREE commits, not one (S1)
 * ──────────────────────────────────────
 * Measured on an 18-frame board (`perf/cheap-frame-mount-iframe-pool`): a
 * zoom-out that mounts 14 frames at once produced a single 354 ms frame,
 * because everything below happened in ONE React commit — 14 iframes, 14
 * injector chains (each of which PARSES the whole vendor/authored/class/user
 * stylesheet set into a brand-new document), and 14 `NodeRenderer` trees.
 *
 * So the mount is deliberately staged:
 *   1. the `<iframe srcDoc>` element alone (this component's own return),
 *   2. the injector chain, once `load`/`contentDocument` gives us a document,
 *   3. the node tree + runtime scripts, in a `startTransition` scheduled from
 *      the effect that runs right after (2) commits — once it is this frame's
 *      turn in `frameTreeMountQueue.ts`: ONE frame's tree at a time, closest
 *      to the viewport centre first, so each frame commits and paints on its
 *      own instead of every frame of a board landing in one commit.
 *
 * Stage 3 is a `startTransition`, NOT an `rAF`/`setTimeout`/`requestIdleCallback`
 * chain. That distinction is the whole reason this is safe to ship: the
 * staging chain a predecessor removed could strand a frame as a skeleton
 * forever in a backgrounded tab or a headless runner, because `rAF` never
 * fires there. A transition is ordinary React work — it always runs, it is
 * merely allowed to yield to a higher-priority update (the zoom gesture)
 * first. Stage 3's commit is published two ways from ONE state
 * (`treeMounted`): `onContentReadyChange` so a board frame can keep its frozen
 * poster up until there is real content underneath it, and
 * `data-studio-canvas-content-ready` on the iframe element for DOM-only
 * callers — the agent's capture path (`renderEvidence.ts`) will not hand a
 * loaded-but-empty frame to a screenshot.
 *
 * `interaction === 'capture'` does NOT stage. See the effect for why.
 *
 * What's NOT in this component (yet):
 *  - Per-iframe `getComputedStyle` for code outside the iframe that measures
 *    elements (selection overlay handles its own iframe-rect translation).
 *
 * Cross-iframe event forwarding
 * ─────────────────────────────
 * Wheel, pointer and keyboard events that fire inside the iframe belong to
 * the editor's parent-document layers (canvas pan/zoom, the cross-frame drag
 * relay, the global shortcut listeners). Replaying them across the boundary
 * lives whole in `useIframeEventForwarding.ts` — read its doc comment for the
 * three relays and why they share one module.
 */

import {
  forwardRef,
  startTransition,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { ClassStyleInjector } from './ClassStyleInjector'
import { UserStylesheetInjector } from './UserStylesheetInjector'
import { ProjectCssInjector } from './ProjectCssInjector'
import { AuthoredCssInjector } from './AuthoredCssInjector'
import { CanvasAnimationInjector } from './CanvasAnimationInjector'
import { CanvasHoverSuppressionInjector } from './CanvasHoverSuppressionInjector'
import { CanvasDiagnosticsInjector } from './CanvasDiagnosticsInjector'
import { CanvasScrollUnrollInjector } from './CanvasScrollUnrollInjector'
import { CanvasSelectionOverlayInjector } from './CanvasSelectionOverlayInjector'
import { EditorChromeInjector } from './EditorChromeInjector'
import { RuntimeScriptInjector } from './RuntimeScriptInjector'
import { useIframeCursorBridge } from './useIframeCursorBridge'
import { useIframeEventForwarding } from './useIframeEventForwarding'
import { useCanvasFormControlSuppression } from './useCanvasFormControlSuppression'
import { CANVAS_VIEWPORT_HEIGHT, type CanvasViewport } from './resolveViewportUnits'
import { useIframeFrameAutoHeight } from './useIframeFrameAutoHeight'
import { applyIframeBodyReset } from './iframeBodyReset'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { closestReadonlyRegion, isElementLike } from './readonlyRegion'
import styles from './IframeFrameSurface.module.css'
import { IFRAME_SRC_DOC, claimIframeSrcDocument } from './iframeSrcDocument'
import { CanvasFrameContexts } from './CanvasFrameContexts'
import { useApplyPreviewAxes } from './previewAxesFrameEffect'
import { PortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter, isBridgeFrameAdapter, type BridgeFrameChannel } from './frameAdapter/BridgeFrameAdapter'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import { registerFrameAdapter, unregisterFrameAdapter } from './frameAdapter/canvasFrameAdapterRegistry'
import { resolveLiveFrameSrc } from './resolveLiveFrameSrc'
import { requestFrameTreeMount, type FrameTreeMountTicket } from './frameTreeMountQueue'

/** Stable empty list so a script-less frame doesn't churn the injector's deps. */
const EMPTY_RUNTIME_SCRIPTS: InjectableRuntimeScript[] = []

/**
 * Elements whose default click/activation navigates the frame. Anchors and
 * image-maps cover link navigation; form submission is cancelled separately
 * via a `submit` listener, so a default-typed submit button inside a form is
 * covered there even though it isn't matched here.
 */
const NAVIGABLE_SELECTOR = 'a[href], area[href], button[type="submit"], input[type="submit"], input[type="image"]'

// The contract this component implements — see
// `iframeFrameSurfaceContract.ts`. Re-exported because every consumer
// already imports the handle from this module.
export type { IframeFrameSurfaceHandle } from './iframeFrameSurfaceContract'
import type { IframeFrameSurfaceHandle, IframeFrameSurfaceProps } from './iframeFrameSurfaceContract'

type IframeWithCleanup = HTMLIFrameElement & { _studioCleanup?: () => void }

export const IframeFrameSurface = forwardRef<IframeFrameSurfaceHandle, IframeFrameSurfaceProps>(
  function IframeFrameSurface(
    {
      breakpointId,
      width,
      className,
      style,
      onClick,
      onCursorMove,
      onCursorLeave,
      children,
      dataAttrs,
      interaction = 'canvas',
      runtimeScripts,
      onReadonlyOpen,
      axesOverride,
      documentMode = 'portal',
      liveFrame,
      onContentReadyChange,
      sizing = 'content',
    },
    ref,
    ) {
      const isLive = interaction === 'live'
      // A capture frame is a design frame in every presentation respect —
      // it differs only in carrying no interactive editor chrome. See
      // {@link IframeInteraction}.
      const isCapture = interaction === 'capture'
      const iframeRef = useRef<HTMLIFrameElement | null>(null)
      const [iframeDoc, setIframeDoc] = useState<Document | null>(null)
      const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null)
      const [adapter, setAdapter] = useState<FrameDocumentAdapter | null>(null)
      // Mount stage 3 — see this module's header. `false` until the injector
      // commit has landed and the transition scheduled below has run.
      const [treeMounted, setTreeMounted] = useState(false)
      // This frame's place in `frameTreeMountQueue.ts`, and the committed
      // value of `treeMounted` as the effects last saw it.
      const mountTicketRef = useRef<FrameTreeMountTicket | null>(null)
      const treeMountedRef = useRef(false)

    // `live-07` (STATE.md) — keeps the freshest `liveFrame` reachable from
    // inside the construct effect below WITHOUT it being a dependency of
    // that effect. `liveFrame` is a new object on every render where
    // `nodeIdsInTreeOrder` changed (every structural resync re-parses and
    // re-mints the active page's node id list), and the construct effect
    // below must NOT re-run for that — only for a genuinely different
    // frame/document. Assigning during render (not inside an effect) is the
    // standard "always-current ref" pattern: it costs nothing and never
    // triggers a re-render on its own.
    const liveFrameRef = useRef(liveFrame)
    liveFrameRef.current = liveFrame

    // `live-05` (STATE.md) — every canvas frame publishes a `FrameDocumentAdapter`,
    // constructed/disposed with its own lifecycle. `documentMode==='bridge'`
    // constructs a `BridgeFrameAdapter` wrapping a real cross-origin
    // `postMessage` channel against the iframe's own `contentWindow` instead
    // of a `PortalFrameAdapter` wrapping `contentDocument` — the two are
    // mutually exclusive by construction (a cross-origin frame has no
    // readable `contentDocument` to wrap, a portal frame needs no message
    // channel). `expectedSource` mirrors `runtime.ts`'s own defense-in-depth
    // check from the other side (STATE.md's `sec-06`) — inbound messages are
    // additionally verified to come from THIS iframe's own window, not just
    // the right origin.
    //
    // `live-07` — deliberately keyed on `liveOrigin`/`screenKey`, NOT the
    // whole `liveFrame` object: those two are the only things that actually
    // mean "this is a different frame/document" (`resolveLiveFrameSrc`
    // depends on nothing else). A re-parse that only changes
    // `nodeIdsInTreeOrder` must NOT dispose/reconstruct the adapter — that
    // drops every pending `measure()` promise, event subscription, and the
    // adapter's own identity for no reason. See the id-only effect below,
    // which is what actually reconciles the id list in place.
    useEffect(() => {
      if (documentMode === 'bridge') {
        const iframe = iframeRef.current
        const frameWindow = iframe?.contentWindow
        const frame = liveFrameRef.current
        if (!iframe || !frameWindow || !frame) {
          setAdapter(null)
          return
        }
        const frameOrigin = new URL(resolveLiveFrameSrc(frame)).origin
        const channel: BridgeFrameChannel = {
          postMessage: (message, targetOrigin) => frameWindow.postMessage(message, targetOrigin),
          addEventListener: (type, handler) => window.addEventListener(type, handler),
          removeEventListener: (type, handler) => window.removeEventListener(type, handler),
        }
        const next = new BridgeFrameAdapter({
          channel,
          frameOrigin,
          expectedSource: frameWindow,
          nodeIdsInTreeOrder: frame.nodeIdsInTreeOrder,
        })
        // `live-12` — the runtime gates hover suppression, scroll unroll,
        // animation freeze, and now pointer ownership and wheel forwarding
        // on the mode the PARENT declares, and nothing declared one: every
        // bridge frame ran as if it were a visitor's page. Queued by the
        // adapter until the frame says `ready`, so ordering is not a concern.
        next.setInteractionMode(isLive ? 'live' : 'design')
        setAdapter(next)
        // `live-05` (STATE.md, architect's Batch 4 resolution) — every
        // constructed adapter registers itself under its own iframe element
        // so a Class B (cross-frame) caller can enumerate every mounted
        // canvas frame without ever reaching for `document.querySelectorAll
        // ('iframe')` + `contentDocument`. Same lifecycle both branches.
        registerFrameAdapter(iframe, next, breakpointId)
        return () => {
          unregisterFrameAdapter(iframe)
          next.dispose()
        }
      }
      const iframe = iframeRef.current
      if (!iframeDoc || !iframe) {
        setAdapter(null)
        return
      }
      const next = new PortalFrameAdapter(iframeDoc)
      setAdapter(next)
      registerFrameAdapter(iframe, next, breakpointId)
      return () => {
        unregisterFrameAdapter(iframe)
        next.dispose()
      }
    }, [isLive, documentMode, iframeDoc, liveFrame?.liveOrigin, liveFrame?.screenKey, breakpointId])

    // `live-07` — the other half of the split above: reconciles the
    // canonical<->stamp index IN PLACE via `setNodeIds` (already shipped by
    // L5, never previously called) whenever only the active page's node id
    // set changes, instead of tearing the whole adapter down. No-ops for a
    // portal adapter (no such index exists) and while no bridge adapter is
    // mounted yet.
    useEffect(() => {
      if (!isBridgeFrameAdapter(adapter) || !liveFrame?.nodeIdsInTreeOrder) return
      adapter.setNodeIds(liveFrame.nodeIdsInTreeOrder)
    }, [adapter, liveFrame?.nodeIdsInTreeOrder])

    useIframeCursorBridge(iframeRef, adapter, { onCursorMove, onCursorLeave })
    useCanvasFormControlSuppression(adapter, { breakpointId, enabled: !isLive })
    useIframeFrameAutoHeight({ iframeRef, iframeDoc, adapter, fitToContent: !isLive && sizing === 'content' })
    // WS-10 — direction/color-scheme, an attribute effect (never `srcDoc`/a
    // `key` — see `previewAxesFrameEffect.ts`). `axesOverride` (Phase 2) is a
    // per-frame override merged onto the board-global axes inside the hook.
    const frameAxes = useApplyPreviewAxes(adapter, axesOverride)

    // Mount stage 3 (see this module's header): schedule the node tree as a
    // TRANSITION from the effect that runs after the injector commit, so the
    // two land in separate commits and a zoom gesture can interleave between
    // them. Unmounting the document resets the gate so a re-entering frame
    // stages again rather than re-mounting everything at once.
    //
    // A CAPTURE frame is the one exception, and it is not a hedge: staging
    // exists to keep a gesture smooth while MANY board frames mount at once.
    // A capture frame is exactly one frame, offscreen, `inert`, mounted on
    // demand by `AgentSnapshotFrame`, with an agent tool call already blocked
    // on its tree — there is no gesture to yield to, and yielding hands React
    // licence to leave that one commit behind whatever higher-priority work
    // the editor is doing (an agent turn streams store updates continuously).
    // Measured: the transient frame's body held 0 children for the WHOLE 5 s
    // `waitForAgentRenderFrame` window, so the capture timed out with
    // "did not become ready" — `agentBreakpointCapture.test.tsx` is the gate.
    //
    // The transition waits for this frame's turn in `frameTreeMountQueue.ts`:
    // one frame's tree at a time, closest to the viewport centre first. Every
    // frame starting its own transition in one burst put them all in ONE
    // render and ONE commit (React renders pending transition lanes together),
    // so the first frame of a board could not paint before the last.
    useEffect(() => {
      if (!iframeDoc) {
        setTreeMounted(false)
        return
      }
      if (isCapture) {
        setTreeMounted(true)
        return
      }
      // Already mounted (the document was re-attached without going through
      // `null`): a grant would be a no-op update, so the release effect below
      // would never run and the queue would stall behind this frame.
      if (treeMountedRef.current) return
      const ticket = requestFrameTreeMount(
        () => iframeRef.current,
        () => startTransition(() => setTreeMounted(true)),
      )
      mountTicketRef.current = ticket
      return () => {
        ticket.release()
        if (mountTicketRef.current === ticket) mountTicketRef.current = null
      }
    }, [iframeDoc, isCapture])

    // This frame's tree has committed: hand the grant to the next frame. A
    // passive effect, so the next tree starts rendering after this commit.
    useEffect(() => {
      treeMountedRef.current = treeMounted
      if (treeMounted) mountTicketRef.current?.release()
    }, [treeMounted])

    // Publish stage 3. ONE readiness notion, two transports:
    //  - `onContentReadyChange` for the board frame, which keeps its frozen
    //    poster on top of the iframe until there is real content underneath;
    //  - `data-studio-canvas-content-ready` on the iframe element for callers
    //    that only hold DOM — `renderEvidence.ts` refuses to hand the agent a
    //    frame whose document has loaded but whose node tree has not landed,
    //    which is otherwise a rasterised blank PNG (`studio_export_frames`).
    //
    // This effect is the attribute's SOLE owner. `attachIframeDoc` below runs
    // again whenever the ref re-attaches and clears `studioCanvasDocumentLoaded`
    // there — but it re-sets that one synchronously in `captureSrcDoc`, which
    // has no equivalent here, so clearing the readiness stamp from the ref
    // callback would strip it for good (measured: `contentReady=undefined` on a
    // frame whose body already held its tree).
    useEffect(() => {
      const iframe = iframeRef.current
      if (iframe) {
        if (treeMounted) iframe.dataset.studioCanvasContentReady = 'true'
        else delete iframe.dataset.studioCanvasContentReady
      }
      onContentReadyChange?.(treeMounted)
      return () => {
        if (iframe) delete iframe.dataset.studioCanvasContentReady
        onContentReadyChange?.(false)
      }
    }, [onContentReadyChange, treeMounted])

    // Bridge the iframe handle out to the parent (selection overlay reads
    // `iframeElement` to translate inside-iframe rects into editor coordinates).
    useImperativeHandle(
      ref,
      () => ({
        iframeElement: iframeRef.current,
        contentDocument: iframeDoc,
        contentBody: (iframeDoc?.body ?? null) as HTMLBodyElement | null,
        contentOverlayRoot: overlayRoot,
        adapter,
      }),
      [iframeDoc, overlayRoot, adapter],
    )

    // Wire up the iframe document once it's ready. Capture both onLoad and
    // the synchronous `contentDocument` path: `srcDoc` parses immediately so
    // contentDocument is often already populated by the time React commits
    // the iframe element; we still listen for `load` as a fallback in case
    // the browser deferred parsing.
    const attachIframeDoc = (iframe: HTMLIFrameElement | null) => {
      const previousIframe = iframeRef.current as IframeWithCleanup | null
      if (previousIframe && previousIframe !== iframe) {
        previousIframe._studioCleanup?.()
        previousIframe._studioCleanup = undefined
      }
      iframeRef.current = iframe
      if (!iframe) {
        setIframeDoc(null)
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
        setIframeDoc(doc)
        iframe.dataset.studioCanvasDocumentLoaded = 'true'
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
    }

    // Tag the iframe body with `data-breakpoint-id` (matches the existing
    // canvasClassCss selector `[data-breakpoint-id="..."] .myClass`) and
    // wire the empty-frame click handler. Re-runs when the document or
    // handler change.
    //
    // We also break the `:where(html, body) { height: 100% }` reset rule
    // for the canvas iframe context. The published page wants body filling
    // the viewport (so footer stickies to bottom on short pages); the
    // canvas iframe is a Figma-like frame that should be content-sized, with
    // a fixed canvas viewport floor on the body. Letting body inherit 100%
    // creates a feedback loop where the iframe sizes to body which sizes to
    // iframe and the frame never shrinks. Both `html` and `body` styles win
    // against `:where()` (zero-specificity) so the override is safe.
    useEffect(() => {
      if (!iframeDoc?.body) return
      applyIframeBodyReset(iframeDoc, breakpointId, interaction)
      if (!onClick) return
      // Empty-frame click: ONLY fire when the click target is the body
      // itself (not a child node bubbling up). Without this guard, every
      // single click anywhere in the iframe — including clicks that the
      // canvas already routed through NodeRenderer's stopPropagation
      // logic — would re-trigger `onActivate`. React's `stopPropagation()`
      // from the child's onClick reaches React's delegated listener but
      // doesn't stop this native bubble-phase listener (they were
      // attached in different code paths, in different orders).
      const handler = (e: MouseEvent) => {
        if (e.target !== iframeDoc.body) return
        onClick()
      }
      iframeDoc.body.addEventListener('click', handler)
      return () => {
        iframeDoc.body.removeEventListener('click', handler)
      }
    }, [iframeDoc, breakpointId, onClick, interaction])

    // ── Navigation guard ─────────────────────────────────────────────────
    // The canvas iframe is an EDITING surface, never a browsing surface.
    // Authored content, read-only template chrome, and inlined Visual
    // Components all render real `<a href>` / `<form>` elements; clicking one
    // would navigate the frame and load the whole site inside the editor. A
    // capture-phase `preventDefault` cancels every default navigation
    // regardless of which subtree the element lives in, while deliberately NOT
    // calling `stopPropagation` so React's synthetic click handlers still run
    // and node selection keeps working. Applies in both interaction modes —
    // neither the design canvas nor the live/preview frame is a real
    // navigation target.
    useEffect(() => {
      if (!iframeDoc) return
      const blockNavigation = (event: Event) => {
        const target = event.target
        if (!isElementLike(target)) return
        if (!target.closest(NAVIGABLE_SELECTOR)) return
        event.preventDefault()
      }
      const blockSubmit = (event: Event) => {
        event.preventDefault()
      }
      iframeDoc.addEventListener('click', blockNavigation, true)
      iframeDoc.addEventListener('auxclick', blockNavigation, true)
      iframeDoc.addEventListener('submit', blockSubmit, true)
      return () => {
        iframeDoc.removeEventListener('click', blockNavigation, true)
        iframeDoc.removeEventListener('auxclick', blockNavigation, true)
        iframeDoc.removeEventListener('submit', blockSubmit, true)
      }
    }, [iframeDoc])

    // ── Read-only region open ────────────────────────────────────────────
    // Double-clicking read-only composed content (template chrome, an inlined
    // component, an outlet preview) opens its source document for editing.
    // `closestReadonlyRegion` resolves the NEAREST boundary, so the active
    // document's own editable nodes — spliced inside the template wrapper — keep
    // their own double-click (enter / inline-edit) instead of opening the
    // wrapping template.
    useEffect(() => {
      if (!iframeDoc || !onReadonlyOpen) return
      const handleDblClick = (event: MouseEvent) => {
        const region = closestReadonlyRegion(event.target)
        if (!region) return
        const id = region.getAttribute('data-studio-readonly-id')
        const kind = region.getAttribute('data-studio-readonly-kind')
        if (!id || (kind !== 'page' && kind !== 'component')) return
        event.preventDefault()
        event.stopPropagation()
        onReadonlyOpen(kind, id)
      }
      iframeDoc.addEventListener('dblclick', handleDblClick, true)
      return () => {
        iframeDoc.removeEventListener('dblclick', handleDblClick, true)
      }
    }, [iframeDoc, onReadonlyOpen])

    // Events that fire INSIDE the iframe but belong to the editor's parent-doc
    // layers — wheel → canvas pan/zoom, pointer → pan + cross-frame canvas drag,
    // keyboard → the global shortcut listeners. Called HERE so its effects keep
    // their original position in this component's effect order.
    useIframeEventForwarding(iframeRef, adapter, isLive)

    const dataAttrSpread = dataAttrs
      ? Object.fromEntries(
          Object.entries(dataAttrs).filter(([, v]) => v !== undefined),
        )
      : {}

    // Frame viewport for canvas viewport-unit resolution. Width is the
    // breakpoint width (the iframe's real width); height is a fixed
    // device-like value. Pinning `vh`/`vmax`/… to this stops authored
    // viewport units from feeding the grow-to-content height loop above.
    const viewport: CanvasViewport = { width, height: CANVAS_VIEWPORT_HEIGHT }

    // Bridge mode's iframe points at a REAL `src=` URL (the project's own
    // live dev server, proxied — see `resolveLiveFrameSrc.ts`), never
    // `srcDoc`, and portals nothing into it: the page inside is the
    // project's own real, separately-bundled React app, not a tree this
    // process renders. Every editor-chrome injector below (selection rings,
    // CSS-text injectors, `children` itself) is portal-mode-only by
    // construction — a bridge frame's own in-frame runtime (`runtime.ts`,
    // already built) owns the equivalent behavior on its side of the
    // `postMessage` boundary instead.
    if (documentMode === 'bridge') {
      return (
        <iframe
          ref={iframeRef}
          src={liveFrame ? resolveLiveFrameSrc(liveFrame) : undefined}
          className={cn(styles.iframe, isLive && styles.iframeLive, className)}
          style={isLive ? { ...style, width: '100%', height: '100%' } : { ...style, width: `${width}px` }}
          title={`Canvas frame for ${breakpointId}`}
          data-preview-scheme={frameAxes.colorScheme}
          // Stamped on the outer element itself (not just the framed
          // document, which is unreachable cross-origin here) so any caller
          // holding this HTMLIFrameElement — including
          // `preferredRenderedCanvasNode` (P5, STATE.md `panel-26`) — can
          // read which breakpoint it represents without touching
          // `contentDocument`. See IframeFrameSurface's own doc comment.
          data-breakpoint-id={breakpointId}
          {...dataAttrSpread}
        />
      )
    }

    return (
      <>
        <iframe
          ref={attachIframeDoc}
          // `srcDoc` is what creates the iframe document; an empty
          // `<html><body>` so we can portal React content into the body.
          srcDoc={IFRAME_SRC_DOC}
          className={cn(styles.iframe, isLive && styles.iframeLive, className)}
          // Canvas frames are sized to the breakpoint width and grow to content
          // height. Live frames fill the surface-controlled wrapper and scroll
          // internally, so they take 100% in both axes.
          style={isLive ? { ...style, width: '100%', height: '100%' } : { ...style, width: `${width}px` }}
          title={`Canvas frame for ${breakpointId}`}
          // Paper follows the PREVIEWED scheme — see `--canvas-frame-paper`.
          data-preview-scheme={frameAxes.colorScheme}
          // Same additive stamp as the bridge branch above — this portal
          // branch already tags the srcDoc BODY with data-breakpoint-id
          // (`applyIframeBodyReset`); this is the outer iframe element's own
          // copy, so a cross-mode caller doesn't need to know which mode it's
          // looking at to read it.
          data-breakpoint-id={breakpointId}
          {...dataAttrSpread}
          // Allow the same-origin policy so the parent can read/write the
          // iframe's document. `allow-scripts` so authored script modules
          // (and React itself, via portal) can run.
        />
        {iframeDoc &&
          createPortal(
            <CanvasFrameContexts
              frameElement={iframeRef.current}
              adapter={adapter}
              axes={frameAxes}
              interaction={interaction}
            >
              {/* Editor-chrome stylesheet — UNLAYERED so it beats every other bucket */}
              <EditorChromeInjector />
              {/* Runtime diagnostics: window errors, unhandled rejections,
                  console.error, failed assets/modules and failed fetches from
                  THIS frame, buffered for studio_page_diagnostics. Mounted
                  first so a failure during the rest of this subtree's own mount
                  is still collected. Inserts no DOM — see its docblock. */}
              <CanvasDiagnosticsInjector />
              {/* Design frames only: selection/hover rings + the node-name badge
                  render INSIDE this document (WS-5.1) so they track the element
                  with zero zoom/pan conversion. See its own docblock.

                  Gated on `treeMounted` with the node tree, and NOT because it
                  is expensive — because it is the one injector that appends a
                  real element to `<body>`. Its effect runs after the commit's
                  DOM writes, so in a single-commit mount the authored content
                  was already there and the overlay root landed behind it. Mount
                  it in stage 2 and it becomes `body`'s FIRST child, which
                  breaks `body > :first-child` / `:nth-child` / `:empty` for the
                  page's own CSS — the exact invariant
                  `bodyPresentation.test.tsx` guards. */}
              {!isLive && !isCapture && treeMounted && (
                <CanvasSelectionOverlayInjector onRootReady={setOverlayRoot} />
              )}
              {/* Vendor package CSS (Alm design-system + the open project's own
                  bare-specifier package CSS) — read-only, @layer vendor,
                  ordered below @layer user-authored. See canvasCssLayers.ts. */}
              <ProjectCssInjector />
              {/* Design frames only: animations play once and hold their last
                  keyframe, so an imported app's infinite shimmers/spinners
                  don't run forever behind the selection ring. Live mode is a
                  visitor preview, so it keeps the real motion. */}
              {!isLive && <CanvasAnimationInjector />}
              {/* Design frames only: internal scroll regions (a flex:1
                  overflow:auto app shell) become content-sized so the whole
                  screen is visible instead of a scrollable box. Live mode
                  scrolls natively and keeps the app's own clipping. */}
              {!isLive && <CanvasScrollUnrollInjector />}
              {/* Design frames only: the page's own `:hover` rules are rewritten
                  so they cannot match. Moving the pointer across a board to
                  reach a node should not repaint every button and card it
                  crosses — and a hover state that changes LAYOUT moves the box
                  the selection ring and the resize handles are measuring. Live
                  mode is a visitor preview, so it keeps real hover, exactly as
                  it keeps real motion above. Mounted AFTER the CSS injectors it
                  rewrites so its first pass has sheets to walk. */}
              {!isLive && <CanvasHoverSuppressionInjector />}
              {/* Author CSS — @layer user-authored. Cascade priority within
                  that layer is DOM source order, which for adapter-managed
                  overlays is now first-`applyOverlay`-call order — i.e. this
                  JSX order. AuthoredCssInjector (raw, on-disk) must keep
                  mounting/rendering before ClassStyleInjector (session
                  edits) so an edited class still wins for the same selector
                  — see AuthoredCssInjector.tsx's "Raw vs. overlay" doc. Do
                  not reorder these three. */}
              <AuthoredCssInjector viewport={viewport} />
              <ClassStyleInjector viewport={viewport} />
              <UserStylesheetInjector viewport={viewport} />
              {/* Mount stage 3 — the node tree, one commit later than the
                  injectors above. See this module's header. */}
              {treeMounted && children}
              {/* Runtime scripts (opt-in) run against the node tree mounted
                  above, so they are gated on the same stage. Empty list =
                  no-op, so this is safe to always mount. */}
              {treeMounted && (
                <RuntimeScriptInjector scripts={runtimeScripts ?? EMPTY_RUNTIME_SCRIPTS} />
              )}
            </CanvasFrameContexts>,
            iframeDoc.body,
          )}
      </>
    )
  },
)
