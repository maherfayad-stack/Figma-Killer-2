/**
 * useCanvasLayerKeyboard — Delete and arrow-nudge for the selected loose layers
 * on the free canvas (P5-G, FC-5 G6/G15).
 *
 * Registered on the SAME `annotation` rung as the sticky notes' keyboard
 * (`useBoardAnnotationKeyboard`): a loose layer is board furniture, selected in
 * its own list, and scoped by intent — inert unless loose layers are actually
 * selected, so it never takes a key from anything else. No new binding and no
 * new rung: Delete/Backspace and the registry's own `canvas.moveSelection`
 * arrows mean here exactly what they mean for a note.
 *
 * Delete is ONE structural gesture for the whole selection (`removeCanvasLayers`
 * — one `/save`, one ⌘Z that brings the modules and their placements back). A
 * nudge is a board-only move, one undo entry per key-hold, closed on keyup like
 * every other furniture nudge (`endBoardGesture`).
 */
import { useEditorStore } from '@site/store/store'
import { selectActiveBoardLayers } from '@site/store/slices/boardSelectors'
import { getKeybindingForCommand, nudgeDelta } from '@admin/spotlight/keybindings'
import { isInsideKeyOwningOverlay, isTextInputTarget } from '../editorKeyGuards'
import { useEditorKeyScope } from '../useEditorKeyDispatcher'

export function useCanvasLayerKeyboard(editable: boolean): void {
  useEditorKeyScope(
    'annotation',
    () => editable && useEditorStore.getState().selectedCanvasLayerIds.length > 0,
    (event) => {
      if (isTextInputTarget(event.target) || isInsideKeyOwningOverlay(event.target)) return false
      const state = useEditorStore.getState()
      const selected = state.selectedCanvasLayerIds
      if (selected.length === 0) return false

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        state.removeCanvasLayers(selected)
        return true
      }

      if (!getKeybindingForCommand('canvas.moveSelection')?.match(event)) return false
      const delta = nudgeDelta(event)
      if (!delta) return false
      event.preventDefault()
      const moves = new Map<string, { x: number; y: number }>()
      for (const layer of selectActiveBoardLayers(state)) {
        if (selected.includes(layer.id) && !layer.locked) moves.set(layer.id, { x: layer.x + delta.dx, y: layer.y + delta.dy })
      }
      state.moveCanvasLayers(moves, 'board:canvas-layer-nudge')
      return true
    },
  )
}
