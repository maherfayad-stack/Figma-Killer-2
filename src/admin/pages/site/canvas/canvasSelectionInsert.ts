/**
 * canvasSelectionInsert — where a gesture WITHOUT a pointer position puts
 * what it adds, and the image insert it then makes. Two callers, one rule:
 *
 *   - ⇧K "Insert image…" (`canvasImagePicker.ts`, IX-img);
 *   - ⌘V of an image or an SVG from the OS clipboard (`canvasPaste.ts`, P5-A).
 *
 * A drop has a pointer, so it has a position. These do not, so the SELECTION
 * is the position, the way ⌘V already places pasted layers (`K7`): right AFTER
 * the selected layer, inside its parent. With nothing selected, the new
 * elements are appended to the active frame's page root (which
 * `planSourceInsert` resolves to the page's own root element). No active
 * frame means nowhere to write, and the gesture says so.
 *
 * The images go through exactly the write an OS file drop makes
 * (`dropImagesIntoPage`, P5-B): the asset landing, one insert of N siblings,
 * one undo step, the ghost while the bytes upload, the intrinsic size clamped
 * to the container. There is no second image pipeline.
 */
import type { NodeTree, PageNode } from '@core/page-tree'
import { resolveSourceContainer } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { findRenderedCanvasElements } from './canvasNodeLookup'
import { measureDropContainer } from './canvasImageDropPlacement'
import { paintCanvasUploadProgress } from './canvasUploadProgress'

/** Where a pointer-less insert lands, or why it cannot. */
export type SelectionInsertTarget =
  | { ok: true; pageId: string; parentId: string; index: number }
  | { ok: false; message: string }

/**
 * Beside the selected layer (after it, in its parent), else appended to the
 * page root. `selectedNodeId` must belong to `tree` to count — a selection in
 * another frame does not name a position in this one.
 */
export function resolveSelectionInsertTarget(
  pageId: string | null,
  tree: NodeTree<PageNode> | null,
  selectedNodeId: string | null,
): SelectionInsertTarget {
  if (!pageId || !tree) {
    return { ok: false, message: 'Select a frame on the board first — what you add goes into the frame you are working in.' }
  }
  const selected = selectedNodeId ? tree.nodes[selectedNodeId] : undefined
  const parent = selected?.parentId ? tree.nodes[selected.parentId] : undefined
  if (selected && parent) {
    return { ok: true, pageId, parentId: parent.id, index: parent.children.indexOf(selected.id) + 1 }
  }
  const root = tree.nodes[tree.rootNodeId]
  return { ok: true, pageId, parentId: tree.rootNodeId, index: root?.children.length ?? 0 }
}

/** {@link resolveSelectionInsertTarget} for the editor as it is right now. */
export function readSelectionInsertTarget(): SelectionInsertTarget {
  const state = useEditorStore.getState()
  const pageId = state.activePageId
  const tree = pageId ? (state.site?.pages.find((page) => page.id === pageId) ?? null) : null
  return resolveSelectionInsertTarget(pageId, tree, state.selectedNodeId)
}

/** Insert `files` at `target` through the drop's own write (see this module's doc). */
export function insertImagesAtTarget(target: Extract<SelectionInsertTarget, { ok: true }>, files: readonly File[]): void {
  if (files.length === 0) return
  const tree = useEditorStore.getState().site?.pages.find((page) => page.id === target.pageId) ?? null
  // The same width clamp a drop gets: the container's content box, read once.
  const container = tree ? resolveSourceContainer(tree, target.parentId) : null
  const rendered = container?.ok ? findRenderedCanvasElements(container.node.id)[0] : undefined
  const box = rendered && container?.ok ? measureDropContainer(rendered.element.ownerDocument, container.node.id) : null
  useEditorStore.getState().dropImagesIntoPage({
    pageId: target.pageId,
    parentId: target.parentId,
    index: target.index,
    files,
    maxWidth: box ? box.contentWidth : null,
    absolute: null,
    paintProgress: paintCanvasUploadProgress,
  })
}
