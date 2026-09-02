/**
 * CommentToolButton — arms the comment tool. `C` is its shortcut.
 *
 * Lives next to "+ Sticky note" / "+ Doc" in `BoardNotesToolbar`, because from
 * the reviewer's point of view those three are the same gesture: put something
 * on the board that is not part of the design.
 *
 * The key handling is NOT here. It was — a private `window` keydown listener
 * with its own hand-rolled "am I typing?" check — which is exactly the drift
 * `keybindings-registry-single-source.test.ts` exists to stop: a second place
 * that decides what `C` means, and a second copy of the typing guard to get
 * subtly wrong. The binding now lives in the registry as `tools.comment` and
 * is dispatched by `useCanvasToolShortcuts` alongside `T` and `F`, so all
 * three tool keys share one guard and appear in the help screen. This button
 * only renders state and reads the label back out of the registry.
 */
import { useEditorStore } from '@site/store/store'
import { selectOpenCommentCount } from '@site/store/slices/commentSelectors'
import { getKeybindingForCommand, formatShortcut } from '@admin/spotlight/keybindings'
import { Button } from '@ui/components/Button'
import { CommentBubbleIcon } from '@ui/components/InspectorIcons'
import styles from './CommentToolButton.module.css'

export function CommentToolButton() {
  const active = useEditorStore((s) => s.commentToolActive)
  const setCommentToolActive = useEditorStore((s) => s.setCommentToolActive)
  const openCount = useEditorStore(selectOpenCommentCount)

  const shortcut = getKeybindingForCommand('tools.comment')

  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      size="sm"
      aria-pressed={active}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      tooltip={shortcut ? `Comment (${formatShortcut(shortcut.shortcut)})` : 'Comment'}
      onClick={() => setCommentToolActive(!active)}
    >
      <CommentBubbleIcon size={14} />
      Comment
      {openCount > 0 ? <span className={styles.count}>{openCount}</span> : null}
    </Button>
  )
}
