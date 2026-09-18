/**
 * SavedLayoutManageMenu — right-click menu on a saved layout card in the
 * Assets panel: Rename… / Delete.
 *
 * Rename hands off to the shared `LayoutNameDialog`; delete commits
 * immediately (a normal undoable site mutation) and confirms via toast. The
 * panel stays open through both — it is docked chrome, not a modal that had to
 * get out of a dialog's way.
 */

import {
  ContextMenu as UIContextMenu,
  ContextMenuItem,
} from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { useEditorStore } from '@site/store/store'

export interface SavedLayoutMenuState {
  x: number
  y: number
  layoutId: string
  name: string
}

interface SavedLayoutManageMenuProps {
  menu: SavedLayoutMenuState
  /** Close just this menu. */
  onClose: () => void
}

export function SavedLayoutManageMenu({
  menu,
  onClose,
}: SavedLayoutManageMenuProps) {
  const deleteLayout = useEditorStore((s) => s.deleteLayout)
  const openLayoutNameDialog = useEditorStore((s) => s.openLayoutNameDialog)

  function handleRename() {
    onClose()
    openLayoutNameDialog({ mode: 'rename', layoutId: menu.layoutId })
  }

  function handleDelete() {
    onClose()
    deleteLayout(menu.layoutId)
    pushToast({
      kind: 'success',
      title: `Deleted layout "${menu.name}"`,
      body: 'Undo with Ctrl/Cmd+Z.',
      location: 'assets-panel',
    })
  }

  return (
    <UIContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={`${menu.name} options`}
      onClose={onClose}
      zIndex={10000}
    >
      <ContextMenuItem onClick={handleRename}>
        <span aria-hidden="true"><PenSquareSolidIcon size={13} /></span>
        Rename…
      </ContextMenuItem>
      <ContextMenuItem danger onClick={handleDelete}>
        <span aria-hidden="true"><TrashSolidIcon size={13} /></span>
        Delete
      </ContextMenuItem>
    </UIContextMenu>
  )
}
