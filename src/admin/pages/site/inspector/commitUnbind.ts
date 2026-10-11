/**
 * commitUnbind (G-6, OD-20) - the one question every prop-edit surface asks
 * before it calls `updateNodeProps`: "is this a code-bound value the user just
 * typed over?"
 *
 * The docked panel (`usePropertiesPanelData.handleChange`), the inspector
 * sections (`commitApi.commitProp`) and the in-place inspector all write one prop
 * from a field. `updateNodeProps` refuses a code-valued prop silently, so a typed
 * value would vanish; this routes it to the store's `unbindNodeValue` instead -
 * one journaled source write that replaces the code with the literal, says what
 * it replaced, and offers Undo. One function, so the three surfaces cannot
 * disagree about when typing replaces code.
 */
import { canUnbindProp, type SourceWritableNode } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'

/** True when the value was handed to the unbind write (the caller must not also call `updateNodeProps`). */
export function commitUnbindIfCodeBound(node: (SourceWritableNode & { id: string }) | null | undefined, propKey: string, value: unknown): boolean {
  if (!node || typeof value !== 'string' || !canUnbindProp(node, propKey)) return false
  useEditorStore.getState().unbindNodeValue(node.id, propKey, value)
  return true
}
