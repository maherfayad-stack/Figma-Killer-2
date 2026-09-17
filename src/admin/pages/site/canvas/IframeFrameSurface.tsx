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
 *      the effect that runs right after (2) commits.
 *
 * Stage 3 is a `startTransition`, NOT an `rAF`/`setTimeout`/`requestIdleCallback`
 * chain. That distinction is the whole reason this is safe to ship: the
 * staging chain a predecessor removed could strand a frame as a skeleton
 * forever in a backgrounded tab or a headless runner, because `rAF` never
 * fires there. A transition is ordinary React work — it always runs, it is
 * merely allowed to yield to a higher-priority update (the zoom gesture)
 * first. `onContentReadyChange` reports stage 3's commit so a board frame can
 * keep its frozen poster up until there is real content underneath it.
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
  type CSSProperties,
  type ReactNode,
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
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { useIframeCursorBridge } from './useIframeCursorBridge'
import { useIframeEventForwarding } from './useIframeEventForwarding'
import { useCanvasFormControlSuppression } from './useCanvasFormControlSuppression'
import { CANVAS_VIEWPORT_HEIGHT, type CanvasViewport } from './resolveViewportUnits'
import { useIframeFrameAutoHeight } from './useIframeFrameAutoHeight'
import { applyIframeBodyReset, type IframeInteraction } from './iframeBodyReset'
import { closestReadonlyRegion, isElementLike } from './readonlyRegion'
import styles from './IframeFrameSurface.module.css'
import { IFRAME_SRC_DOC, claimIframeSrcDocument } from './iframeSrcDocument'
import { CanvasFrameContexts } from './CanvasFrameContexts'
import { useApplyPreviewAxes } from './previewAxesFrameEffect'
import type { PreviewAxes } from '@core/studio-board'

/** Stable empty list so a script-less frame doesn't churn the injector's deps. */
const EMPTY_RUNTIME_SCRIPTS: InjectableRuntimeScript[] = []

/**
 * Elements whose default click/activation navigates the frame. Anchors and
 * image-maps cover link navigation; form submission is cancelled separately
 * via a `submit` listener, so a default-typed submit button inside a form is
 * covered there even though it isn't matched here.
 */
const NAVIGABLE_SELECTOR = 'a[href], area[href], button[type="submit"], input[type="submit"], input[type="image"]'

interface IframeFrameSurfaceProps {
  /** Stable id used to tag the iframe's `<body>` with `data-breakpoint-id`. */
  breakpointId: string
  /** Logical viewport width in px; drives the iframe's CSS width. */
  width: number
  className?: string
  style?: CSSProperties
  /**
   * Click handler delegated to the iframe's `<body>`. The original frame
   * had its onClick on the viewport `<div>`; we replicate that on the body
   * so clicking the empty area still activates the breakpoint.
   */
  onClick?: () => void
  /** Cursor movement inside the iframe, translated by callers as needed. */
  onCursorMove?: (event: MouseEvent) => void
  /** Cursor leave from the iframe element. */
  onCursorLeave?: () => void
  /** Page tree React subtree to mount inside the iframe's body. */
  children: ReactNode
  /**
   * `data-*` attributes forwarded onto the iframe element itself. The
   * outgoing `data-breakpoint-id` lives on the iframe's `<body>` (so it can
   * be a target of the canvas's `[data-breakpoint-id]`-scoped CSS), but
   * the editor sometimes wants identifiers on the iframe wrapper too —
   * e.g. testids that the agent-browser can target without crossing the
   * iframe boundary.
   */
  dataAttrs?: Record<string, string | undefined>
  /** Interaction model — see {@link IframeInteraction}. Defaults to 'canvas'. */
  interaction?: IframeInteraction
  /**
   * Double-click handler for read-only composed regions (template chrome,
   * inlined components, outlet previews). Resolved from the nearest ancestor
   * carrying `data-studio-readonly-*` markers; opens that source for editing.
   */
  onReadonlyOpen?: (kind: 'page' | 'component', id: string) => void
  /**
   * Bundled runtime scripts to execute inside the frame. Empty/undefined runs
   * nothing — the frame stays a pure render. Same in both interaction modes
   * (the "Run scripts" toggle drives this), so authored behaviour can run
   * alongside the live editor.
   */
  runtimeScripts?: InjectableRuntimeScript[]
  /** WS-10 Phase 2 — a "duplicate as variant" frame's `BoardFrame.axes`, merged onto the board-global axes in `useApplyPreviewAxes`. `undefined` outside board context. */
  axesOverride?: Partial<PreviewAxes>
  /**
   * S1 — called with `true` once the staged node tree (mount stage 3, see this
   * module's header) has committed into the iframe body, and with `false`
   * while there is nothing in it. `BoardFrameView` keeps its frozen poster on
   * top of the iframe until this turns true, so a frame entering the viewport
   * never flashes an empty document.
   *
   * Pass a `useState` SETTER, not a fresh closure: `BreakpointFrame` is
   * `memo()`'d (React Compiler exception #2) and a new identity here defeats
   * that bailout on every render. A setter's identity is stable for the life
   * of the component, guaranteed by React itself rather than by the compiler —
   * the same reasoning `BoardFrameView.tsx`'s `activatePageHandler` interning
   * is written out at length for.
   */
  onContentReadyChange?: (ready: boolean) => void
}

export interface IframeFrameSurfaceHandle {
  /** The iframe element itself. `null` until the iframe mounts. */
  iframeElement: HTMLIFrameElement | null
  /** The iframe's contentDocument. `null` until the iframe has loaded. */
  contentDocument: Document | null
  /** Convenience: the iframe's body. `null` until loaded. */
  contentBody: HTMLBodyElement | null
  /**
   * The in-iframe selection-overlay root (WS-5.1) — `null` in live and
   * capture modes (never mounted) and until `CanvasSelectionOverlayInjector`
   * creates it.
   * `BreakpointSelectionOverlay` portals rings/badge into this instead of the
   * parent canvas root, so they live in the same coordinate space as the
   * element they track.
   */
  contentOverlayRoot: HTMLDivElement | null
}

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
      onContentReadyChange,
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
      // Mount stage 3 — see this module's header. `false` until the injector
      // commit has landed and the transition scheduled below has run.
      const [treeMounted, setTreeMounted] = useState(false)

    useIframeCursorBridge(iframeRef, iframeDoc, { onCursorMove, onCursorLeave })
    useCanvasFormControlSuppression(iframeDoc, { breakpointId, enabled: !isLive })
    useIframeFrameAutoHeight({ iframeRef, iframeDoc, isLive })
    // WS-10 — direction/color-scheme, an attribute effect (never `srcDoc`/a
    // `key` — see `previewAxesFrameEffect.ts`). `axesOverride` (Phase 2) is a
    // per-frame override merged onto the board-global axes inside the hook.
    const frameAxes = useApplyPreviewAxes(iframeDoc, axesOverride)

    // Mount stage 3 (see this module's header): schedule the node tree as a
    // TRANSITION from the effect that runs after the injector commit, so the
    // two land in separate commits and a zoom gesture can interleave between
    // them. Unmounting the document resets the gate so a re-entering frame
    // stages again rather than re-mounting everything at once.
    useEffect(() => {
      if (!iframeDoc) {
        setTreeMounted(false)
        return
      }
      startTransition(() => setTreeMounted(true))
    }, [iframeDoc])

    // Report stage 3 to the board frame, which keeps its frozen poster on top
    // of the iframe until there is real content underneath.
    useEffect(() => {
      if (!onContentReadyChange) return
      onContentReadyChange(treeMounted)
      return () => onContentReadyChange(false)
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
      }),
      [iframeDoc, overlayRoot],
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
    useIframeEventForwarding(iframeRef, iframeDoc, isLive)

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
          {...dataAttrSpread}
          // Allow the same-origin policy so the parent can read/write the
          // iframe's document. `allow-scripts` so authored script modules
          // (and React itself, via portal) can run.
        />
        {iframeDoc &&
          createPortal(
            <CanvasFrameContexts
              frameElement={iframeRef.current}
              frameDocument={iframeDoc}
              axes={frameAxes}
              interaction={interaction}
            >
              {/* Editor-chrome stylesheet — UNLAYERED so it beats every other bucket */}
              <EditorChromeInjector targetDocument={iframeDoc} parentDocument={document} />
              {/* Runtime diagnostics: window errors, unhandled rejections,
                  console.error, failed assets/modules and failed fetches from
                  THIS frame, buffered for studio_page_diagnostics. Mounted
                  first so a failure during the rest of this subtree's own mount
                  is still collected. Inserts no DOM — see its docblock. */}
              <CanvasDiagnosticsInjector targetDocument={iframeDoc} />
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
                <CanvasSelectionOverlayInjector
                  targetDocument={iframeDoc}
                  parentDocument={document}
                  onRootReady={setOverlayRoot}
                />
              )}
              {/* Vendor package CSS (Alm design-system + the open project's own
                  bare-specifier package CSS) — read-only, @layer vendor,
                  ordered below @layer user-authored. See canvasCssLayers.ts. */}
              <ProjectCssInjector targetDocument={iframeDoc} />
              {/* Design frames only: animations play once and hold their last
                  keyframe, so an imported app's infinite shimmers/spinners
                  don't run forever behind the selection ring. Live mode is a
                  visitor preview, so it keeps the real motion. */}
              {!isLive && <CanvasAnimationInjector targetDocument={iframeDoc} />}
              {/* Design frames only: internal scroll regions (a flex:1
                  overflow:auto app shell) become content-sized so the whole
                  screen is visible instead of a scrollable box. Live mode
                  scrolls natively and keeps the app's own clipping. */}
              {!isLive && <CanvasScrollUnrollInjector targetDocument={iframeDoc} />}
              {/* Design frames only: the page's own `:hover` rules are rewritten
                  so they cannot match. Moving the pointer across a board to
                  reach a node should not repaint every button and card it
                  crosses — and a hover state that changes LAYOUT moves the box
                  the selection ring and the resize handles are measuring. Live
                  mode is a visitor preview, so it keeps real hover, exactly as
                  it keeps real motion above. Mounted AFTER the CSS injectors it
                  rewrites so its first pass has sheets to walk. */}
              {!isLive && <CanvasHoverSuppressionInjector targetDocument={iframeDoc} />}
              {/* Author CSS — @layer user-authored (board-27's raw AuthoredCssInjector always precedes mc-classes; see its own doc) */}
              <AuthoredCssInjector targetDocument={iframeDoc} viewport={viewport} />
              <ClassStyleInjector targetDocument={iframeDoc} viewport={viewport} />
              <UserStylesheetInjector targetDocument={iframeDoc} viewport={viewport} />
              {/* Mount stage 3 — the node tree, one commit later than the
                  injectors above. See this module's header. */}
              {treeMounted && children}
              {/* Runtime scripts (opt-in) run against the node tree mounted
                  above, so they are gated on the same stage. Empty list =
                  no-op, so this is safe to always mount. */}
              {treeMounted && (
                <RuntimeScriptInjector targetDocument={iframeDoc} scripts={runtimeScripts ?? EMPTY_RUNTIME_SCRIPTS} />
              )}
            </CanvasFrameContexts>,
            iframeDoc.body,
          )}
      </>
    )
  },
)
