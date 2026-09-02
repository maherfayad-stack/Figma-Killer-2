/**
 * CommentComposer — the write field shared by "start a thread" and "reply".
 *
 * Enter submits; Shift+Enter makes a newline. This started the other way round
 * — bare Enter inserted a paragraph break, on the theory that a review comment
 * runs long and posting mid-thought is the worst thing a comment box can do.
 * That theory lost to what people actually do: every tool this box competes
 * with in muscle memory (Figma, Slack, Linear) posts on Enter, so holding the
 * line just made the box feel broken. Shift+Enter keeps the multi-paragraph
 * case one keystroke away, and ⌘/Ctrl+Enter still submits too.
 *
 * Escape cancels, which is what makes an abandoned draft pin discard itself
 * rather than becoming a permanent empty marker.
 *
 * TWO LAYOUTS, ONE COMPONENT
 * ──────────────────────────
 * `stacked` (a new thread, or an edit) gives the box room — those are the
 * cases where someone writes a paragraph. `inline` puts a one-row box and the
 * submit button on a single line, which is the right shape for a reply: a
 * reply is usually a sentence, and a tall empty box at the bottom of a thread
 * pushes the conversation off the popover for no gain. The box still grows if
 * the sentence turns out to be three (`resize: vertical` in inline mode), so
 * the compact default costs nothing when someone does need the room.
 *
 * The draft lives in local state, deliberately. It is per-composer, dies with
 * the popover, and nothing outside this component can act on a half-typed
 * sentence — putting it in the store would buy nothing and add a write per
 * keystroke to a Mutative draft.
 */
import { useState, type KeyboardEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Textarea } from '@ui/components/Input'
import { cn } from '@ui/cn'
import styles from './CommentComposer.module.css'

interface CommentComposerProps {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  /** `inline` = one row, button beside the box (replies). Default `stacked`. */
  layout?: 'stacked' | 'inline'
  /** Initial body — set when editing an existing comment. */
  initialValue?: string
  onSubmit: (body: string) => void | Promise<void>
  onCancel?: () => void
}

export function CommentComposer({
  placeholder,
  submitLabel,
  autoFocus = false,
  layout = 'stacked',
  initialValue = '',
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const inline = layout === 'inline'
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const canSubmit = value.trim().length > 0 && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await onSubmit(value.trim())
      // Only cleared on success. A failed post keeps what was typed in the
      // box — losing someone's paragraph to a dropped request is not a
      // recoverable error for them.
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter') {
      // Shift+Enter is the newline. ⌘/Ctrl+Enter also submits — it is what the
      // box used to require, and it costs nothing to keep honouring it.
      if (event.shiftKey) return
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <div className={cn(styles.composer, inline && styles.inline)}>
      <Textarea
        // Autofocus is right here: the popover opens in direct response to a
        // click whose entire purpose is to type into this box, so not focusing
        // would make every comment cost an extra click. It never steals focus
        // on page load — the composer does not exist until a pin is opened.
        autoFocus={autoFocus}
        className={styles.field}
        fieldSize="sm"
        rows={inline ? 1 : 2}
        // Inline starts at one row but is not locked there — a reply that runs
        // long should be readable while it is being written.
        resize={inline ? 'vertical' : 'none'}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={cn(styles.actions, inline && styles.inlineActions)}>
        {onCancel ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="comment-composer-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          data-testid="comment-composer-submit"
          onClick={() => void submit()}
          disabled={!canSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
