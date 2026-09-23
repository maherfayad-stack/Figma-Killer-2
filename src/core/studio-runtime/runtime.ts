/**
 * runtime — the in-frame half of every design-canvas injector, ported to run
 * inside a cross-origin Tier 2 live frame (STUDIO-LIVE-CANVAS-PLAN.md § L4).
 * Driven entirely by `postMessage`, TypeBox-validated both ways (`messages.ts`).
 *
 * ## What is ported vs. what is new
 *
 * The four pure(-ish) behaviours — hover suppression, scroll unroll,
 * animation freeze, selection-ring CSS — are ONE implementation each,
 * imported from their own `studio-runtime` modules and shared verbatim with
 * the portal-mode injectors (`src/admin/pages/site/canvas/Canvas*Injector.tsx`).
 * This file adds exactly what a cross-origin frame needs that a same-origin
 * portal never did:
 *
 *   - the postMessage dispatch loop itself, with origin + envelope checks,
 *   - the generic overlay `<style>` manager (`applyOverlay`/`removeOverlay`),
 *   - selection/hover ring DOM creation AND positioning — a cross-origin
 *     frame shares no JS heap with the parent, so today's "portal a React
 *     tree into the iframe root" mechanism is structurally impossible here;
 *     the frame has to own both the DOM and the geometry math itself,
 *   - `setAxes`'s attribute writes (a small, deliberately independent copy —
 *     see "setAxes" below for why this does NOT import
 *     `previewAxesFrameEffect.ts`),
 *   - pointer/text-edit event capture and forwarding,
 *   - optimistic DOM mutation for insert/delete/move/text,
 *   - (Z5) the four runtime-error taps a portal frame gets from
 *     `CanvasDiagnosticsInjector.tsx` — installed by `runtimeErrorTaps.ts`,
 *     reported here as the outbound `error` message.
 *
 * ## Security posture (this file is reviewed for it explicitly)
 *
 *   - Every inbound `postMessage` is checked against `parentOrigin` AND
 *     against `event.source === parentWindow` before the payload is even
 *     inspected — an iframe can receive messages from any window that has a
 *     reference to it, not only its own parent.
 *   - The envelope's `source`/`direction` tags are checked before the
 *     TypeBox schema runs, so a same-shaped message from an unrelated
 *     `postMessage` sender (React DevTools, a browser extension) is dropped
 *     without ever reaching a handler.
 *   - `optimistic.insert`/`optimistic.text` never touch `innerHTML`, and
 *     refuse a dangerous tag name case-insensitively before
 *     `createElement` runs — see `optimisticDomOps.ts`, which owns all four
 *     mutations and is deliberately small enough to audit at a glance.
 *   - The outbound `error` channel (Z5) carries only bounded plain text, no
 *     HTML and no node id, capped and rate-limited at this honest sender
 *     (`runtimeErrorTaps.ts`). A same-realm forger can still post directly,
 *     which is why the parent validates the bounds rather than trusting it.
 */
import { Value } from '@sinclair/typebox/value'
import {
  InboundEnvelopeSchema,
  RUNTIME_MESSAGE_SOURCE,
  toOutboundEnvelope,
  type InboundRuntimeMessage,
  type NodeMeasurement,
  type OutboundRuntimeMessage,
  type RuntimeMode,
} from './messages'
import { installGestureForwarding } from './gestureForwarding'
import { installKeyForwarding } from './keyForwarding'
import { installInlineTextEdit } from './inlineTextEdit'
import { rectRelativeToBody } from './nodeDom'
import { installResizeHandles } from './resizeHandles'
import { measureNodes } from './measureNodes'
import { collectDropCandidates } from './dropCandidates'
import { startRuntimeErrorTaps } from './runtimeErrorTaps'
import {
  applyOptimisticDelete,
  applyOptimisticInsert,
  applyOptimisticMove,
  applyOptimisticText,
  revertOptimisticDom,
  sweepOptimisticGhosts,
} from './optimisticDomOps'
import { applyOptimisticStyle, clearOptimisticStyle, revertAllOptimisticStyle } from './optimisticStyle'
import { startHoverSuppression, type HoverSuppressionController } from './hoverSuppressionRules'
import { startScrollUnroll, type ScrollUnrollController } from './scrollUnrollRules'
import { startAnimationFreeze, type AnimationFreezeController } from './animationFreezeRules'
import { SELECTION_CHROME_RULES, SELECTION_OVERLAY_ROOT_ID, SELECTION_STYLE_TAG_ID } from './selectionChromeCss'
import { wireHmrStateAcrossUpdates, type ViteHotContext } from './hmrState'
import { findNthNodeById } from './nodeIdIndexing'
import { collectScrollDeficits, DEFAULT_FRAME_FIT_HEIGHT, resolveFrameFitHeight, type FrameFitMetrics } from './frameFitRules'
import {
  createFrameFitMutationScheduler,
  FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
  LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
} from './frameFitMutationScheduler'
import { isSelectionChromeMutation } from './selectionChromeMutation'
import { OVERLAY_ID_ATTR } from './overlayStyleAttr'

const RUNTIME_SCROLL_UNROLL_STYLE_ID = 'studio-runtime-scroll-unroll'
const RUNTIME_ANIMATION_STYLE_ID = 'studio-runtime-animation-freeze'
const OVERLAY_STYLE_ID_PREFIX = 'studio-runtime-overlay-'

/** A generic RTL stand-in — mirrors `previewAxesFrameEffect.ts`'s `RTL_PREVIEW_LANG` (Studio has no real per-project locale to reach for here; see `setAxes` below for why this file does not import that module directly). */
const RTL_PREVIEW_LANG = 'ar'

export interface StudioRuntimeBridgeOptions {
  /** The exact origin every inbound `postMessage` must come from. */
  parentOrigin: string
  /** The window outbound messages are posted to. Defaults to `window.parent`. */
  parentWindow?: Window
  /** The document this bridge manages. Defaults to the global `document`. */
  document?: Document
  /** Vite's hot context, when running under a real dev server — see `hmrState.ts`. */
  hot?: ViteHotContext
}

export interface StudioRuntimeBridge {
  /**
   * Dispatches an already-validated inbound message. Exported so tests can
   * drive the dispatch logic directly without simulating the postMessage
   * transport; production code only ever reaches this through the message
   * listener installed in `dispose`'s counterpart, `createStudioRuntimeBridge`.
   */
  handleMessage(message: InboundRuntimeMessage): void
  /** Tears down every listener, observer, and injected DOM node this bridge created. */
  dispose(): void
}

function isRuntimeOwnedStyleOwner(owner: Element): boolean {
  return (
    owner.hasAttribute(OVERLAY_ID_ATTR) ||
    owner.id === RUNTIME_SCROLL_UNROLL_STYLE_ID ||
    owner.id === RUNTIME_ANIMATION_STYLE_ID ||
    owner.id === SELECTION_STYLE_TAG_ID
  )
}

/**
 * Finds the `occurrenceIndex`-th (0-based, document order) element carrying
 * `data-node-id="nodeId"` — see `messages.ts`'s "occurrenceIndex" doc for why
 * every caller passes one now, and `nodeIdIndexing.ts` for the shared count.
 * Defaults to `0`, the common non-`.map()` case.
 */
function findByNodeId(doc: Document, nodeId: string, occurrenceIndex = 0): Element | null {
  return findNthNodeById(doc, nodeId, occurrenceIndex)
}

/**
 * Boots the in-frame runtime bridge: installs the postMessage listener,
 * posts `ready`, and returns a handle for direct dispatch (tests) and
 * teardown. Nothing here reaches for `window.parent` implicitly except as
 * the default for `options.parentWindow` — every other cross-window
 * reference is a parameter, so this is fully exercisable in happy-dom.
 */
/**
 * Which of the allowed parent origins actually framed this document — the
 * origin of `document.referrer` when it is on the list, else `null` (opened
 * in a plain tab, framed by something not on the list, or the referrer
 * withheld). The shell's `main.jsx` boots the bridge only for a non-null
 * answer, and the runtime then talks to that one origin exclusively — the
 * allowlist narrows who may be a parent; the referrer names which one is.
 *
 * Two sources name the parent, tried in this order:
 *
 *   1. `location.ancestorOrigins[0]` (`ancestorOrigin`) — the browser's own
 *      record of who framed this document. It survives everything the
 *      document does to itself: a Vite full reload (`location.reload()`, run
 *      whenever a module without an HMR boundary changes — the runtime bundle
 *      itself on every project open, `main.jsx`, `vite.config.js`) reloads
 *      the frame with `document.referrer` set to the frame's OWN url, and a
 *      referrer-only check then answered `null` and left a reloaded frame
 *      running without its bridge: no rings, no mode, no selection, until
 *      the parent tab was refreshed (`live-13`). Chromium and WebKit expose
 *      it; Firefox does not, and falls through to the referrer.
 *   2. `document.referrer` — the parent document's URL for an iframe the
 *      parent navigated, reduced to its origin by the admin's own
 *      `Referrer-Policy: strict-origin-when-cross-origin`.
 *
 * Neither source can widen anything: each is checked against the list, and
 * the list is the same set the live listener's CSP `frame-ancestors` already
 * restricts framing to.
 */
export function resolveParentOrigin(
  allowedOrigins: readonly string[],
  referrer: string,
  ancestorOrigin: string | null = readAncestorOrigin(),
): string | null {
  for (const candidate of [ancestorOrigin, referrer]) {
    if (!candidate) continue
    let origin: string
    try {
      origin = new URL(candidate).origin
    } catch {
      continue
    }
    if (allowedOrigins.includes(origin)) return origin
  }
  return null
}

/** The direct framing document's origin, where the browser exposes it (`Location.ancestorOrigins` — not Firefox). */
function readAncestorOrigin(): string | null {
  const location = (globalThis as { location?: { ancestorOrigins?: ArrayLike<string> } }).location
  const origins = location?.ancestorOrigins
  return origins && origins.length > 0 ? (origins[0] ?? null) : null
}

export function createStudioRuntimeBridge(options: StudioRuntimeBridgeOptions): StudioRuntimeBridge {
  const doc = options.document ?? document
  const parentWindow = options.parentWindow ?? window.parent
  const { parentOrigin } = options
  const view = doc.defaultView ?? window

  // ---- overlay <style> manager ------------------------------------------
  const overlayStyles = new Map<string, HTMLStyleElement>()

  function applyOverlay(id: string, css: string): void {
    let el = overlayStyles.get(id)
    if (!el) {
      el = doc.createElement('style')
      el.id = `${OVERLAY_STYLE_ID_PREFIX}${id}`
      el.setAttribute(OVERLAY_ID_ATTR, id)
      doc.head?.appendChild(el)
      overlayStyles.set(id, el)
    }
    el.textContent = css
  }

  function removeOverlay(id: string): void {
    overlayStyles.get(id)?.remove()
    overlayStyles.delete(id)
  }

  // ---- mode-gated behaviours (hover suppression / scroll unroll / animation freeze) ----
  let mode: RuntimeMode | null = null
  let hoverController: HoverSuppressionController | null = null
  let scrollController: ScrollUnrollController | null = null
  let animationController: AnimationFreezeController | null = null

  function applyMode(next: RuntimeMode): void {
    if (next === mode) return
    mode = next
    if (next === 'live') {
      hoverController?.dispose()
      hoverController = null
      scrollController?.dispose()
      scrollController = null
      animationController?.dispose()
      animationController = null
      // A live/preview frame renders at its own real intended size — clear
      // any pin the frame carried while it was a design-board frame, same
      // as portal mode never pinning one for `isLive` at all.
      if (doc.body) doc.body.style.height = ''
      return
    }
    hoverController ??= startHoverSuppression(doc, (owner) => !isRuntimeOwnedStyleOwner(owner))
    scrollController ??= startScrollUnroll(doc, RUNTIME_SCROLL_UNROLL_STYLE_ID)
    animationController ??= startAnimationFreeze(doc, RUNTIME_ANIMATION_STYLE_ID)
    resetFrameFit()
  }

  // ---- selection / hover rings (new: the frame owns DOM + positioning) ----
  let overlayRoot: HTMLDivElement | null = null

  function ensureOverlayRoot(): HTMLDivElement | null {
    if (!doc.body) return null
    if (overlayRoot?.isConnected) return overlayRoot
    let root = doc.getElementById(SELECTION_OVERLAY_ROOT_ID) as HTMLDivElement | null
    if (!root) {
      root = doc.createElement('div')
      root.id = SELECTION_OVERLAY_ROOT_ID
      Object.assign(root.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '0',
        height: '0',
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: '2147483647',
      })
      doc.body.appendChild(root)
    }
    // An absolutely-positioned overlay root needs a positioned containing
    // block at `body` — otherwise it resolves against the initial
    // containing block instead, which breaks the "rect relative to body"
    // math every ring position below depends on. Only set when the author
    // left `position` at the CSS default, so an already-positioned body
    // (`relative`/`sticky`/`fixed`) keeps its own value.
    if (view.getComputedStyle(doc.body).position === 'static') {
      doc.body.style.position = 'relative'
    }
    if (!doc.getElementById(SELECTION_STYLE_TAG_ID)) {
      const styleEl = doc.createElement('style')
      styleEl.id = SELECTION_STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'studio-runtime')
      // Token values (`--canvas-selection-ring` etc.) are NOT computed here —
      // a cross-origin frame cannot read the parent's `getComputedStyle`.
      // They arrive as an `applyOverlay` stylesheet from the parent (L5); see
      // `selectionChromeCss.ts`'s module doc. Until that lands the rings
      // still create/position correctly, just with whatever `box-shadow`
      // the unresolved `var()` falls back to (none).
      styleEl.textContent = SELECTION_CHROME_RULES
      doc.head?.appendChild(styleEl)
    }
    overlayRoot = root
    return root
  }

  function createRing(kind: 'selection' | 'hover'): HTMLDivElement {
    const el = doc.createElement('div')
    el.setAttribute(kind === 'selection' ? 'data-canvas-selection-ring' : 'data-canvas-hover-ring', '')
    el.style.display = 'none'
    ensureOverlayRoot()?.appendChild(el)
    return el
  }

function ringKey(nodeId: string, occurrenceIndex: number): string {
    return `${nodeId}#${occurrenceIndex}`
  }

  function positionRingOnNode(ringEl: HTMLDivElement, nodeId: string, occurrenceIndex: number): void {
    const target = findByNodeId(doc, nodeId, occurrenceIndex)
    if (!target || !doc.body) {
      ringEl.style.display = 'none'
      return
    }
    const rect = rectRelativeToBody(target, doc.body)
    ringEl.style.display = ''
    ringEl.style.width = `${rect.width}px`
    ringEl.style.height = `${rect.height}px`
    ringEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`
  }

  const selectionRings = new Map<string, { nodeId: string; occurrenceIndex: number; el: HTMLDivElement }>()
  let hoverRing: HTMLDivElement | null = null
  let hoverRef: { nodeId: string; occurrenceIndex: number } | null = null

  function repositionAllRings(): void {
    for (const { nodeId, occurrenceIndex, el } of selectionRings.values()) positionRingOnNode(el, nodeId, occurrenceIndex)
    if (hoverRing && hoverRef) positionRingOnNode(hoverRing, hoverRef.nodeId, hoverRef.occurrenceIndex)
    resize.reposition()
  }

  let repositionRaf: number | null = null
  function scheduleReposition(): void {
    if (repositionRaf !== null) return
    const raf = view.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    repositionRaf = raf(() => {
      repositionRaf = null
      repositionAllRings()
    })
  }

  function handleSelect(refs: readonly { nodeId: string; occurrenceIndex: number }[]): void {
    const next = new Set(refs.map((ref) => ringKey(ref.nodeId, ref.occurrenceIndex)))
    for (const [key, { el }] of selectionRings) {
      if (!next.has(key)) {
        el.remove()
        selectionRings.delete(key)
      }
    }
    for (const ref of refs) {
      const key = ringKey(ref.nodeId, ref.occurrenceIndex)
      let entry = selectionRings.get(key)
      if (!entry) {
        entry = { ...ref, el: createRing('selection') }
        selectionRings.set(key, entry)
      }
      positionRingOnNode(entry.el, ref.nodeId, ref.occurrenceIndex)
    }
  }

  // ---- resize handles (`live-13`) — drawn and dragged here, committed by the parent ----
  const resize = installResizeHandles({
    doc,
    view,
    ensureOverlayRoot,
    resolveTarget: (target) => findByNodeId(doc, target.nodeId, target.occurrenceIndex),
    onCommit: (target, patch) => postOutbound({ type: 'resize:commit', nodeId: target.nodeId, occurrenceIndex: target.occurrenceIndex, patch }),
    onPreview: scheduleReposition,
  })

  function handleHover(nodeId: string | null, occurrenceIndex: number): void {
    hoverRef = nodeId === null ? null : { nodeId, occurrenceIndex }
    if (nodeId === null) {
      if (hoverRing) hoverRing.style.display = 'none'
      return
    }
    hoverRing ??= createRing('hover')
    positionRingOnNode(hoverRing, nodeId, occurrenceIndex)
  }

  // ---- measure ------------------------------------------------------------
  // Split out (`measureNodes.ts`) with `dropCandidates.ts` (`speed-06`) to
  // keep this module under the 700-line ceiling.
  function handleMeasure(
    requestId: string,
    refs: readonly { nodeId: string; occurrenceIndex: number }[],
    properties: readonly string[] | undefined,
  ): void {
    const measurements: NodeMeasurement[] = measureNodes(doc, view, refs, properties)
    postOutbound({ type: 'measure:result', requestId, measurements })
  }

  // ---- dropCandidates (`speed-06`) -----------------------------------------
  function handleDropCandidates(requestId: string): void {
    postOutbound({ type: 'dropCandidates:result', requestId, candidates: collectDropCandidates(doc) })
  }

  // ---- setAxes --------------------------------------------------------------
  // A deliberately small, self-contained copy of the universal (mechanism-
  // independent) attribute writes `previewAxesFrameEffect.ts` makes — NOT an
  // import of that module. Two reasons: (1) that module is admin-only
  // (imports `@site/store`), and this file ships to a real browser with zero
  // admin imports by design; (2) its "toggle the project's OWN class/attribute
  // dark-mode gate" branch needs a `ColorSchemeCapability` probe result this
  // message does not carry — deferred to L5, which can extend `setAxes`'s
  // payload once the parent-side adapter has that probe result to send.
  function handleSetAxes(axes: { direction: 'ltr' | 'rtl'; colorScheme: 'light' | 'dark' }): void {
    const html = doc.documentElement
    html.setAttribute('dir', axes.direction)
    if (axes.direction === 'rtl') html.setAttribute('lang', RTL_PREVIEW_LANG)
    else html.removeAttribute('lang')
    html.setAttribute('data-studio-scheme', axes.colorScheme)
    html.setAttribute('data-theme', axes.colorScheme)
    html.style.colorScheme = axes.colorScheme
  }

  // ---- outbound: every message this frame ever posts shares one sender ----
  function postOutbound(message: OutboundRuntimeMessage): void {
    parentWindow.postMessage(toOutboundEnvelope(message), parentOrigin)
  }

  // Pointer + wheel forwarding, and design-mode ownership of the gesture —
  // `gestureForwarding.ts` (`live-12`), reading `mode` live through the getter.
  const disposeGestureForwarding = installGestureForwarding(doc, { getMode: () => mode, post: postOutbound })
  // Design-mode keyboard → the parent's key dispatcher (P2-B) — `keyForwarding.ts`.
  const disposeKeyForwarding = installKeyForwarding(doc, { getMode: () => mode, post: postOutbound })

  // `live-18` — double-click-to-edit text; see `inlineTextEdit.ts`'s module doc.
  const textEdit = installInlineTextEdit({ doc, getMode: () => mode, post: postOutbound })

  // ---- outbound: runtime errors (Z5) — taps + bounds in `runtimeErrorTaps.ts` ----
  const disposeErrorTaps = startRuntimeErrorTaps(view, (finding) => postOutbound({ type: 'error', ...finding }))

  // ---- resize / layout-driven ring repositioning ----------------------------
  view.addEventListener('resize', scheduleReposition)
  // A genuine content mutation may mean the page got shorter, so the fit pin
  // is re-derived from scratch instead of only ever growing — through the
  // SAME scheduler the portal frame uses (`frameFitMutationScheduler.ts`,
  // PERF-9). It ignores this runtime's own writes by construction: the pin
  // write on `body.style`, the resize preview's stamp and `speed-01`'s
  // optimistic style stamp are all ATTRIBUTE records, which never reset a
  // fit, and the ring overlay is selection chrome. What is left — nodes
  // added or removed — settles after a trailing debounce, because a live app
  // may add and remove nodes every frame on its own (a carousel, an
  // `AnimatePresence`) and each reset is a full-document forced layout.
  const frameFitScheduler = createFrameFitMutationScheduler({
    onSettle: resetFrameFit,
    textDebounceMs: FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
    structuralDebounceMs: LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
  })
  let layoutObserver: MutationObserver | null = null
  if (doc.body) {
    const MutationObserverCtor = view.MutationObserver ?? MutationObserver
    try {
      layoutObserver = new MutationObserverCtor((records) => {
        // The rings' own repositioning writes are chrome; repositioning for
        // them would schedule another frame for nothing.
        if (!records.every(isSelectionChromeMutation)) scheduleReposition()
        frameFitScheduler.handle(records)
      })
      layoutObserver.observe(doc.body, { childList: true, subtree: true, attributes: true })
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node. Rings still
      // reposition on the next explicit select/hover/resize.
      layoutObserver = null
    }
  }

  // ---- frame:resize — the cross-origin replacement for portal mode's
  // ResizeObserver on `contentWindow` (impossible here by construction). See
  // `frameFitRules.ts`'s module doc and `live-05`'s STATE.md entry.
  //
  // Mirrors `useIframeFrameAutoHeight.ts`'s (portal) split of concerns as
  // closely as a cross-origin frame allows: BODY's definite height (the pin
  // that resolves a `height: 100%` chain and stops internal scrolling) is a
  // child-side write only this in-frame code can make; the OUTER `<iframe>`
  // element's box on the parent canvas is a parent-side concern the reported
  // `height` here feeds (Batch 5, `useIframeFrameAutoHeight.ts`'s bridge
  // branch, via the SAME `resolveCanvasFrameHeight` portal mode already
  // uses). Only active in `mode === 'design'` — a live/preview frame renders
  // at its own real intended size and must not be artificially fit, exactly
  // matching portal mode's `isLive` early return.
  //
  // Coalesced to one post per animation frame, the same shape as
  // `scheduleReposition` above — deliberately a SEPARATE raf handle, since
  // ring repositioning and height reporting are independent concerns that
  // shouldn't drop each other's frame.
  //
  // The pin is reset (allowing the frame to SHRINK) only on a genuine
  // content mutation, through `frameFitScheduler` above — the same
  // classify-and-debounce module portal mode uses (PERF-9).
  let pinnedHeight = DEFAULT_FRAME_FIT_HEIGHT
  let frameFitPassesUsed = 0
  let lastReportedHeight: number | null = null
  function reportFrameHeight(): void {
    if (!doc.body || mode !== 'design') return
    const fitted = resolveFrameFitHeight({
      pinnedHeight,
      scrollDeficits: collectScrollDeficits(doc),
      passesUsed: frameFitPassesUsed,
    } satisfies FrameFitMetrics)
    if (fitted !== null) {
      pinnedHeight = fitted
      frameFitPassesUsed += 1
      doc.body.style.height = `${fitted}px`
    }
    const height = doc.body.scrollHeight
    if (height === lastReportedHeight) return
    lastReportedHeight = height
    postOutbound({ type: 'frame:resize', height })
  }
  let resizeRaf: number | null = null
  function scheduleFrameResize(): void {
    if (resizeRaf !== null) return
    const raf = view.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    resizeRaf = raf(() => {
      resizeRaf = null
      reportFrameHeight()
    })
  }
  /** A genuine content mutation resets the pin so a page that got SHORTER can shrink again — see the module comment above. */
  function resetFrameFit(): void {
    if (mode !== 'design') return
    pinnedHeight = DEFAULT_FRAME_FIT_HEIGHT
    frameFitPassesUsed = 0
    if (doc.body) doc.body.style.height = `${DEFAULT_FRAME_FIT_HEIGHT}px`
    scheduleFrameResize()
  }
  let frameResizeObserver: ResizeObserver | null = null
  if (doc.body) {
    const ResizeObserverCtor = view.ResizeObserver ?? ResizeObserver
    try {
      frameResizeObserver = new ResizeObserverCtor(scheduleFrameResize)
      frameResizeObserver.observe(doc.body)
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node — same
      // posture as `layoutObserver` above.
      frameResizeObserver = null
    }
  }

  // ---- dispatch -------------------------------------------------------------
  function handleMessage(message: InboundRuntimeMessage): void {
    switch (message.type) {
      case 'applyOverlay':
        applyOverlay(message.id, message.css)
        return
      case 'removeOverlay':
        removeOverlay(message.id)
        return
      case 'select':
        handleSelect(message.refs)
        return
      case 'hover':
        handleHover(message.nodeId, message.occurrenceIndex)
        return
      case 'measure':
        handleMeasure(message.requestId, message.refs, message.properties)
        return
      case 'setAxes':
        handleSetAxes(message.axes)
        return
      case 'setMode':
        applyMode(message.mode)
        return
      case 'setResizeTarget':
        resize.setTarget(message.ref, message.proportional)
        return
      case 'text:edit':
        textEdit.handleReply(message)
        return
      case 'optimistic.insert':
        applyOptimisticInsert(doc, message)
        return
      case 'optimistic.delete':
        applyOptimisticDelete(doc, message.nodeId, message.occurrenceIndex)
        return
      case 'optimistic.move':
        applyOptimisticMove(doc, message.nodeId, message.occurrenceIndex, message.parentNodeId, message.parentOccurrenceIndex, message.index)
        return
      case 'optimistic.text':
        applyOptimisticText(doc, message.nodeId, message.occurrenceIndex, message.text)
        return
      case 'optimistic.style':
        applyOptimisticStyle(doc, message.ref, message.patch) // `message.className` is wire-informational only — see `optimisticStyle.ts`
        scheduleReposition()
        return
      case 'optimistic.style:clear':
        clearOptimisticStyle(doc, message.ref)
        scheduleReposition()
        return
      case 'dropCandidates':
        handleDropCandidates(message.requestId)
        return
    }
  }

  // ---- postMessage transport --------------------------------------------
  function onWindowMessage(ev: MessageEvent): void {
    if (ev.origin !== parentOrigin) return
    if (ev.source !== parentWindow) return
    const data: unknown = ev.data
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { source?: unknown }).source !== RUNTIME_MESSAGE_SOURCE ||
      (data as { direction?: unknown }).direction !== 'to-frame'
    ) {
      return
    }
    if (!Value.Check(InboundEnvelopeSchema, data)) return
    handleMessage((data as { message: InboundRuntimeMessage }).message)
  }
  view.addEventListener('message', onWindowMessage)

  // ---- HMR state survival --------------------------------------------------
  if (options.hot) {
    wireHmrStateAcrossUpdates(
      doc,
      options.hot,
      () => {
        // Before React reconciles: hand it back the DOM it built (`live-14`).
        revertOptimisticDom(doc)
        revertAllOptimisticStyle(doc)
        textEdit.onHmrBefore()
        postOutbound({ type: 'hmr:before' })
      },
      () => {
        sweepOptimisticGhosts(doc)
        resize.clearPreview() // the source now carries it; idempotent with `hmr:before` above
        revertAllOptimisticStyle(doc)
        postOutbound({ type: 'hmr:after' })
      },
    )
  }

  postOutbound({ type: 'ready' })

  return {
    handleMessage,
    dispose() {
      view.removeEventListener('message', onWindowMessage)
      view.removeEventListener('resize', scheduleReposition)
      disposeGestureForwarding()
      disposeKeyForwarding()
      resize.dispose()
      textEdit.dispose()
      disposeErrorTaps()
      layoutObserver?.disconnect()
      frameFitScheduler.dispose()
      if (repositionRaf !== null) (view.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame)(repositionRaf)
      frameResizeObserver?.disconnect()
      if (resizeRaf !== null) (view.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame)(resizeRaf)

      hoverController?.dispose()
      scrollController?.dispose()
      animationController?.dispose()

      for (const el of overlayStyles.values()) el.remove()
      overlayStyles.clear()

      for (const { el } of selectionRings.values()) el.remove()
      selectionRings.clear()
      hoverRing?.remove()
      hoverRing = null

      doc.getElementById(SELECTION_STYLE_TAG_ID)?.remove()
      overlayRoot?.remove()
      overlayRoot = null
    },
  }
}
