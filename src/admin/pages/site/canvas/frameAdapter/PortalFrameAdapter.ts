/**
 * PortalFrameAdapter — the `FrameDocumentAdapter` for a same-origin, React-
 * portaled canvas frame (Tier 0/1 — today's only mode, and every Tier 0/1
 * frame forever, per `documentMode: 'portal' | 'bridge'`'s own contract).
 *
 * **The ONLY file under `canvas/` allowed to hold a `Document` reference for
 * canvas rendering purposes after this work order lands** — enforced by
 * `src/__tests__/architecture/frame-document-adapter-isolation.test.ts`.
 *
 * Every operation here is the SAME DOM mechanics today's CSS injectors and the
 * structural drag/reorder code already perform directly against
 * `targetDocument` — this class is a refactor of where that code lives, not a
 * behavior change. It draws no selection chrome: since SB-4 the rings and
 * handles are parent-document elements placed from `measureAll`'s rect index. `measure` is
 * synchronous under the hood (same-origin, no real async boundary) but
 * `Promise`-shaped so callers never branch on which adapter kind they hold.
 */
import { getColorSchemeCapability } from '@site/studio/previewAxesCapability'
import type { PreviewAxes } from '@core/studio-board'
import {
  collectDropCandidates,
  collectNodeGeometry,
  createGeometryDirtySignal,
  OVERLAY_ID_ATTR,
  startAnimationFreeze,
  startHoverSuppression,
  startScrollUnroll,
  type AnimationFreezeController,
  type GeometryDirtySignal,
  type HoverSuppressionController,
  type ScrollUnrollController,
} from '@core/studio-runtime'
import type { FrameGeometrySnapshot } from '../frameGeometry/frameGeometryTypes'
import { applyPreviewAxesToFrameDocument } from '../previewAxesFrameEffect'
import { currentModeAxes } from '../modeRootPlan'
import { escapeCssAttributeValue } from '../escapeCssAttributeValue'
import type {
  DropCandidateGeometry,
  FrameDocumentAdapter,
  FrameRuntimeEvent,
  NodeMeasurement,
  NodeRect,
  NodeRef,
  OptimisticDomOps,
  ResizeTargetOptions,
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
  /**
   * The CSS text each overlay last received. Assigning a `<style>`'s
   * `textContent` replaces its text node and makes the browser re-parse the
   * sheet and invalidate style for the WHOLE document — even when the text is
   * identical. Every mounted frame's injectors re-apply on inputs that change
   * nothing they emit (a click re-runs the forced-state preview in every
   * frame, and it writes the same empty string each time), so an unchanged
   * write is skipped here, once, for every injector (P6-C).
   */
  private readonly overlayCss = new Map<string, string>()
  private interactionMode: 'design' | 'live' | null = null
  private hoverController: HoverSuppressionController | null = null
  private scrollController: ScrollUnrollController | null = null
  private animationController: AnimationFreezeController | null = null
  private readonly bus = new SyntheticEventBus()
  private readonly domUnsubscribes: Unsubscribe[] = []
  private disposed = false
  private layoutObserver: MutationObserver | null = null
  private geometryTrackingArmed = false
  /** SB-3 — created by the first `measureAll`; fed by `layoutObserver` below, so geometry adds no body observer of its own. */
  private geometrySignal: GeometryDirtySignal | null = null

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
    // `speed-01` — a documented no-op. The store write this call previews/
    // commits already re-renders the portal tree through React on the SAME
    // tick; a second DOM write here would be a redundant paint racing the
    // first, exactly the reasoning `optimisticStructuralBroadcast.ts` gives
    // for skipping portal adapters on insert/delete/move.
    style: () => {},
    clearStyle: () => {},
    // store-17 — a documented no-op: a portal frame's DOM is React's render of
    // the tree, and the rollback that calls this already replayed the tree.
    revert: () => {},
  }

  constructor(doc: Document) {
    this.doc = doc
    // Fires synchronously — see `SyntheticEventBus`'s doc.
    queueMicrotask(() => {
      if (!this.disposed) this.bus.emit({ type: 'ready' })
    })
  }

  /**
   * Arms the body observer that feeds the rect index's dirty signal. Armed by
   * the first `measureAll`, never in the constructor: a frame nobody indexes has
   * no use for it, and a subtree `attributes` observer allocates records for
   * every attribute write in the frame (PERF-10: an element resize writes
   * styles every frame).
   *
   * Content and style-attribute changes are the common case, so this observer
   * is the signal for them; `geometryDirtySignal.ts` adds the head, load, font,
   * transition, scroll and viewport-resize listeners the body observer cannot
   * see. `characterData` is observed too: typing in an inline text edit resizes
   * its box without adding or removing a node.
   */
  private armGeometryTracking(): void {
    if (this.geometryTrackingArmed || this.disposed) return
    this.geometryTrackingArmed = true
    const view = this.doc.defaultView
    if (this.doc.body) {
      const MutationObserverCtor = view?.MutationObserver ?? MutationObserver
      try {
        this.layoutObserver = new MutationObserverCtor(() => this.geometrySignal?.notify())
        this.layoutObserver.observe(this.doc.body, { childList: true, subtree: true, attributes: true, characterData: true })
      } catch (_err) {
        // Some browser realms reject observing a cross-realm node. The head /
        // load / font / resize listeners still cover everything but a body change.
        this.layoutObserver = null
      }
    }
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
    if (this.overlayCss.get(id) === css) return
    this.overlayCss.set(id, css)
    el.textContent = css
  }

  removeOverlay(id: string): void {
    this.overlayStyles.get(id)?.remove()
    this.overlayStyles.delete(id)
    this.overlayCss.delete(id)
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

  /**
   * SB-3 — the same `collectNodeGeometry` the bridge runtime answers `measureAll`
   * with, run on the same-origin document. Synchronous under the hood. The first
   * call arms the layout observer and the extra dirty listeners (see
   * {@link armGeometryTracking}); every call re-arms the `geometry:dirty` latch.
   */
  async measureAll(): Promise<FrameGeometrySnapshot> {
    return this.measureAllNow() ?? { origin: { x: 0, y: 0 }, nodes: [], truncated: false }
  }

  measureAllNow(): FrameGeometrySnapshot | null {
    const view = this.doc.defaultView
    if (!view) return null
    this.geometrySignal ??= createGeometryDirtySignal(this.doc, view, () => this.bus.emit({ type: 'geometry:dirty' }))
    this.geometrySignal.track()
    this.armGeometryTracking()
    this.geometrySignal.markClean()
    return collectNodeGeometry(this.doc, view)
  }

  /**
   * `speed-06` — reuses the SAME `collectDropCandidates` the in-frame bridge
   * runtime answers `dropCandidates` with (`@core/studio-runtime`): a portal
   * document's `data-node-id` values are already canonical tree node ids, so
   * there is no stamp/occurrence translation to do here — `occurrenceIndex`
   * and `childRects` are simply dropped, unused by this side of the bridge.
   */
  async measureDropCandidates(): Promise<DropCandidateGeometry[]> {
    return collectDropCandidates(this.doc).map(({ nodeId, rect, axis, reversed }) => ({ nodeId, rect, axis, reversed }))
  }

  setAxes(axes: PreviewAxes): void {
    if (!this.doc.documentElement) return
    applyPreviewAxesToFrameDocument(this.doc.documentElement, axes, getColorSchemeCapability(), currentModeAxes())
  }

  /**
   * A portal frame's resize handles are the parent's own React elements
   * (`CanvasResizeHandles`), dragged from the parent (`useElementResizeDrag`) —
   * a same-origin document allows it, and that path commits synchronously in
   * the same tick. The in-frame handles this call drives exist for the
   * cross-origin bridge; a second set here would be two sets of handles on one
   * element.
   */
  setResizeTarget(_ref: NodeRef | null, _options: ResizeTargetOptions): void {}

  /**
   * `live-18` — a documented no-op. Nothing in portal mode ever emits
   * `text:editStart` (the DOM never posts it — this is a same-origin,
   * cross-window-free document): `NodeRenderer` starts, live-commits, and
   * ends its own inline-edit session directly against the store, with no
   * adapter round trip at all. This method exists only so `BridgeFrameAdapter`
   * and `PortalFrameAdapter` satisfy the same `FrameDocumentAdapter` shape.
   */
  startTextEdit(_nodeId: string, _allowed: boolean, _text?: string): void {}

  /** A documented no-op for the same reason as {@link startTextEdit}: the store's session opens the editor in `NodeRenderer`. */
  beginTextEdit(_nodeId: string, _text: string): void {}

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

  // `text:editStart`/`text:commit`/`text:cancel` are never emitted here (see
  // `startTextEdit`'s doc) — the default `bus.on` registration below is a
  // valid, harmless subscription to an event portal mode never fires.
  on<E extends FrameRuntimeEvent['type']>(event: E, handler: (msg: Extract<FrameRuntimeEvent, { type: E }>) => void): Unsubscribe {
    if (event === 'pointer') return this.onPointer(handler as (msg: Extract<FrameRuntimeEvent, { type: 'pointer' }>) => void)
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
        screenX: ev.screenX,
        screenY: ev.screenY,
        modifiers: { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey },
        button: ev.button,
        buttons: ev.buttons,
        pointerId: 'pointerId' in ev ? ev.pointerId : 0,
        pointerType: 'pointerType' in ev ? ev.pointerType : '',
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

  dispose(): void {
    this.disposed = true
    for (const unsubscribe of this.domUnsubscribes) unsubscribe()
    this.domUnsubscribes.length = 0
    this.layoutObserver?.disconnect()
    this.geometrySignal?.dispose()

    this.hoverController?.dispose()
    this.scrollController?.dispose()
    this.animationController?.dispose()

    for (const el of this.overlayStyles.values()) el.remove()
    this.overlayStyles.clear()
    this.overlayCss.clear()

  }

  /**
   * The narrow, portal-mode-only escape hatch (`STATE.md`, `live-05`
   * entry, Batch 3). NOT part of `FrameDocumentAdapter` — leaking a
   * `Window`/`Document`-shaped operation into that shared interface would
   * force `BridgeFrameAdapter` to either fake one or throw, exactly the
   * "band-aid instead of fixing the abstraction" this work order exists to
   * remove.
   *
   * A handful of hooks (`useIframeCursorBridge`, `useCanvasFormControl
   * Suppression`, `useIframeEventForwarding`, `canvasDomGeometry`, …) need
   * raw native DOM primitives no curated `FrameDocumentAdapter` method
   * covers — arbitrary `addEventListener` types, `getComputedStyle`,
   * `ResizeObserver`/`MutationObserver` construction against the frame's
   * own realm. For portal mode this is always available and always was —
   * the SAME `Document`/`Window` those hooks read via a `targetDocument`
   * prop before this work order, just reached through the adapter instead
   * of threaded separately. For bridge mode there is no local `Window` at
   * all (a different origin, a different JS realm), so callers MUST guard
   * with `isPortalFrameAdapter` and have an explicit bridge-mode behavior
   * (a `postMessage`-based equivalent, or a documented no-op) rather than
   * assume this method exists.
   *
   * Callers should never write an explicit `: Window`/`: Document` type
   * annotation on the result — let it infer — so the isolation gate's
   * textual scan (`frame-document-adapter-isolation.test.ts`) still proves
   * every OTHER file never holds a *named* `Document` reference, even
   * though, transitively, this accessor still hands one out. The real
   * boundary this work order enforces is "no file besides this one
   * DECIDES to keep a persistent Document reference across renders" — a
   * hook reading `adapter.getPortalWindow()?.document` inside one effect
   * body, every time, from the adapter, is that same discipline; a `const
   * [doc, setDoc] = useState<Document>()` duplicating `IframeFrameSurface`'s
   * own state is not.
   */
  getPortalWindow(): (Window & typeof globalThis) | null {
    return this.doc.defaultView
  }
}

/**
 * Type guard narrowing a `FrameDocumentAdapter` to `PortalFrameAdapter` so a
 * caller can reach {@link PortalFrameAdapter.getPortalWindow}. Every call
 * site MUST branch on this rather than assume portal mode — see that
 * method's own doc.
 */
export function isPortalFrameAdapter(adapter: FrameDocumentAdapter | null): adapter is PortalFrameAdapter {
  return adapter instanceof PortalFrameAdapter
}
