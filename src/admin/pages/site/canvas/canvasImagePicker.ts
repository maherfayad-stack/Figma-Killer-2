/**
 * canvasImagePicker — IX-img: "Insert image…" (Penpot's and Figma's ⇧K /
 * ⇧⌘K). A file picker whose images land BESIDE the selection, through exactly
 * the write an OS file drop makes (`dropImagesIntoPage`): one insert of N
 * siblings, one undo step, the ghost while the bytes upload, the intrinsic
 * size clamped to the container.
 *
 * Where they go is `canvasSelectionInsert.ts`'s rule, which ⌘V of an image
 * shares (P5-A): after the selected layer, else appended to the active
 * frame's root. No active frame means nowhere to write, and the command says
 * so instead of opening a picker whose result could only be refused.
 *
 * Opening the picker is the only DOM work here, and it runs inside the user's
 * own gesture — the browser only opens a file dialog from one.
 */
import { pushToast } from '@ui/components/Toast'
import { IMAGE_DROP_TITLE } from '@site/store/slices/site/imageDropActions'
import { looksLikeImage } from './canvasFileDrop'
import { insertImagesAtTarget, readSelectionInsertTarget } from './canvasSelectionInsert'

/** The formats `sniffImageExtension` accepts — offered by the picker; the server's byte sniff is still the gate. */
export const IMAGE_PICKER_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml'

/**
 * Open the file picker and insert whatever images it returns. Called from
 * the `insert.image` command (the palette today; ⇧K once the key is bound).
 */
export function pickImagesIntoSelection(): void {
  const target = readSelectionInsertTarget()
  if (!target.ok) {
    pushToast({ kind: 'warning', title: IMAGE_DROP_TITLE, body: target.message, location: 'site-editor' })
    return
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = IMAGE_PICKER_ACCEPT
  input.hidden = true
  const cleanup = () => input.remove()
  input.addEventListener('cancel', cleanup, { once: true })
  input.addEventListener(
    'change',
    () => {
      const files = Array.from(input.files ?? [])
      cleanup()
      insertImagesAtTarget(target, files.filter((file) => looksLikeImage(file.type)))
    },
    { once: true },
  )
  document.body.appendChild(input)
  input.click()
}
