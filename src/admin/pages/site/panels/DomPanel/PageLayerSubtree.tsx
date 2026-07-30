/**
 * PageLayerSubtree — a single page's node tree, rendered inside the Studio
 * Pages/Layers list for a page row (`StudioPagesTree`).
 *
 * Mirrors the tree DomPanel renders for the active page (same `TreeNode`,
 * same expand/collapse/rename/select/context-menu behavior) but for a page
 * that is not necessarily the active one:
 *   - Resolves nodes against THIS page via `DomTreePageContext`
 *     (`selectCanvasPageFor`), not the active canvas document.
 *   - Owns its own `DomTreeProvider` (a fresh `ExpansionStore`) so expanding
 *     nodes in one page's rows never affects another page's — this is local
 *     UI state, never persisted.
 *   - Stubs `DomPanelDndContext` with a no-op value — TreeNode's
 *     `registerRow` call needs SOME provider (the context's default throws),
 *     but there is deliberately no `<DndContext>` ancestor here. Without one,
 *     dnd-kit's `useDraggable` has no activators to attach (see
 *     `@dnd-kit/core`'s `defaultInternalContext`), so drag gestures are
 *     inert — reordering only works on the ACTIVE page's tree, which
 *     `DomPanel` renders in full (real `DndContext`) when its row is the
 *     expanded one. This matches the "preserve DnD for the active page"
 *     requirement without a second DnD wiring path.
 *
 * Node interactions (select / rename / delete / context menu) all route
 * through store actions that act on `activePageId`, not on whichever page's
 * rows are visually on screen. The caller (`StudioPagesTree`) MUST activate
 * this page (`openPageInCanvas`) on first interaction — via a pointerdown
 * CAPTURE handler, same pattern as `BoardFramesLayer`'s frame activation —
 * so those actions land on the right page's tree.
 */
import type { Page } from '@core/page-tree'
import { TreeContainer } from '@site/ui/Tree'
import { TreeNode } from './TreeNode'
import { DomTreeProvider } from './DomTreeProvider'
import { DomTreePageContext } from './DomTreeContext'
import { DomPanelDndContext, type DomPanelDndContextValue } from './DomPanelDndContext'

const NOOP_DND_CONTEXT: DomPanelDndContextValue = {
  activeId: null,
  target: null,
  invalidOverId: null,
  registerRow: () => {},
}

interface PageLayerSubtreeProps {
  page: Page
  editable?: boolean
}

export function PageLayerSubtree({ page, editable = true }: PageLayerSubtreeProps) {
  return (
    <DomTreeProvider>
      <DomPanelDndContext.Provider value={NOOP_DND_CONTEXT}>
        <DomTreePageContext.Provider value={page.id}>
          <TreeContainer
            ariaLabel={`${page.title} element tree`}
            data-studio-layer-tree="true"
          >
            <TreeNode nodeId={page.rootNodeId} depth={0} editable={editable} />
          </TreeContainer>
        </DomTreePageContext.Provider>
      </DomPanelDndContext.Provider>
    </DomTreeProvider>
  )
}
