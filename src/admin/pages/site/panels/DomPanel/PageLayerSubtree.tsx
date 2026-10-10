/**
 * PageLayerSubtree — a single page's node tree, rendered inside the Studio
 * Pages/Layers list for a page row (`StudioPagesTree`).
 *
 * Mirrors the tree DomPanel renders for the active page (same rows, same
 * expand/collapse/rename/select/context-menu behavior) but for a page that is
 * not necessarily the active one:
 *   - Resolves nodes against THIS page via `DomTreePageContext`
 *     (`selectCanvasPageFor`), not the active canvas document.
 *   - Owns its own `DomTreeProvider` (a fresh `ExpansionStore`) so expanding
 *     nodes in one page's rows never affects another page's — this is local
 *     UI state, never persisted.
 *   - Stubs the two DnD contexts with idle values — the row registry's default
 *     throws, and there is deliberately no `<DndContext>` ancestor here.
 *     Without one, dnd-kit's `useDraggable` has no activators to attach (see
 *     `@dnd-kit/core`'s `defaultInternalContext`), so drag gestures are
 *     inert — reordering only works on the ACTIVE page's tree, which
 *     `DomPanel` renders in full (real `DndContext`) when its row is the
 *     expanded one. This matches the "preserve DnD for the active page"
 *     requirement without a second DnD wiring path.
 *   - Passes `revealSelection={false}`: a background page must never scroll
 *     the shared page list to follow the canvas selection.
 *
 * Cost on a many-frame board: this used to be "a full tree per board frame".
 * It is not any more, and NOT because of an extra collapse step — `LayerRowList`
 * windows against `StudioPagesTree`'s shared scroller, so a page whose subtree
 * has scrolled off screen mounts zero rows and stands in for itself with one
 * spacer block. Expanding a page still shows its layers on the first click.
 *
 * Node interactions (select / rename / delete / context menu) all route
 * through store actions that act on `activePageId`, not on whichever page's
 * rows are visually on screen. The caller (`StudioPagesTree`) MUST activate
 * this page (`openPageInCanvas`) on first interaction — via a pointerdown
 * CAPTURE handler, same pattern as `BoardFramesLayer`'s frame activation —
 * so those actions land on the right page's tree.
 */
import { useState, useSyncExternalStore } from 'react'
import type { Page } from '@core/page-tree'
import { LayerRowList } from './LayerRowList'
import { DomTreeProvider } from './DomTreeProvider'
import { DomTreePageContext } from './DomTreeContext'
import {
  DomPanelDropStateContext,
  DomPanelRowRegistryContext,
  IDLE_DROP_STATE,
  type DomPanelRowRegistry,
} from './DomPanelDndContext'
import { useLayerDragBridge } from './LayerDragBridge'

const NOOP_ROW_REGISTRY: DomPanelRowRegistry = {
  registerRow: () => {},
}

function noopSubscribe(): () => void {
  return () => {}
}

interface PageLayerSubtreeProps {
  /** Identity only — the rows resolve their nodes through `DomTreePageContext`. */
  page: Pick<Page, 'id' | 'title' | 'rootNodeId'>
  editable?: boolean
}

export function PageLayerSubtree({ page, editable = true }: PageLayerSubtreeProps) {
  const bridge = useLayerDragBridge()
  const pageId = page.id
  // Rows still cannot START a drag here (no `DndContext`), but a drag started in
  // the active page's tree can END on them: they hand their elements to the
  // bridge and paint the active panel's drop state.
  const [rowRegistry] = useState<DomPanelRowRegistry>(() =>
    bridge
      ? { registerRow: (nodeId, element) => bridge.registerForeignRow(pageId, nodeId, element) }
      : NOOP_ROW_REGISTRY,
  )
  const dropState = useSyncExternalStore(
    bridge ? bridge.subscribe : noopSubscribe,
    bridge ? bridge.getDropState : getIdleDropState,
    getIdleDropState,
  )
  return (
    <DomTreeProvider>
      <DomPanelRowRegistryContext.Provider value={rowRegistry}>
        <DomPanelDropStateContext.Provider value={dropState}>
          <DomTreePageContext.Provider value={page.id}>
            <LayerRowList
              ariaLabel={`${page.title} element tree`}
              rootNodeIds={[page.rootNodeId]}
              alwaysExpandedId={page.rootNodeId}
              editable={editable}
              revealSelection={false}
            />
          </DomTreePageContext.Provider>
        </DomPanelDropStateContext.Provider>
      </DomPanelRowRegistryContext.Provider>
    </DomTreeProvider>
  )
}

function getIdleDropState() {
  return IDLE_DROP_STATE
}
