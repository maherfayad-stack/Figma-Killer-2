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
  type NodeRect,
  type OutboundRuntimeMessage,
  type RuntimeMode,
} from './messages'
import { startRuntimeErrorTaps } from './runtimeErrorTaps'
import {
  applyOptimisticDelete,
  applyOptimisticInsert,
  applyOptimisticMove,
  applyOptimisticText,
  sweepOptimisticGhosts,
} from './optimisticDomOps'
import { startHoverSuppression, type HoverSuppressionController } from './hoverSuppressionRules'
import { startScrollUnroll, type ScrollUnrollController } from './scrollUnrollRules'
import { startAnimationFreeze, type AnimationFreezeController } from './animationFreezeRules'
import { SELECTION_CHROME_RULES, SELECTION_OVERLAY_ROOT_ID, SELECTION_STYLE_TAG_ID } from './selectionChromeCss'
import { wireHmrStateAcrossUpdates, type ViteHotContext } from './hmrState'
import { findNthNodeById, occurrenceIndexOf } from './nodeIdIndexing'
import { collectScrollDeficits, DEFAULT_FRAME_FIT_HEIGHT, resolveFrameFitHeight, type FrameFitMetrics } from './frameFitRules'
import { OVERLAY_ID_ATTR } from './overlayStyleAttr'

const NODE_ID_ATTR = 'data-node-id'
const RUNTIME_SCROLL_UNROLL_STYLE_ID = 'studio-runtime-scroll-unroll'
const RUNTIME_ANIMATION_STYLE_ID = 'studio-runtime-animation-freeze'
const OVERLAY_STYLE_ID_PREFIX = 'studio-runtime-overlay-'

/** A generic RTL stand-in — mirrors `previewAxesFrameEffect.ts`'s `RTL_PREVIEW_LANG` (Studio has no real per-project locale to reach for here; see `setAxes` below for why this file does not import that module directly). */
const RTL_PREVIEW_LANG = 'ar'

const DEFAULT_MEASURED_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'opacity',
]

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

/** The nearest node-id-carrying ancestor (inclusive) of `el`, paired with its own occurrence index — `null` if no ancestor carries a node id. */
function nearestNodeOccurrence(doc: Document, el: Element | null): { nodeId: string; occurrenceIndex: number } | null {
  const anchor = el?.closest(`[${NODE_ID_ATTR}]`) as Element | null
  if (!anchor) return null
  return occurrenceIndexOf(doc, anchor)
}

/** `el`'s box relative to `body`'s border box — both rects are viewport-relative, so scroll cancels out of the difference. */
function rectRelativeToBody(el: Element, body: HTMLElement): NodeRect {
  const elRect = el.getBoundingClientRect()
  const bodyRect = body.getBoundingClientRect()
  return {
    x: elRect.left - bodyRect.left,
    y: elRect.top - bodyRect.top,
    width: elRect.width,
    height: elRect.height,
  }
}

/**
 * Boots the in-frame runtime bridge: installs the postMessage listener,
 * posts `ready`, and returns a handle for direct dispatch (tests) and
 * teardown. Nothing here reaches for `window.parent` implicitly except as
 * the default for `options.parentWindow` — every other cross-window
 * reference is a parameter, so this is fully exercisable in happy-dom.
 */
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
  function handleMeasure(
    requestId: string,
    refs: readonly { nodeId: string; occurrenceIndex: number }[],
    properties: readonly string[] | undefined,
  ): void {
    const props = properties?.length ? properties : DEFAULT_MEASURED_PROPERTIES
    const measurements: NodeMeasurement[] = refs.map(({ nodeId, occurrenceIndex }) => {
      const el = findByNodeId(doc, nodeId, occurrenceIndex)
      if (!el || !doc.body) return { nodeId, occurrenceIndex, rect: null, computedStyle: {} }
      const rect = rectRelativeToBody(el, doc.body)
      const computed = view.getComputedStyle(el)
      const computedStyle: Record<string, string> = {}
      for (const prop of props) computedStyle[prop] = computed.getPropertyValue(prop)
      return { nodeId, occurrenceIndex, rect, computedStyle }
    })
    postOutbound({ type: 'measure:result', requestId, measurements })
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

  // ---- outbound: pointer + text:edit ---------------------------------------
  function postOutbound(message: OutboundRuntimeMessage): void {
    parentWindow.postMessage(toOutboundEnvelope(message), parentOrigin)
  }

  function forwardPointer(phase: 'down' | 'move' | 'up' | 'click', ev: PointerEvent | MouseEvent): void {
    const target = ev.target instanceof Element ? ev.target : null
    const anchor = target?.closest(`[${NODE_ID_ATTR}]`) ?? null
    const rect = anchor && doc.body ? rectRelativeToBody(anchor, doc.body) : null
    const occurrence = nearestNodeOccurrence(doc, target)
    postOutbound({
      type: 'pointer',
      phase,
      nodeId: occurrence?.nodeId ?? null,
      occurrenceIndex: occurrence?.occurrenceIndex ?? 0,
      rect,
      clientX: ev.clientX,
      clientY: ev.clientY,
      modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
    })
  }
  const onPointerDown = (ev: PointerEvent) => forwardPointer('down', ev)
  const onPointerMove = (ev: PointerEvent) => forwardPointer('move', ev)
  const onPointerUp = (ev: PointerEvent) => forwardPointer('up', ev)
  const onClick = (ev: MouseEvent) => forwardPointer('click', ev)
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('pointermove', onPointerMove, true)
  doc.addEventListener('pointerup', onPointerUp, true)
  doc.addEventListener('click', onClick, true)

  // A minimal inline-text-edit bridge: any `contenteditable` element that
  // also carries a node id reports its live text on every `input`. Seeding
  // the editable content, latching it against the parent's own inline-edit
  // session, and routing the result to `textOrigin` writeback are L5/L7
  // concerns — this is the emission half only.
  function onInput(ev: Event): void {
    const target = ev.target instanceof Element ? ev.target : null
    if (!target?.hasAttribute('contenteditable')) return
    const nodeId = target.getAttribute(NODE_ID_ATTR)
    if (!nodeId) return
    const occurrence = occurrenceIndexOf(doc, target)
    postOutbound({ type: 'text:edit', nodeId, occurrenceIndex: occurrence?.occurrenceIndex ?? 0, text: target.textContent ?? '' })
  }
  doc.addEventListener('input', onInput, true)

  // ---- outbound: runtime errors (Z5) — taps + bounds in `runtimeErrorTaps.ts` ----
  const disposeErrorTaps = startRuntimeErrorTaps(view, (finding) => postOutbound({ type: 'error', ...finding }))

  // ---- resize / layout-driven ring repositioning ----------------------------
  view.addEventListener('resize', scheduleReposition)
  let layoutObserver: MutationObserver | null = null
  if (doc.body) {
    const MutationObserverCtor = view.MutationObserver ?? MutationObserver
    try {
      layoutObserver = new MutationObserverCtor((records) => {
        scheduleReposition()
        // A genuine DOM mutation may mean the page got shorter — re-derive
        // the fit pin from scratch instead of only ever growing it. See the
        // "frame:resize" section's module comment below for the known
        // simplification (undebounced) vs. portal mode's own scheduler.
        //
        // MUST ignore a record that is ONLY this adapter's own chrome: (1)
        // `doc.body`'s own `style` attribute (`resetFrameFit`/
        // `reportFrameHeight`'s pin write — without this, the pin write
        // re-triggers `resetFrameFit`, which pins again, forever), or (2)
        // anything inside the selection/hover ring overlay root (repositioning
        // a ring on every select/hover would otherwise spuriously reset the
        // fit pin, since ring elements live inside `doc.body`'s observed
        // subtree too). Any OTHER mutation — real content added/removed
        // anywhere, or a non-chrome attribute change — still resets normally.
        const isIgnorable = (record: MutationRecord): boolean => {
          if (record.target === doc.body && record.type === 'attributes' && record.attributeName === 'style') return true
          return record.target instanceof Element && record.target.closest(`#${SELECTION_OVERLAY_ROOT_ID}`) !== null
        }
        if (records.every(isIgnorable)) return
        resetFrameFit()
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
  // KNOWN SIMPLIFICATION vs. portal mode, flagged rather than silently
  // claimed as full parity: portal mode resets the pin to the viewport
  // height (allowing it to SHRINK) only on a genuine content mutation,
  // debounced through `frameFitMutationScheduler.ts` so a burst of
  // inline-text-edit keystrokes doesn't each pay the O(all elements)
  // `collectScrollDeficits` scan. This reuses the SAME `layoutObserver`
  // MutationObserver already installed for ring repositioning as the reset
  // trigger, undebounced — correct in direction (an edit that removes
  // content can shrink the frame again) but not yet perf-hardened against a
  // rapid-fire real-content-edit burst the way portal mode is. Untestable
  // against a real cross-origin ResizeObserver feedback loop until L1-L4 are
  // real running services (see this file's own PR description) — a
  // dedicated `frameFitMutationScheduler`-equivalent port is a reasonable
  // Batch 5 follow-up if that turns out to matter in practice.
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
      () => postOutbound({ type: 'hmr:before' }),
      () => {
        sweepOptimisticGhosts(doc)
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
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('pointermove', onPointerMove, true)
      doc.removeEventListener('pointerup', onPointerUp, true)
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('input', onInput, true)
      disposeErrorTaps()
      layoutObserver?.disconnect()
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
