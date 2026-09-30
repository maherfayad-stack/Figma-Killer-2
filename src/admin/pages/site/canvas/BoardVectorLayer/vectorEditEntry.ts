/**
 * vectorEditEntry — double-clicking an inline `<svg>` enters vector edit mode
 * (P5-D), Figma's "double-click a vector to edit its points".
 *
 * Only a LITERAL `<svg>` written as JSX qualifies: its inner elements carry the
 * parser's part stamps (SVG-3), which is what makes each point's write land in
 * exactly one place. A `?raw` icon (`props.tag`: the markup came through
 * `dangerouslySetInnerHTML` from a file) has no JSX parts to write. A `.map`
 * row has no single source location, and a locked node says why it is locked.
 * Each of those refuses BY NAME rather than opening a mode that cannot write.
 *
 * Returns `true` when the double-click was the svg's — entered, or refused
 * with a sentence — so the caller does not also try an inline text edit.
 */
import { hasWritableSourceLocation } from '@core/page-tree'
import { SVG_PART_ATTRIBUTE } from '@core/vector'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { enterVectorEdit } from './vectorEditState'

const TITLE = 'Cannot edit points'

function refuse(body: string): true {
  pushToast({ kind: 'warning', title: TITLE, body, location: 'site-editor' })
  return true
}

export function tryEnterVectorEdit(nodeId: string, frameId: string | null): boolean {
  const page = selectActiveCanvasPage(useEditorStore.getState())
  const node = page?.nodes[nodeId]
  if (!page || !node || node.moduleId !== 'base.svg') return false
  const markup = node.props.svg
  if (typeof markup !== 'string' || markup.length === 0) return refuse('This graphic is built in code, so there are no points to edit on the canvas.')
  if (typeof node.props.tag === 'string' && node.props.tag.length > 0) {
    return refuse('This icon comes from an .svg file, not from JSX in your code, so its points cannot be edited here.')
  }
  if (!hasWritableSourceLocation(nodeId)) {
    return refuse('This graphic is drawn once per row of a list, so there is no single place in your code to write its points.')
  }
  if (node.locked) return refuse(node.lockReason ? `This graphic is locked: ${node.lockReason}` : 'This graphic is locked.')
  if (!markup.includes(SVG_PART_ATTRIBUTE)) return refuse('This graphic has no paths to edit.')
  enterVectorEdit({ hostNodeId: nodeId, pageId: page.id, frameId })
  return true
}
