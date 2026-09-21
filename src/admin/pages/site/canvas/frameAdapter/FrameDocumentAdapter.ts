/**
 * FrameDocumentAdapter — the ONE interface every canvas injector/hook drives
 * a design-canvas frame through, regardless of whether that frame's DOM is a
 * same-origin React portal (`PortalFrameAdapter`, Tier 0/1 — today's only
 * mode) or a cross-origin `postMessage` bridge to a real dev-server page
 * (`BridgeFrameAdapter`, Tier 2 — L4's `runtime.ts`).
 *
 * See `STATE.md`'s `live-05` entry for the full design rationale — this file
 * is deliberately just the contract + shared value types; `PortalFrameAdapter.ts`
 * and `BridgeFrameAdapter.ts` are the two implementations, and
 * `frameDocumentAdapter.contract.test.ts` (`src/__tests__/canvas/frameAdapter/`)
 * is the ONE test suite both are graded against.
 *
 * ## Why this exists (the canvas-engineer rule)
 *
 * "The canvas DOM must be the DOM React renders" — no wrapper element, no
 * scoping, no selector rewriting. A cross-origin bridge frame cannot be a
 * React portal by construction (it shares no JS heap with the parent), so
 * driving it needs a genuinely different mechanism underneath. Without this
 * interface, every injector/hook that currently takes a `Document` would
 * need its own `if (bridge) ... else ...` branch — the exact "band-aid
 * instead of fixing the abstraction" CLAUDE.md forbids. One interface, two
 * implementations, same call sites.
 *
 * ## Canonical ids only, on this side of the interface
 *
 * Every `NodeRef`/`nodeId` a caller passes to or receives from THIS
 * interface is a real, canonical tree/parser node id — never a bare Vite
 * `data-node-id` stamp. `BridgeFrameAdapter` is the ONLY file that ever sees
 * a bare stamp id (the wire vocabulary `messages.ts`/`runtime.ts` speak) —
 * it converts canonical <-> stamp+occurrenceIndex internally. See that
 * file's own doc for the conversion.
 */
import type { PreviewAxes } from '@core/studio-board'
import type { ElementSizePatch, RuntimeErrorKind } from '@core/studio-runtime'

/** A real, canonical parser/tree node id — the ONLY id shape any caller outside `frameAdapter/` ever sees. */
export interface NodeRef {
  nodeId: string
}

export interface NodeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NodeMeasurement {
  nodeId: string
  /** `null` when the node could not be found in the frame's current DOM (removed, not yet rendered, or unreachable cross-origin). */
  rect: NodeRect | null
  computedStyle: Record<string, string>
}

/**
 * `speed-06` — one node's drop-target geometry, as returned by
 * {@link FrameDocumentAdapter.measureDropCandidates}. `rect` is BODY-RELATIVE
 * — the same coordinate space `measure`/`resize:commit` already speak — not
 * the "frame-space" (viewport-local, unscaled) units `CanvasDropCandidate`
 * (`canvasDnd.ts`) uses; the caller (`canvasInsertionDragSnapshot.ts`)
 * converts through `bodyRelativeRectToFrameSpace` once it also has the
 * surface's `viewport`/`iframe`, which this interface deliberately knows
 * nothing about.
 */
export interface DropCandidateGeometry {
  nodeId: string
  rect: NodeRect
  axis: 'vertical' | 'horizontal'
  /** See `CanvasDropCandidate.reversed`'s doc (`canvasDnd.ts`). */
  reversed: boolean
}

/**
 * The four structural DOM mutations today's reorder-drag code already
 * performs immediately (same tick) for the paint-on-drop feel, ahead of the
 * HMR/writeback reconciliation that follows within milliseconds. Portal mode:
 * a close-to-direct pass-through onto the local `Document`. Bridge mode: the
 * four already-built `optimistic.*` wire messages.
 */
export interface OptimisticDomOps {
  insert(nodeId: string, parentNodeId: string, index: number, tagName: string, text?: string): void
  delete(nodeId: string): void
  move(nodeId: string, parentNodeId: string, index: number): void
  text(nodeId: string, text: string): void
  /**
   * `speed-01` — a properties-panel style commit or scrub preview, applied
   * as a stylesheet rule scoped to `nodeId`'s own element (never `nodeId`'s
   * inline `style`, which the eventual React re-render also writes — see
   * `@core/studio-runtime`'s `optimisticStyle.ts` for why an inline preview
   * can never be cleared safely). `patch` keys are CSS property names
   * (camelCase or kebab-case). `className`, present for a CLASS-target write,
   * is carried through to the wire but is INFORMATIONAL only — a bridge frame
   * cannot build a `.<className>` selector against it, because that name is
   * Studio's own parse of the class, not the (independently hashed) name
   * Vite's CSS-modules plugin gave it in the live frame's DOM; see
   * `optimisticStyle.ts`'s module doc, "ALWAYS element-scoped". Only the
   * edited node's own element previews instantly; other elements sharing the
   * class catch up on the next HMR update.
   */
  style(nodeId: string, patch: Record<string, string>, className?: string): void
  /** Drops whatever optimistic style rule is currently active for `nodeId` — a no-op when none is. */
  clearStyle(nodeId: string): void
}

export type FrameRuntimeEvent =
  | { type: 'ready' }
  | { type: 'hmr:before' }
  | { type: 'hmr:after' }
  | { type: 'frame:resize'; height: number }
  | {
      type: 'pointer'
      phase: 'down' | 'move' | 'up' | 'click'
      nodeId: string | null
      rect: NodeRect | null
      clientX: number
      clientY: number
      modifiers: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }
      /** `live-13` — `PointerEvent.button`/`buttons`/`pointerId`/`pointerType`, so a consumer can tell a pan press from a selection and replay one gesture coherently. */
      button: number
      buttons: number
      pointerId: number
      pointerType: string
    }
  /**
   * `live-13` — a finished drag on the frame's own resize handles changed the
   * node's size; `patch` is the inline-style write the consumer commits
   * through the store (only the dimensions the drag changed, as `px`
   * strings). Bridge mode only in practice: a portal frame's handles are the
   * parent's own React elements (`CanvasResizeHandles`) and commit directly.
   */
  | { type: 'resize:commit'; nodeId: string; patch: ElementSizePatch }
  /** `live-12` — a design-mode wheel gesture inside a bridge frame, in frame-local client pixels; the parent re-dispatches it on the iframe element. */
  | {
      type: 'wheel'
      deltaX: number
      deltaY: number
      deltaMode: number
      clientX: number
      clientY: number
      modifiers: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }
    }
  /** `live-18` — a double-click on a text-bearing node inside the frame; the parent decides allowed/refused via `startTextEdit`. */
  | { type: 'text:editStart'; nodeId: string }
  /** `live-18` — Enter (no Shift) or blur ended the session with this final text. */
  | { type: 'text:commit'; nodeId: string; text: string }
  /** `live-18` — Escape, or an HMR update landing mid-edit, ended the session with no write. */
  | { type: 'text:cancel'; nodeId: string }
  /**
   * Z5 — the frame's own runtime reported a failure (an uncaught exception, an
   * unhandled rejection, a `console.error`, a resource that would not load, or
   * a failed `fetch`). Bridge mode only in practice: a portal frame's
   * equivalent taps are installed by `CanvasDiagnosticsInjector` INSIDE the
   * frame, which already has the `Window` and does not need an adapter event
   * to carry the finding back out. `PortalFrameAdapter` therefore never emits
   * this — honestly, rather than by faking a second collection path that would
   * double-count every portal diagnostic.
   */
  | { type: 'error'; kind: RuntimeErrorKind; message: string; stack?: string; source?: string }

export type Unsubscribe = () => void

/**
 * The interface. 7 methods (the plan's own literal sketch is corrected from
 * 6 — see `STATE.md`'s `live-05` entry, "The plan's literal interface is
 * incomplete") plus a symmetric `dispose()`.
 */
export interface FrameDocumentAdapter {
  /** Mounts/updates a managed `<style id="...">`-equivalent with `css` — the generic mechanism every CSS-text injector (`ClassStyleInjector`, `EditorChromeInjector`, ...) now goes through instead of a direct `targetDocument.head.appendChild`. */
  applyOverlay(id: string, css: string): void
  removeOverlay(id: string): void
  /** Shows/positions the selection ring(s) for exactly these nodes; an empty array clears selection. */
  select(refs: NodeRef[]): void
  /** Shows/positions the hover ring for one node; `null` clears it. */
  hover(ref: NodeRef | null): void
  /** Rects + a bounded set of computed-style properties. Portal mode resolves synchronously (wrapped in a resolved `Promise` so callers never branch on adapter kind); bridge mode is genuinely async (a real `postMessage` round trip, bounded by a timeout). */
  measure(refs: NodeRef[], properties?: string[]): Promise<NodeMeasurement[]>
  /**
   * `speed-06` — every node currently in the frame's document, with its
   * drop-target geometry, for a per-drag candidate snapshot
   * (`canvasInsertionDragSnapshot.ts`). Same synchronous-vs-real-round-trip
   * split as `measure`. Called once per drag and again on that surface's own
   * refresh triggers — NEVER per pointer move, which is the whole point.
   */
  measureDropCandidates(): Promise<DropCandidateGeometry[]>
  /** Applies the board's render-time preview axes to the frame's own document root. */
  setAxes(axes: PreviewAxes): void
  /**
   * Which `CanvasHoverSuppressionInjector`/`CanvasScrollUnrollInjector`/
   * `CanvasAnimationInjector` behaviors run at all — these three are
   * DOM-observer-driven controllers, not static CSS, so they cannot go
   * through `applyOverlay`. NOT the same axis as `IframeFrameSurface`'s
   * existing `interaction: 'canvas' | 'live' | 'capture'` prop — see
   * `STATE.md`'s `live-05` entry, "two corrections", for why the two must
   * not share a name. Map `interaction === 'live' ? 'live' : 'design'`.
   */
  setInteractionMode(mode: 'design' | 'live'): void
  /**
   * `live-13` — which node carries resize handles (`null` clears them), and
   * whether `K4`'s scale tool is armed. The caller has already applied the
   * module policy (`resizeOffer.ts`); the frame applies the geometric one
   * (an element whose computed display ignores a size gets no handles).
   * Portal mode draws its handles as the parent's own React elements
   * (`CanvasResizeHandles`) and ignores this call — see `PortalFrameAdapter`.
   */
  setResizeTarget(ref: NodeRef | null, options: { proportional: boolean }): void
  /**
   * `live-18` — replies to the frame's `text:editStart`: whether `nodeId`
   * may be edited inline (the same predicate the portal editor's
   * `startInlineEdit` applies) and, when it may, the node's CURRENT text to
   * seed the frame's `contentEditable` with. Portal mode's inline editor
   * owns its whole session directly inside `NodeRenderer`, with no adapter
   * round trip — a documented no-op there.
   */
  startTextEdit(nodeId: string, allowed: boolean, text?: string): void
  optimistic: OptimisticDomOps
  /** Subscribes to a runtime event. Portal mode: real DOM/synthetic events (`ready` fires once, synchronously — a portal frame has no real "boot" moment). Bridge mode: the matching inbound `postMessage` from `runtime.ts`. */
  on<E extends FrameRuntimeEvent['type']>(event: E, handler: (msg: Extract<FrameRuntimeEvent, { type: E }>) => void): Unsubscribe
  /** Tears down every listener, observer, and DOM node this adapter instance created. Symmetric with construction — every adapter instance is created/torn down with its iframe's own lifecycle. */
  dispose(): void
}
