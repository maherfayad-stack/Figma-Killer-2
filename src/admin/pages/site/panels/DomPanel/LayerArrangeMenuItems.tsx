/**
 * LayerArrangeMenuItems — the right-click menu's arrange block (P5-E, IX-27
 * and UX-22): Group, Ungroup, Lock, Bring to front, Send to back, Add / Remove
 * flex layout, Copy / Paste style, and — on the canvas — "Select layer", the
 * list of every layer under the pointer (IX-26).
 *
 * Every item runs the SAME function its keyboard shortcut runs
 * (`canvas/layerCommands.ts`, `canvas/layerAlign.ts`, the store's group /
 * lock actions) and shows that shortcut, read from the keybinding registry —
 * the menu can never teach a key that does something else.
 *
 * Its own component because `LayerNodeContextMenu` is shared with the Layers
 * panel and was already long; this block is one responsibility (arranging
 * the selection) and needs none of that file's state beyond the targets.
 */
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@ui/components/ContextMenu'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { shortcutLabelFor } from '@admin/spotlight/keybindings'
import { ALIGN_COMMANDS } from '@admin/spotlight/keybindingLayerCommands'
import { alignSelection } from '@site/canvas/layerAlign'
import {
  copySelectionStyle,
  hasCopiedStyle,
  moveSelectionToEnd,
  pasteSelectionStyle,
  toggleFlexLayout,
} from '@site/canvas/layerCommands'
import type { AlignEdge } from '@ui/components/AlignBar'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { ContainerSolidIcon } from 'pixel-art-icons/icons/container-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { PointerSolidIcon } from 'pixel-art-icons/icons/pointer-solid'
import { AlignStartHorizontalSolidIcon } from 'pixel-art-icons/icons/align-start-horizontal-solid'

interface LayerArrangeMenuItemsProps {
  /** The layers the menu acts on — the multi-selection, or the one right-clicked. */
  targetIds: readonly string[]
  /** The canvas's "Select layer" list, innermost first; empty in the Layers panel. */
  layerIdsUnderPointer: readonly string[]
  onClose: () => void
}

export function LayerArrangeMenuItems({ targetIds, layerIdsUnderPointer, onClose }: LayerArrangeMenuItemsProps) {
  const page = useEditorStore(selectActiveCanvasPage)
  const visualComponents = useEditorStore((s) => s.site?.visualComponents)
  const nodes = targetIds.flatMap((id) => {
    const node = page?.nodes[id]
    return node ? [node] : []
  })
  if (nodes.length === 0) return null

  const run = (action: () => void | Promise<void>) => () => {
    onClose()
    void action()
  }
  const store = () => useEditorStore.getState()
  const single = nodes.length === 1 ? nodes[0] : undefined
  const isRoot = single !== undefined && single.id === page?.rootNodeId
  const isContainer = single !== undefined && (isRoot || registry.get(single.moduleId)?.canHaveChildren === true)
  const locked = nodes.every((node) => node.locked === true)
  // Not "Wrap in …": that is the Wrap submenu's name, and one menu must not
  // offer two items a reader (or a screen reader) cannot tell apart.
  const flexLabel = single && isContainer ? 'Toggle flex layout' : 'Add flex layout'
  const labelOf = (id: string) => {
    const node = page?.nodes[id]
    return node ? getNodeDisplayName(node, registry.get(node.moduleId), visualComponents) : id
  }

  return (
    <>
      <ContextMenuSeparator />
      {nodes.length > 1 && (
        <ContextMenuItem onClick={run(() => { store().groupNodes([...targetIds]) })} shortcut={shortcutLabelFor('layers.group')}>
          <span aria-hidden="true"><BoxStackSolidIcon size={13} /></span>
          Group
        </ContextMenuItem>
      )}
      {single && isContainer && !isRoot && single.children.length > 0 && (
        <ContextMenuItem onClick={run(() => store().ungroupNode(single.id))} shortcut={shortcutLabelFor('layers.ungroup')}>
          <span aria-hidden="true"><ContainerSolidIcon size={13} /></span>
          Ungroup
        </ContextMenuItem>
      )}
      {!isRoot && (
        <ContextMenuItem
          onClick={run(() => store().setNodesLocked([...targetIds], !locked))}
          shortcut={shortcutLabelFor('layers.toggleLock')}
        >
          <span aria-hidden="true"><LockSolidIcon size={13} /></span>
          {locked ? 'Unlock' : 'Lock'}
        </ContextMenuItem>
      )}
      {single && !isRoot && (
        <>
          <ContextMenuItem onClick={run(() => moveSelectionToEnd('front'))} shortcut={shortcutLabelFor('layers.bringToFront')}>
            <span aria-hidden="true"><ArrowBarDownIcon size={13} /></span>
            Bring to front
          </ContextMenuItem>
          <ContextMenuItem onClick={run(() => moveSelectionToEnd('back'))} shortcut={shortcutLabelFor('layers.sendToBack')}>
            <span aria-hidden="true"><ArrowBarUpIcon size={13} /></span>
            Send to back
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem onClick={run(toggleFlexLayout)} shortcut={shortcutLabelFor('layers.toggleFlexLayout')}>
        <span aria-hidden="true"><LayoutSolidIcon size={13} /></span>
        {flexLabel}
      </ContextMenuItem>
      {!isRoot && (
        <ContextMenuSubmenu label="Align" icon={<AlignStartHorizontalSolidIcon size={13} />} onClose={onClose} width={240}>
          {ALIGN_COMMANDS.map(({ commandId, edge, label }) => (
            <ContextMenuItem key={commandId} onClick={run(() => alignSelection(edge as AlignEdge))} shortcut={shortcutLabelFor(commandId)}>
              {label}
            </ContextMenuItem>
          ))}
        </ContextMenuSubmenu>
      )}
      <ContextMenuItem onClick={run(copySelectionStyle)} shortcut={shortcutLabelFor('layers.copyStyle')} disabled={!single}>
        <span aria-hidden="true"><PaintBucketSolidIcon size={13} /></span>
        Copy style
      </ContextMenuItem>
      {hasCopiedStyle() && (
        <ContextMenuItem onClick={run(pasteSelectionStyle)} shortcut={shortcutLabelFor('layers.pasteStyle')}>
          <span aria-hidden="true"><PaintBucketSolidIcon size={13} /></span>
          Paste style
        </ContextMenuItem>
      )}
      {layerIdsUnderPointer.length > 1 && (
        <ContextMenuSubmenu label="Select layer" icon={<PointerSolidIcon size={13} />} onClose={onClose} width={240} maxHeight={360}>
          {layerIdsUnderPointer.map((id) => (
            <ContextMenuItem key={id} selected={targetIds.includes(id)} onClick={run(() => store().selectNode(id))}>
              {labelOf(id)}
            </ContextMenuItem>
          ))}
        </ContextMenuSubmenu>
      )}
    </>
  )
}
