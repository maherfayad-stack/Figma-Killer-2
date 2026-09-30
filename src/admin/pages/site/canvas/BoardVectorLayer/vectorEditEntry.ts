/**
 * vectorEditEntry — entering vector edit mode (P5-D), Figma's "double-click a
 * vector to edit its points". Two doors, one decision: double-clicking an
 * inline `<svg>` (`useCanvasNodeInteraction`), and the selection toolbar's
 * "Edit points" button (`SelectionToolbar`), which is the door an author can
 * SEE — before it existed, the double-click was the only way in.
 *
 * Only a LITERAL `<svg>` written as JSX qualifies: its inner elements carry the
 * parser's part stamps (SVG-3), which is what makes each point's write land in
 * exactly one place. A `?raw` icon (`props.tag`: the markup came through
 * `dangerouslySetInnerHTML` from a file) has no JSX parts to write. A `.map`
 * row has no single source location, and a locked node says why it is locked.
 * Each of those refuses BY NAME rather than opening a mode that cannot write.
 *
 * `vectorEditVerdict` is that decision as a pure read, so the toolbar can show
 * its button only where entering would succeed; `tryEnterVectorEdit` acts on
 * it for the double-click, which also has to explain a refusal.
 */
import { hasWritableSourceLocation } from '@core/page-tree'
import { SVG_PART_ATTRIBUTE } from '@core/vector'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore, type EditorStore } from '@site/store/store'
import { enterVectorEdit } from './vectorEditState'

const TITLE = 'Cannot edit points'

export type VectorEditVerdict =
  | { kind: 'not-svg' }
  | { kind: 'refused'; reason: string }
  | { kind: 'editable'; pageId: string }

export function vectorEditVerdict(state: EditorStore, nodeId: string): VectorEditVerdict {
  const page = selectActiveCanvasPage(state)
  const node = page?.nodes[nodeId]
  if (!page || !node || node.moduleId !== 'base.svg') return { kind: 'not-svg' }
  const markup = node.props.svg
  if (typeof markup !== 'string' || markup.length === 0) {
    return { kind: 'refused', reason: 'This graphic is built in code, so there are no points to edit on the canvas.' }
  }
  if (typeof node.props.tag === 'string' && node.props.tag.length > 0) {
    return { kind: 'refused', reason: 'This icon comes from an .svg file, not from JSX in your code, so its points cannot be edited here.' }
  }
  if (!hasWritableSourceLocation(nodeId)) {
    return { kind: 'refused', reason: 'This graphic is drawn once per row of a list, so there is no single place in your code to write its points.' }
  }
  if (node.locked) {
    return { kind: 'refused', reason: node.lockReason ? `This graphic is locked: ${node.lockReason}` : 'This graphic is locked.' }
  }
  if (!markup.includes(SVG_PART_ATTRIBUTE)) return { kind: 'refused', reason: 'This graphic has no paths to edit.' }
  return { kind: 'editable', pageId: page.id }
}

/**
 * Returns `true` when the node was the svg's to handle — entered, or refused
 * with a sentence — so the double-click caller does not also try an inline
 * text edit.
 */
export function tryEnterVectorEdit(nodeId: string, frameId: string | null): boolean {
  const verdict = vectorEditVerdict(useEditorStore.getState(), nodeId)
  if (verdict.kind === 'not-svg') return false
  if (verdict.kind === 'refused') {
    pushToast({ kind: 'warning', title: TITLE, body: verdict.reason, location: 'site-editor' })
    return true
  }
  enterVectorEdit({ hostNodeId: nodeId, pageId: verdict.pageId, frameId })
  return true
}
