/**
 * canvasLayerTextCommit — the write behind an in-place text edit of a loose
 * layer (P5-G): ONE `/save` with ONE undo entry for a whole typing session.
 *
 * A layer's content is not in `site.pages`, so the page autosave never sees
 * it, and the keystroke-by-keystroke commit a page's inline edit uses has
 * nowhere to land. The session keeps its text in the editable element and
 * posts once, when it ends: the same shape `svgPartCommits.ts` gives a vector
 * paint burst. The inverse is known now — the same edit carrying the text from
 * before the session — so ⌘Z writes it back with no re-plan.
 *
 * Text that came from a literal elsewhere (`textOrigin`: a dictionary entry, a
 * call-site string) is written at that literal with `expected` set to what
 * the board read, as a page edit does (`nodeDiffWriteback.ts`).
 */
import type { PageNode } from '@core/page-tree'
import type { StructuralCommitRollback } from '@site/store/slices/site/structuralCommitRollback'
import { commitStructural } from './studioStructuralCommitEngine'
import type { StructuralEditPayload } from './structuralUndoPlan'

function textEdit(node: Pick<PageNode, 'id' | 'textOrigin'>, text: string, expected: string): StructuralEditPayload {
  if (node.textOrigin) {
    const { rel, line, col } = node.textOrigin
    return { kind: 'literal', nodeId: `${rel}:${line}:${col}`, text, expected }
  }
  return { kind: 'text', nodeId: node.id, text }
}

export async function commitCanvasLayerText(input: {
  node: Pick<PageNode, 'id' | 'textOrigin'>
  before: string
  after: string
  rollback: StructuralCommitRollback
}): Promise<void> {
  const { node, before, after } = input
  await commitStructural([textEdit(node, after, before)], 'Could not edit that text', {
    undo: { label: 'Edit text', template: { kind: 'known', inverse: [textEdit(node, before, after)] } },
    rollback: input.rollback,
  })
}
