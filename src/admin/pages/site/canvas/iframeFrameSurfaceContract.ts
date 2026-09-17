/**
 * iframeFrameSurfaceContract — what a caller hands a canvas frame surface,
 * and what it hands back.
 *
 * Split out of `IframeFrameSurface.tsx` when that file passed the 700-line
 * ceiling. The seam is the obvious one and the props carry most of the
 * prose: every field here is a documented decision about the canvas frame
 * boundary — which document a subtree is portaled into, which mode a frame
 * is in, which of the handle's fields are migrating to the adapter — and
 * none of it is implementation.
 *
 * `IframeFrameSurface.tsx` re-exports `IframeFrameSurfaceHandle`, which is
 * what every consumer already imports from there.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { PreviewAxes } from '@core/studio-board'
import type { FrameDocumentAdapter } from './frameAdapter/FrameDocumentAdapter'
import type { LiveFrameSource } from './resolveLiveFrameSrc'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import type { IframeInteraction } from './iframeBodyReset'

export interface IframeFrameSurfaceProps {
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
   * How this frame's DOM is reached (`live-05`, STATE.md). `'portal'`
   * (Tier 0/1, same-origin React portal — today's ONLY real mode) is the
   * default and is entirely inert for every existing Tier 0/1 call site:
   * omitting this prop reproduces today's behavior exactly, byte-for-byte.
   * `'bridge'` (Tier 2, cross-origin `postMessage` to a real dev-server
   * page) requires `liveFrame` and constructs a `BridgeFrameAdapter`
   * instead of a `PortalFrameAdapter` — the fork itself is real, committed,
   * tested code, and `liveFrame.liveOrigin`/`screenKey`/`axes` now resolve
   * to a genuinely working URL (`resolveLiveFrameSrc.ts`) now that L6's
   * `/__screen/<key>` route exists in the generated shell and Studio's own
   * live-origin proxy forwards to it correctly (`STATE.md`'s `live-06`).
   * What is still missing is the CALLER: nothing in production yet
   * constructs a `LiveFrameSource` and flips a real board frame's
   * `documentMode` to `'bridge'` — that decision (which frames, when, gated
   * on what) is separate, not-yet-scoped work. No injector subtree is
   * portaled into a bridge-mode frame — see the render fork below.
   */
  documentMode?: 'portal' | 'bridge'
  /** Bridge-mode-only inputs. Required (and only read) when `documentMode === 'bridge'`. */
  liveFrame?: LiveFrameSource
  /**
   * S1 — called with `true` once the staged node tree (mount stage 3, see this
   * module's header) has committed into the iframe body, and with `false`
   * while there is nothing in it. `BoardFrameView` keeps its frozen poster on
   * top of the iframe until this turns true, so a frame entering the viewport
   * never flashes an empty document.
   *
   * The SAME state also lands on the iframe element as
   * `data-studio-canvas-content-ready`, for callers that hold only DOM
   * (`renderEvidence.ts`'s frame selection). Optional here precisely because
   * that stamp is unconditional — a caller that needs readiness but not a
   * React callback reads the attribute instead of inventing a second notion.
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
  /**
   * The frame's `FrameDocumentAdapter` (`live-05`, STATE.md) — `null` until
   * the iframe document exists. `contentDocument`/`contentBody`/
   * `contentOverlayRoot` above are migrating to this one field batch by
   * batch; both coexist until every consumer has moved over.
   */
  adapter: FrameDocumentAdapter | null
}
