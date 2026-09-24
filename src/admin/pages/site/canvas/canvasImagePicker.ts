/**
 * canvasImagePicker — IX-img: "Insert image…" (Penpot's and Figma's ⇧K /
 * ⇧⌘K). A file picker whose images land BESIDE the selection, through exactly
 * the write an OS file drop makes (`dropImagesIntoPage`): one insert of N
 * siblings, one undo step, the ghost while the bytes upload, the intrinsic
 * size clamped to the container.
 *
 * ## Where the images go
 *
 * A drop has a pointer, so it has a position. A picker does not, so the
 * selection is the position, the way a paste places what it pastes: right
 * AFTER the selected layer, inside its parent. With nothing selected, the
 * images are appended to the active frame's page root (which
 * `planSourceInsert` resolves to the page's own root element). No active
 * frame means nowhere to write, and the command says so instead of opening a
 * picker whose result could only be refused.
 *
 * The planning is pure ({@link resolvePickedImageTarget}); opening the
 * picker is the only DOM work, and it runs inside the user's own gesture —
 * the browser only opens a file dialog from one.
 */
import { pushToast } from '@ui/components/Toast'
import type { NodeTree, PageNode } from '@core/page-tree'
import { resolveSourceContainer } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { IMAGE_DROP_TITLE } from '@site/store/slices/site/imageDropActions'
import { findRenderedCanvasElements } from './canvasNodeLookup'
import { looksLikeImage } from './canvasFileDrop'
import { measureDropContainer } from './canvasImageDropPlacement'

/** What a picker's images are inserted into, or why they cannot be. */
export type PickedImageTarget =
  | { ok: true; pageId: string; parentId: string; index: number }
  | { ok: false; message: string }

/** The formats `sniffImageExtension` accepts — offered by the picker; the server's byte sniff is still the gate. */
export const IMAGE_PICKER_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml'

/**
 * Beside the selected layer (after it, in its parent), else appended to the
 * page root. `selectedNodeId` must belong to `tree` to count — a selection in
 * another frame does not name a position in this one.
 */
export function resolvePickedImageTarget(
  pageId: string | null,
  tree: NodeTree<PageNode> | null,
  selectedNodeId: string | null,
): PickedImageTarget {
  if (!pageId || !tree) {
    return { ok: false, message: 'Select a frame on the board first — the images are added to the frame you are working in.' }
  }
  const selected = selectedNodeId ? tree.nodes[selectedNodeId] : undefined
  const parent = selected?.parentId ? tree.nodes[selected.parentId] : undefined
  if (selected && parent) {
    return { ok: true, pageId, parentId: parent.id, index: parent.children.indexOf(selected.id) + 1 }
  }
  const root = tree.nodes[tree.rootNodeId]
  return { ok: true, pageId, parentId: tree.rootNodeId, index: root?.children.length ?? 0 }
}

/**
 * Open the file picker and insert whatever images it returns. Called from
 * the `insert.image` command (the palette today; ⇧K once the key is bound).
 */
export function pickImagesIntoSelection(): void {
  const state = useEditorStore.getState()
  const pageId = state.activePageId
  const tree = pageId ? (state.site?.pages.find((page) => page.id === pageId) ?? null) : null
  const target = resolvePickedImageTarget(pageId, tree, state.selectedNodeId)
  if (!target.ok) {
    pushToast({ kind: 'warning', title: IMAGE_DROP_TITLE, body: target.message, location: 'site-editor' })
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = IMAGE_PICKER_ACCEPT
  input.hidden = true
  const cleanup = () => input.remove()
  input.addEventListener('cancel', cleanup, { once: true })
  input.addEventListener(
    'change',
    () => {
      const files = Array.from(input.files ?? [])
      cleanup()
      insertPickedImages(target, files)
    },
    { once: true },
  )
  document.body.appendChild(input)
  input.click()
}

function insertPickedImages(target: Extract<PickedImageTarget, { ok: true }>, picked: readonly File[]): void {
  const files = picked.filter((file) => looksLikeImage(file.type))
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
  })
}
