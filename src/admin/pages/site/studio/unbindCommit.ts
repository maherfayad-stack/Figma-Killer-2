/**
 * unbindCommit - the one-shot write behind typing over a code-bound value
 * (G-6, OD-20): `<p>{count}</p>` becomes `<p>Five</p>`, `title={t('x')}`
 * becomes `title="Home"`.
 *
 * It is a one-shot like detach and swap, not a `saveSite` diff, for the reason
 * that matters most here: the diff would read "tree value differs from baseline"
 * and ask `setJsxProp` for a plain write, which refuses `binding-overwrite` by
 * design. The intent has to travel with the edit (`unbind: true`), the write has
 * to be journaled (the pre-image is the only thing that brings the code back
 * byte for byte), and the person has to be told what was replaced.
 *
 * The notice is an `info`, never an error: the editor did what was asked. It
 * names the code that went and carries Undo, which is the store's own `undo`
 * (this commit pushes the history entry whose inverse is the journal's
 * `restore`), so the button and Cmd+Z are the same thing.
 */
import { pushToast } from '@ui/components/Toast'
import { commitStructural } from './studioStructuralCommitEngine'

export interface UnbindRequest {
  nodeId: string
  /** The element's text (`setJsxText`) or one attribute (`setJsxProp`). */
  kind: 'text' | 'prop'
  prop: string
  value: string
  /** The code being replaced, as the board read it (`resolvedProps[prop].source`) - empty when the parser traced none. */
  replaced: string
  /** The store's undo. Passed in so this module never imports the store. */
  undo: () => void
}

/** `Replaced {count} with text` / `Replaced title={count} with text` - the sentence both the toast title and the history label use. */
export function unbindLabel(kind: UnbindRequest['kind'], prop: string, replaced: string): string {
  if (replaced === '') return kind === 'text' ? 'Replaced the code behind this text with text' : `Replaced the code behind ${prop} with text`
  return kind === 'text' ? `Replaced {${replaced}} with text` : `Replaced ${prop}={${replaced}} with text`
}

export async function commitStudioUnbind(request: UnbindRequest): Promise<void> {
  const edit =
    request.kind === 'text'
      ? { kind: 'text', nodeId: request.nodeId, text: request.value, unbind: true }
      : { kind: 'prop', nodeId: request.nodeId, prop: request.prop, value: request.value, unbind: true }
  const label = unbindLabel(request.kind, request.prop, request.replaced)
  await commitStructural([edit], 'Could not replace the code', {
    undo: { label, template: { kind: 'restore-journal' } },
    onLanded: () => {
      pushToast({
        kind: 'info',
        title: label,
        body: 'It is plain text in your code now. Undo puts the code back.',
        action: { label: 'Undo', onSelect: request.undo },
        location: 'studio:unbind',
      })
    },
  })
}
