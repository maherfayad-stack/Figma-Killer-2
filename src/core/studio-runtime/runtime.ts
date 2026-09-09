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
 *   - optimistic DOM mutation for insert/delete/move/text.
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
 *   - `optimistic.insert`/`optimistic.text` never touch `innerHTML` — new
 *     elements are built with `document.createElement` + `tagName` (itself
 *     schema-validated to `^[a-zA-Z][a-zA-Z0-9-]*$`), and all text goes
 *     through `Node.textContent`, never a parsed HTML string.
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
import { startHoverSuppression, type HoverSuppressionController } from './hoverSuppressionRules'
import { startScrollUnroll, type ScrollUnrollController } from './scrollUnrollRules'
import { startAnimationFreeze, type AnimationFreezeController } from './animationFreezeRules'
import { SELECTION_CHROME_RULES, SELECTION_OVERLAY_ROOT_ID, SELECTION_STYLE_TAG_ID } from './selectionChromeCss'
import { wireHmrStateAcrossUpdates, type ViteHotContext } from './hmrState'

const NODE_ID_ATTR = 'data-node-id'
const RUNTIME_SCROLL_UNROLL_STYLE_ID = 'studio-runtime-scroll-unroll'
const RUNTIME_ANIMATION_STYLE_ID = 'studio-runtime-animation-freeze'
const OVERLAY_STYLE_ID_PREFIX = 'studio-runtime-overlay-'
const OVERLAY_ID_ATTR = 'data-studio-overlay-id'

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

/** Finds the element carrying node id `nodeId`, without building an attribute-selector string (a node id may contain `:`, `~`, `#`, `.`, `/`). */
function findByNodeId(doc: Document, nodeId: string): Element | null {
  for (const el of doc.querySelectorAll(`[${NODE_ID_ATTR}]`)) {
    if (el.getAttribute(NODE_ID_ATTR) === nodeId) return el
  }
  return null
}

function nearestNodeId(el: Element | null): string | null {
  return (el?.closest(`[${NODE_ID_ATTR}]`) as Element | null)?.getAttribute(NODE_ID_ATTR) ?? null
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
      return
    }
    hoverController ??= startHoverSuppression(doc, (owner) => !isRuntimeOwnedStyleOwner(owner))
    scrollController ??= startScrollUnroll(doc, RUNTIME_SCROLL_UNROLL_STYLE_ID)
    animationController ??= startAnimationFreeze(doc, RUNTIME_ANIMATION_STYLE_ID)
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

  function positionRingOnNode(ringEl: HTMLDivElement, nodeId: string): void {
    const target = findByNodeId(doc, nodeId)
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

  const selectionRings = new Map<string, HTMLDivElement>()
  let hoverRing: HTMLDivElement | null = null
  let hoverNodeId: string | null = null

  function repositionAllRings(): void {
    for (const [nodeId, ring] of selectionRings) positionRingOnNode(ring, nodeId)
    if (hoverRing && hoverNodeId !== null) positionRingOnNode(hoverRing, hoverNodeId)
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

  function handleSelect(nodeIds: readonly string[]): void {
    const next = new Set(nodeIds)
    for (const [nodeId, ring] of selectionRings) {
      if (!next.has(nodeId)) {
        ring.remove()
        selectionRings.delete(nodeId)
      }
    }
    for (const nodeId of nodeIds) {
      let ring = selectionRings.get(nodeId)
      if (!ring) {
        ring = createRing('selection')
        selectionRings.set(nodeId, ring)
      }
      positionRingOnNode(ring, nodeId)
    }
  }

  function handleHover(nodeId: string | null): void {
    hoverNodeId = nodeId
    if (nodeId === null) {
      if (hoverRing) hoverRing.style.display = 'none'
      return
    }
    hoverRing ??= createRing('hover')
    positionRingOnNode(hoverRing, nodeId)
  }

  // ---- measure ------------------------------------------------------------
  function handleMeasure(requestId: string, nodeIds: readonly string[], properties: readonly string[] | undefined): void {
    const props = properties?.length ? properties : DEFAULT_MEASURED_PROPERTIES
    const measurements: NodeMeasurement[] = nodeIds.map((nodeId) => {
      const el = findByNodeId(doc, nodeId)
      if (!el || !doc.body) return { nodeId, rect: null, computedStyle: {} }
      const rect = rectRelativeToBody(el, doc.body)
      const computed = view.getComputedStyle(el)
      const computedStyle: Record<string, string> = {}
      for (const prop of props) computedStyle[prop] = computed.getPropertyValue(prop)
      return { nodeId, rect, computedStyle }
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

  // ---- optimistic DOM ops — structured fields only, never innerHTML --------
  function handleOptimisticInsert(nodeId: string, parentNodeId: string, index: number, tagName: string, text: string | undefined): void {
    const parent = findByNodeId(doc, parentNodeId)
    if (!parent) return
    const el = doc.createElement(tagName)
    el.setAttribute(NODE_ID_ATTR, nodeId)
    el.setAttribute('data-studio-optimistic', '')
    if (text !== undefined) el.textContent = text
    parent.insertBefore(el, parent.children[index] ?? null)
  }

  function handleOptimisticDelete(nodeId: string): void {
    findByNodeId(doc, nodeId)?.remove()
  }

  function handleOptimisticMove(nodeId: string, parentNodeId: string, index: number): void {
    const el = findByNodeId(doc, nodeId)
    const parent = findByNodeId(doc, parentNodeId)
    if (!el || !parent) return
    parent.insertBefore(el, parent.children[index] ?? null)
  }

  function handleOptimisticText(nodeId: string, text: string): void {
    const el = findByNodeId(doc, nodeId)
    if (el) el.textContent = text
  }

  // ---- outbound: pointer + text:edit ---------------------------------------
  function postOutbound(message: OutboundRuntimeMessage): void {
    parentWindow.postMessage(toOutboundEnvelope(message), parentOrigin)
  }

  function forwardPointer(phase: 'down' | 'move' | 'up' | 'click', ev: PointerEvent | MouseEvent): void {
    const target = ev.target instanceof Element ? ev.target : null
    const anchor = target?.closest(`[${NODE_ID_ATTR}]`) ?? null
    const rect = anchor && doc.body ? rectRelativeToBody(anchor, doc.body) : null
    postOutbound({
      type: 'pointer',
      phase,
      nodeId: nearestNodeId(target),
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
    postOutbound({ type: 'text:edit', nodeId, text: target.textContent ?? '' })
  }
  doc.addEventListener('input', onInput, true)

  // ---- resize / layout-driven ring repositioning ----------------------------
  view.addEventListener('resize', scheduleReposition)
  let layoutObserver: MutationObserver | null = null
  if (doc.body) {
    const MutationObserverCtor = view.MutationObserver ?? MutationObserver
    try {
      layoutObserver = new MutationObserverCtor(scheduleReposition)
      layoutObserver.observe(doc.body, { childList: true, subtree: true, attributes: true })
    } catch (_err) {
      // Some browser realms reject observing a cross-realm node. Rings still
      // reposition on the next explicit select/hover/resize.
      layoutObserver = null
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
        handleSelect(message.nodeIds)
        return
      case 'hover':
        handleHover(message.nodeId)
        return
      case 'measure':
        handleMeasure(message.requestId, message.nodeIds, message.properties)
        return
      case 'setAxes':
        handleSetAxes(message.axes)
        return
      case 'setMode':
        applyMode(message.mode)
        return
      case 'optimistic.insert':
        handleOptimisticInsert(message.nodeId, message.parentNodeId, message.index, message.tagName, message.text)
        return
      case 'optimistic.delete':
        handleOptimisticDelete(message.nodeId)
        return
      case 'optimistic.move':
        handleOptimisticMove(message.nodeId, message.parentNodeId, message.index)
        return
      case 'optimistic.text':
        handleOptimisticText(message.nodeId, message.text)
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
      () => postOutbound({ type: 'hmr:after' }),
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
      layoutObserver?.disconnect()
      if (repositionRaf !== null) (view.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame)(repositionRaf)

      hoverController?.dispose()
      scrollController?.dispose()
      animationController?.dispose()

      for (const el of overlayStyles.values()) el.remove()
      overlayStyles.clear()

      for (const ring of selectionRings.values()) ring.remove()
      selectionRings.clear()
      hoverRing?.remove()
      hoverRing = null

      doc.getElementById(SELECTION_STYLE_TAG_ID)?.remove()
      overlayRoot?.remove()
      overlayRoot = null
    },
  }
}
