/**
 * canvasInsertionDragSnapshot — `speed-06`: the drop-candidate geometry an
 * insertion drag (an asset-card drag, the notch's own primitive drag)
 * resolves against, measured ONCE per drag instead of on every pointer move.
 *
 * Before this, `useCanvasInsertionDrag` called `resolveCanvasPointerInsertionDrop`
 * — a full `querySelectorAll` plus one `getBoundingClientRect`/
 * `getComputedStyle` per candidate — on every raw `pointermove`, and had no
 * bridge-mode path at all: `resolvePortalDocument` returns `null` for a Tier
 * 2 frame, so the scan silently found zero candidates and every live-frame
 * drop fell back to "page root". This module asks a surface's own
 * `FrameDocumentAdapter.measureDropCandidates()` once, up front, and again
 * only on the handful of things that can actually change candidate geometry
 * (`hmr:after`, `frame:resize`, a portal frame's own scroll) — never per move.
 *
 * ## Keyed per iframe, lazily, not eagerly over `listCanvasDropSurfaces()`
 *
 * `useCanvasInsertionDrag` locates the frame under the pointer the same way
 * it always has — `findCanvasViewportAtPoint`, a handful of rect-containment
 * checks over the currently mounted `[data-breakpoint-id]` viewports, which
 * was never the expensive part. The snapshot is built LAZILY, the first time
 * the drag actually visits a given iframe, and kept for the rest of the drag
 * (refreshed only by the triggers above). A drag that never leaves the frame
 * it started over therefore measures exactly once.
 *
 * ## The no-adapter fallback
 *
 * A viewport with no adapter registered for its iframe (no real canvas frame
 * ever leaves this state in production — `IframeFrameSurface` always
 * registers one — but a hand-built test fixture, or a viewport with no
 * `<iframe>` at all, legitimately can) falls back to the pre-existing
 * synchronous `measureCanvasDropCandidates` scan, resolved immediately rather
 * than through a `Promise` tick. This is not a workaround for a gap in the
 * new mechanism — it is the same "no candidates to be had" answer
 * `measureCanvasDropCandidates` itself already gives an iframe with no
 * `resolvePortalDocument` and no registered adapter.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import type { CanvasDropCandidate } from './canvasDnd'
import {
  bodyRelativeRectToFrameSpace,
  buildDepthMap,
  measureCanvasDropCandidates,
} from './canvasDomGeometry'
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { resolvePortalDocument } from './frameAdapter/resolvePortalDocument'

interface SnapshotEntry {
  /** `null` while the async measurement (a bridge round trip) is in flight — resolution treats this as "no candidates yet", exactly like the pointer being outside every frame. */
  candidates: CanvasDropCandidate[] | null
}

/** One drag's worth of per-iframe candidate snapshots, plus the refresh subscriptions installed for the surfaces it has actually visited. */
export interface InsertionDragSnapshotSession {
  /** Candidates for `viewport`'s frame, refreshing the cache lazily. `iframe` is `viewport`'s own, resolved by the caller via the same `querySelector('iframe')` `resolveCanvasPointerInsertionDrop` already used. */
  candidatesFor(viewport: HTMLElement, iframe: HTMLIFrameElement | null, tree: NodeTree<PageNode>): CanvasDropCandidate[]
  /** Tears down every refresh subscription this session installed. */
  dispose(): void
}

function measureViaAdapter(
  viewport: HTMLElement,
  iframe: HTMLIFrameElement,
  tree: NodeTree<PageNode>,
): Promise<CanvasDropCandidate[]> {
  const adapter = listFrameAdapters().get(iframe)
  if (!adapter) return Promise.resolve(measureCanvasDropCandidates(viewport, tree, iframe))
  return adapter
    .measureDropCandidates()
    .then((geometries) => {
      const depths = buildDepthMap(tree)
      const candidates: CanvasDropCandidate[] = []
      for (const geometry of geometries) {
        const node = tree.nodes[geometry.nodeId]
        if (!node || node.hidden) continue
        candidates.push({
          nodeId: geometry.nodeId,
          depth: depths.get(geometry.nodeId) ?? 0,
          rect: bodyRelativeRectToFrameSpace(viewport, iframe, geometry.rect),
          axis: geometry.axis,
          reversed: geometry.reversed,
        })
      }
      return candidates
    })
    .catch((err: unknown) => {
      // A frame mid-reload (bridge) does not answer — same posture
      // `useBridgeSelectionChrome` takes for a `measure` timeout: this ONE
      // refresh comes back empty rather than failing the whole drag: the
      // next trigger (or the next drag) re-asks.
      console.warn('[canvasInsertionDragSnapshot] measureDropCandidates failed:', err)
      return []
    })
}

export function beginInsertionDragSnapshotSession(): InsertionDragSnapshotSession {
  const entries = new Map<HTMLIFrameElement, SnapshotEntry>()
  const unsubscribes: (() => void)[] = []
  const scrollCleanups = new Map<HTMLIFrameElement, () => void>()

  function refresh(viewport: HTMLElement, iframe: HTMLIFrameElement, tree: NodeTree<PageNode>): void {
    void measureViaAdapter(viewport, iframe, tree).then((candidates) => {
      entries.set(iframe, { candidates })
    })
  }

  function ensure(viewport: HTMLElement, iframe: HTMLIFrameElement, tree: NodeTree<PageNode>): void {
    if (entries.has(iframe)) return
    entries.set(iframe, { candidates: null })
    refresh(viewport, iframe, tree)

    const adapter = listFrameAdapters().get(iframe)
    if (adapter) {
      unsubscribes.push(adapter.on('hmr:after', () => refresh(viewport, iframe, tree)))
      unsubscribes.push(adapter.on('frame:resize', () => refresh(viewport, iframe, tree)))
    }
    // A portal frame's own document can scroll an internal container without
    // resizing the frame or triggering an HMR round trip — the one refresh
    // trigger with no bridge-mode equivalent (a cross-origin document's
    // scroll is unobservable from the parent without a new wire message,
    // deliberately out of this change's scope; see `speed-06`'s handoff).
    const portalDoc = resolvePortalDocument(iframe)
    if (portalDoc) {
      const onScroll = () => refresh(viewport, iframe, tree)
      portalDoc.addEventListener('scroll', onScroll, true)
      scrollCleanups.set(iframe, () => portalDoc.removeEventListener('scroll', onScroll, true))
    }
  }

  return {
    candidatesFor(viewport, iframe, tree) {
      if (!iframe) return measureCanvasDropCandidates(viewport, tree, iframe)
      ensure(viewport, iframe, tree)
      return entries.get(iframe)?.candidates ?? []
    },
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe()
      unsubscribes.length = 0
      for (const cleanup of scrollCleanups.values()) cleanup()
      scrollCleanups.clear()
      entries.clear()
    },
  }
}
