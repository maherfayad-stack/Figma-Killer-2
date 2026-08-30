/**
 * DocLinkDialog — asks for the URL when the doc toolbar's "Add link" is used.
 *
 * A dialog rather than `prompt()`, which is banned repo-wide
 * (`no-native-browser-dialogs.test.ts`) — and which would also blow away the
 * text selection the link is supposed to wrap.
 *
 * The selection survives because the toolbar button never takes focus (see
 * `DocToolbar`'s `mousedown` rule) and this dialog restores focus to the
 * editable body before running the command — `DocBlockView.onSubmit` does that
 * ordering.
 */
import { useState, type FormEvent } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { FormField } from '@ui/components/FormField'

interface DocLinkDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (href: string) => void
}

export function DocLinkDialog({ open, onClose, onSubmit }: DocLinkDialogProps) {
  const [href, setHref] = useState('')

  // Cleared on the `open` transition during render rather than in an effect —
  // see `NewProjectDialog` for why (cascading re-render).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setHref('')
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const trimmed = href.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add link"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => submit()} disabled={!href.trim()}>Add link</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <FormField label="URL">
          <Input
            value={href}
            onChange={(e) => setHref(e.currentTarget.value)}
            placeholder="https://example.com"
            aria-label="Link URL"
            autoFocus
          />
        </FormField>
      </form>
    </Dialog>
  )
}
