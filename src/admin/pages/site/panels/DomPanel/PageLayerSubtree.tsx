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

const NOOP_ROW_REGISTRY: DomPanelRowRegistry = {
  registerRow: () => {},
}

interface PageLayerSubtreeProps {
  page: Page
  editable?: boolean
}

export function PageLayerSubtree({ page, editable = true }: PageLayerSubtreeProps) {
  return (
    <DomTreeProvider>
      <DomPanelRowRegistryContext.Provider value={NOOP_ROW_REGISTRY}>
        <DomPanelDropStateContext.Provider value={IDLE_DROP_STATE}>
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
