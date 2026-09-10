/**
 * PortalFrameAdapter — the `FrameDocumentAdapter` for a same-origin, React-
 * portaled canvas frame (Tier 0/1 — today's only mode, and every Tier 0/1
 * frame forever, per `documentMode: 'portal' | 'bridge'`'s own contract).
 *
 * **The ONLY file under `canvas/` allowed to hold a `Document` reference for
 * canvas rendering purposes after this work order lands** — enforced by
 * `src/__tests__/architecture/frame-document-adapter-isolation.test.ts`.
 *
 * Every operation here is the SAME DOM mechanics today's five CSS injectors,
 * `CanvasSelectionOverlayInjector`, and the structural drag/reorder code
 * already perform directly against `targetDocument` — this class is a
 * refactor of where that code lives, not a behavior change. `measure` is
 * synchronous under the hood (same-origin, no real async boundary) but
 * `Promise`-shaped so callers never branch on which adapter kind they hold.
 */
import { getColorSchemeCapability } from '@site/studio/previewAxesCapability'
import type { PreviewAxes } from '@core/studio-board'
import {
  OVERLAY_ID_ATTR,
  SELECTION_CHROME_RULES,
  SELECTION_OVERLAY_ROOT_ID,
  SELECTION_STYLE_TAG_ID,
  startAnimationFreeze,
  startHoverSuppression,
  startScrollUnroll,
  type AnimationFreezeController,
  type HoverSuppressionController,
  type ScrollUnrollController,
} from '@core/studio-runtime'
import { applyPreviewAxesToFrameDocument } from '../previewAxesFrameEffect'
import { escapeCssAttributeValue } from '../canvasNodeLookup'
import type {
  FrameDocumentAdapter,
  FrameRuntimeEvent,
  NodeMeasurement,
  NodeRect,
  NodeRef,
  OptimisticDomOps,
  Unsubscribe,
} from './FrameDocumentAdapter'

const NODE_ID_ATTR = 'data-node-id'
const OVERLAY_STYLE_ID_PREFIX = 'studio-portal-adapter-overlay-'
const RUNTIME_SCROLL_UNROLL_STYLE_ID = 'studio-portal-adapter-scroll-unroll'
const RUNTIME_ANIMATION_STYLE_ID = 'studio-portal-adapter-animation-freeze'

/**
 * The page-content stylesheets hover suppression is allowed to rewrite, by
 * the LOGICAL id each of the five CSS-text injectors passes to
 * `applyOverlay` (`mc-vendor`, `mc-authored`, `mc-classes`, `mc-user-styles`)
 * — an ALLOWLIST, not a denylist, so the editor's own chrome (selection
 * overlay, resize handles) never has its real `:hover` affordances
 * suppressed. Matched against `owner.getAttribute(OVERLAY_ID_ATTR)`, NOT
 * `owner.id` — every `applyOverlay`-managed style element's physical DOM
 * `id` is prefixed (`OVERLAY_STYLE_ID_PREFIX`), so the bare logical name
 * only ever appears in this attribute. Mirrors
 * `CanvasHoverSuppressionInjector.tsx`'s own `CONTENT_STYLE_IDS` exactly;
 * duplicated here (not imported) because that component is itself migrating
 * to call THIS adapter in a later batch — see `STATE.md`'s `live-05` entry.
 * Once that batch lands, this is the one copy; until then it is a second,
 * intentionally-identical one.
 */
const CONTENT_STYLE_IDS = new Set(['mc-vendor', 'mc-authored', 'mc-classes', 'mc-user-styles'])

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

function findByNodeId(doc: Document, nodeId: string): Element | null {
  return doc.querySelector(`[${NODE_ID_ATTR}="${escapeCssAttributeValue(nodeId)}"]`)
}

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

/** A minimal, dependency-free pub/sub for the synthetic (non-DOM) event types — `ready`/`hmr:before`/`hmr:after`/`frame:resize`. Portal mode never fires `frame:resize` itself (see the module doc on `useIframeFrameAutoHeight.ts` staying unchanged for portal mode) or `hmr:before`/`hmr:after` (Vite's own React Fast Refresh already preserves component state; the DOM-state-survival problem `hmrState.ts` solves is bridge-mode-only, since a portal frame's DOM is never independently remounted by Vite). `ready` fires once, synchronously, on construction — a portal frame has no real "boot" moment separate from the adapter itself existing. */
class SyntheticEventBus {
  private readonly handlers = new Map<string, Set<(msg: FrameRuntimeEvent) => void>>()

  on<E extends FrameRuntimeEvent['type']>(event: E, handler: (msg: Extract<FrameRuntimeEvent, { type: E }>) => void): Unsubscribe {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as (msg: FrameRuntimeEvent) => void)
    return () => set!.delete(handler as (msg: FrameRuntimeEvent) => void)
  }

  emit(msg: FrameRuntimeEvent): void {
    for (const handler of this.handlers.get(msg.type) ?? []) handler(msg)
  }
}

export class PortalFrameAdapter implements FrameDocumentAdapter {
  private readonly doc: Document
  private readonly overlayStyles = new Map<string, HTMLStyleElement>()
  private readonly selectionRings = new Map<string, HTMLDivElement>()
  private hoverRing: HTMLDivElement | null = null
  private hoverNodeId: string | null = null
  private overlayRoot: HTMLDivElement | null = null
  private interactionMode: 'design' | 'live' | null = null
  private hoverController: HoverSuppressionController | null = null
  private scrollController: ScrollUnrollController | null = null
  private animationController: AnimationFreezeController | null = null
  private readonly bus = new SyntheticEventBus()
  private readonly domUnsubscribes: Unsubscribe[] = []
  private disposed = false
  private repositionRaf: number | null = null
  private layoutObserver: MutationObserver | null = null

  readonly optimistic: OptimisticDomOps = {
    insert: (nodeId, parentNodeId, index, tagName, text) => {
      const parent = findByNodeId(this.doc, parentNodeId)
      if (!parent) return
      const el = this.doc.createElement(tagName)
      el.setAttribute(NODE_ID_ATTR, nodeId)
      el.setAttribute('data-studio-optimistic', '')
      if (text !== undefined) el.textContent = text
      parent.insertBefore(el, parent.children[index] ?? null)
    },
    delete: (nodeId) => {
      findByNodeId(this.doc, nodeId)?.remove()
    },
    move: (nodeId, parentNodeId, index) => {
      const el = findByNodeId(this.doc, nodeId)
      const parent = findByNodeId(this.doc, parentNodeId)
      if (!el || !parent) return
      parent.insertBefore(el, parent.children[index] ?? null)
    },
    text: (nodeId, text) => {
      const el = findByNodeId(this.doc, nodeId)
      if (el) el.textContent = text
    },
  }

  constructor(doc: Document) {
    this.doc = doc
    // Fires synchronously — see `SyntheticEventBus`'s doc.
    queueMicrotask(() => {
      if (!this.disposed) this.bus.emit({ type: 'ready' })
    })

    // Keeps rings glued to their node across resize/layout changes — mirrors
    // `runtime.ts`'s own `scheduleReposition`/`layoutObserver` pair.
    const view = doc.defaultView
    const raf = view?.requestAnimationFrame?.bind(view) ?? requestAnimationFrame
    const scheduleReposition = () => {
      if (this.repositionRaf !== null) return
      this.repositionRaf = raf(() => {
        this.repositionRaf = null
        this.repositionAllRings()
      })
    }
    view?.addEventListener('resize', scheduleReposition)
    this.domUnsubscribes.push(() => view?.removeEventListener('resize', scheduleReposition))
    if (doc.body) {
      const MutationObserverCtor = view?.MutationObserver ?? MutationObserver
      try {
        this.layoutObserver = new MutationObserverCtor(scheduleReposition)
        this.layoutObserver.observe(doc.body, { childList: true, subtree: true, attributes: true })
      } catch (_err) {
        // Some browser realms reject observing a cross-realm node. Rings
        // still reposition on the next explicit select/hover/resize.
        this.layoutObserver = null
      }
    }
  }

  private repositionAllRings(): void {
    for (const [nodeId, ring] of this.selectionRings) this.positionRingOnNode(ring, nodeId)
    if (this.hoverRing && this.hoverNodeId !== null) this.positionRingOnNode(this.hoverRing, this.hoverNodeId)
  }

  applyOverlay(id: string, css: string): void {
    let el = this.overlayStyles.get(id)
    if (!el) {
      el = this.doc.createElement('style')
      el.id = `${OVERLAY_STYLE_ID_PREFIX}${id}`
      el.setAttribute(OVERLAY_ID_ATTR, id)
      this.doc.head?.appendChild(el)
      this.overlayStyles.set(id, el)
    }
    el.textContent = css
  }

  removeOverlay(id: string): void {
    this.overlayStyles.get(id)?.remove()
    this.overlayStyles.delete(id)
  }

  private ensureOverlayRoot(): HTMLDivElement | null {
    if (!this.doc.body) return null
    if (this.overlayRoot?.isConnected) return this.overlayRoot
    let root = this.doc.getElementById(SELECTION_OVERLAY_ROOT_ID) as HTMLDivElement | null
    if (!root) {
      root = this.doc.createElement('div')
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
      this.doc.body.appendChild(root)
    }
    const view = this.doc.defaultView
    if (view && view.getComputedStyle(this.doc.body).position === 'static') {
      this.doc.body.style.position = 'relative'
    }
    if (!this.doc.getElementById(SELECTION_STYLE_TAG_ID)) {
      const styleEl = this.doc.createElement('style')
      styleEl.id = SELECTION_STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'portal-frame-adapter')
      styleEl.textContent = SELECTION_CHROME_RULES
      this.doc.head?.appendChild(styleEl)
    }
    this.overlayRoot = root
    return root
  }

  private createRing(kind: 'selection' | 'hover'): HTMLDivElement {
    const el = this.doc.createElement('div')
    el.setAttribute(kind === 'selection' ? 'data-canvas-selection-ring' : 'data-canvas-hover-ring', '')
    el.style.display = 'none'
    this.ensureOverlayRoot()?.appendChild(el)
    return el
  }

  private positionRingOnNode(ringEl: HTMLDivElement, nodeId: string): void {
    const target = findByNodeId(this.doc, nodeId)
    if (!target || !this.doc.body) {
      ringEl.style.display = 'none'
      return
    }
    const rect = rectRelativeToBody(target, this.doc.body)
    ringEl.style.display = ''
    ringEl.style.width = `${rect.width}px`
    ringEl.style.height = `${rect.height}px`
    ringEl.style.transform = `translate(${rect.x}px, ${rect.y}px)`
  }

  select(refs: NodeRef[]): void {
    const next = new Set(refs.map((ref) => ref.nodeId))
    for (const [nodeId, ring] of this.selectionRings) {
      if (!next.has(nodeId)) {
        ring.remove()
        this.selectionRings.delete(nodeId)
      }
    }
    for (const ref of refs) {
      let ring = this.selectionRings.get(ref.nodeId)
      if (!ring) {
        ring = this.createRing('selection')
        this.selectionRings.set(ref.nodeId, ring)
      }
      this.positionRingOnNode(ring, ref.nodeId)
    }
  }

  hover(ref: NodeRef | null): void {
    this.hoverNodeId = ref?.nodeId ?? null
    if (!ref) {
      if (this.hoverRing) this.hoverRing.style.display = 'none'
      return
    }
    this.hoverRing ??= this.createRing('hover')
    this.positionRingOnNode(this.hoverRing, ref.nodeId)
  }

  async measure(refs: NodeRef[], properties?: string[]): Promise<NodeMeasurement[]> {
    const props = properties?.length ? properties : DEFAULT_MEASURED_PROPERTIES
    const view = this.doc.defaultView
    return refs.map(({ nodeId }) => {
      const el = findByNodeId(this.doc, nodeId)
      if (!el || !this.doc.body || !view) return { nodeId, rect: null, computedStyle: {} }
      const rect = rectRelativeToBody(el, this.doc.body)
      const computed = view.getComputedStyle(el)
      const computedStyle: Record<string, string> = {}
      for (const prop of props) computedStyle[prop] = computed.getPropertyValue(prop)
      return { nodeId, rect, computedStyle }
    })
  }

  setAxes(axes: PreviewAxes): void {
    if (!this.doc.documentElement) return
    applyPreviewAxesToFrameDocument(this.doc.documentElement, axes, getColorSchemeCapability())
  }

  setInteractionMode(mode: 'design' | 'live'): void {
    if (mode === this.interactionMode) return
    this.interactionMode = mode
    if (mode === 'live') {
      this.hoverController?.dispose()
      this.hoverController = null
      this.scrollController?.dispose()
      this.scrollController = null
      this.animationController?.dispose()
      this.animationController = null
      return
    }
    this.hoverController ??= startHoverSuppression(
      this.doc,
      (owner) => CONTENT_STYLE_IDS.has(owner.getAttribute(OVERLAY_ID_ATTR) ?? owner.id),
    )
    this.scrollController ??= startScrollUnroll(this.doc, RUNTIME_SCROLL_UNROLL_STYLE_ID)
    this.animationController ??= startAnimationFreeze(this.doc, RUNTIME_ANIMATION_STYLE_ID)
  }

  on<E extends FrameRuntimeEvent['type']>(event: E, handler: (msg: Extract<FrameRuntimeEvent, { type: E }>) => void): Unsubscribe {
    if (event === 'pointer') return this.onPointer(handler as (msg: Extract<FrameRuntimeEvent, { type: 'pointer' }>) => void)
    if (event === 'text:edit') return this.onTextEdit(handler as (msg: Extract<FrameRuntimeEvent, { type: 'text:edit' }>) => void)
    return this.bus.on(event, handler)
  }

  private onPointer(handler: (msg: Extract<FrameRuntimeEvent, { type: 'pointer' }>) => void): Unsubscribe {
    const forward = (phase: 'down' | 'move' | 'up' | 'click', ev: PointerEvent | MouseEvent): void => {
      const target = ev.target instanceof Element ? ev.target : null
      const anchor = target?.closest(`[${NODE_ID_ATTR}]`) as Element | null
      const rect = anchor && this.doc.body ? rectRelativeToBody(anchor, this.doc.body) : null
      handler({
        type: 'pointer',
        phase,
        nodeId: anchor?.getAttribute(NODE_ID_ATTR) ?? null,
        rect,
        clientX: ev.clientX,
        clientY: ev.clientY,
        modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
      })
    }
    const onDown = (ev: PointerEvent) => forward('down', ev)
    const onMove = (ev: PointerEvent) => forward('move', ev)
    const onUp = (ev: PointerEvent) => forward('up', ev)
    const onClick = (ev: MouseEvent) => forward('click', ev)
    this.doc.addEventListener('pointerdown', onDown, true)
    this.doc.addEventListener('pointermove', onMove, true)
    this.doc.addEventListener('pointerup', onUp, true)
    this.doc.addEventListener('click', onClick, true)
    const unsubscribe = () => {
      this.doc.removeEventListener('pointerdown', onDown, true)
      this.doc.removeEventListener('pointermove', onMove, true)
      this.doc.removeEventListener('pointerup', onUp, true)
      this.doc.removeEventListener('click', onClick, true)
    }
    this.domUnsubscribes.push(unsubscribe)
    return unsubscribe
  }

  private onTextEdit(handler: (msg: Extract<FrameRuntimeEvent, { type: 'text:edit' }>) => void): Unsubscribe {
    const onInput = (ev: Event): void => {
      const target = ev.target instanceof Element ? ev.target : null
      if (!target?.hasAttribute('contenteditable')) return
      const nodeId = target.getAttribute(NODE_ID_ATTR)
      if (!nodeId) return
      handler({ type: 'text:edit', nodeId, text: target.textContent ?? '' })
    }
    this.doc.addEventListener('input', onInput, true)
    const unsubscribe = () => this.doc.removeEventListener('input', onInput, true)
    this.domUnsubscribes.push(unsubscribe)
    return unsubscribe
  }

  dispose(): void {
    this.disposed = true
    for (const unsubscribe of this.domUnsubscribes) unsubscribe()
    this.domUnsubscribes.length = 0
    this.layoutObserver?.disconnect()
    if (this.repositionRaf !== null) {
      const view = this.doc.defaultView
      ;(view?.cancelAnimationFrame?.bind(view) ?? cancelAnimationFrame)(this.repositionRaf)
    }

    this.hoverController?.dispose()
    this.scrollController?.dispose()
    this.animationController?.dispose()

    for (const el of this.overlayStyles.values()) el.remove()
    this.overlayStyles.clear()

    for (const ring of this.selectionRings.values()) ring.remove()
    this.selectionRings.clear()
    this.hoverRing?.remove()
    this.hoverRing = null

    this.doc.getElementById(SELECTION_STYLE_TAG_ID)?.remove()
    this.overlayRoot?.remove()
    this.overlayRoot = null
  }
}
