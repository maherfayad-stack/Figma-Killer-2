/**
 * UnusedImagesFooter — "N unused images Studio added", and the explicit
 * delete (P5-B3, IMG-11).
 *
 * Undo of an image drop leaves the file on disk on purpose (redo needs it), so
 * orphans accumulate. This is the one place they are surfaced, and the one
 * place they can go: a button, then a confirmation naming what goes, then a
 * server that re-checks every file before it deletes it (`assetPrune.ts`).
 * Nothing is ever deleted without that click — the confirmation is
 * `alwaysConfirm`, whatever the user's "confirm before delete" preference says.
 *
 * Renders nothing when there is nothing to offer, and refreshes whenever the
 * project's image list does (`assets` identity), since a drop or a prune is
 * what changes the answer.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { invalidateProjectImageAssets, type ProjectImageAsset } from '@site/studio/projectAssets'
import { fetchUnusedImages, pruneUnusedImages } from '@site/studio/unusedImages'
import styles from './ImagesSection.module.css'

/** How many names the confirmation lists before "and N more". */
const LISTED_NAMES = 6

interface UnusedImagesFooterProps {
  /** The project's image list; a new list means the answer may have changed. */
  assets: readonly ProjectImageAsset[] | null
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

export function UnusedImagesFooter({ assets }: UnusedImagesFooterProps) {
  const confirmDelete = useConfirmDelete()
  const [unused, setUnused] = useState<readonly string[]>([])

  useEffect(() => {
    if (assets === null) return
    let live = true
    fetchUnusedImages()
      .then((report) => {
        if (live) setUnused(report.incomplete ? [] : report.unused.map((asset) => asset.relPath))
      })
      .catch((err) => {
        // A report that cannot be fetched offers nothing — the honest state
        // for a list of things to delete. Not a toast: nobody asked for it.
        console.error('[UnusedImagesFooter] fetching unused images failed:', err)
        if (live) setUnused([])
      })
    return () => {
      live = false
    }
  }, [assets])

  if (unused.length === 0) return null

  const count = unused.length
  const noun = count === 1 ? 'image' : 'images'

  function requestPrune() {
    const listed = unused.slice(0, LISTED_NAMES).map(baseName).join(', ')
    const more = count > LISTED_NAMES ? ` and ${count - LISTED_NAMES} more` : ''
    const paths = [...unused]
    confirmDelete({
      title: `Delete ${count} unused ${noun}?`,
      description: `${listed}${more}. Studio added ${count === 1 ? 'it' : 'them'} to your project and nothing uses ${count === 1 ? 'it' : 'them'} now. The ${noun} will be removed from your project folder.`,
      confirmLabel: `Delete ${count} ${noun}`,
      alwaysConfirm: true,
      commit: () => {
        void pruneUnusedImages(paths)
          .then((result) => {
            invalidateProjectImageAssets()
            if (result.kept.length > 0) {
              pushToast({
                kind: 'warning',
                title: `${result.kept.length} ${result.kept.length === 1 ? 'image was' : 'images were'} kept`,
                body: `${result.kept.map((entry) => baseName(entry.relPath)).join(', ')}: ${result.kept[0]!.reason}`,
                location: 'site-editor',
              })
            }
          })
          .catch((err) => {
            console.error('[UnusedImagesFooter] deleting unused images failed:', err)
            pushToast({
              kind: 'error',
              title: 'Could not delete the unused images',
              body: getErrorMessage(err, 'The unused images could not be deleted.'),
              location: 'site-editor',
            })
          })
      },
    })
  }

  return (
    <div className={styles.unused} data-testid="assets-unused-images">
      <span className={styles.unusedLabel}>
        {count} unused {noun} Studio added
      </span>
      <Button variant="ghost" size="xs" onClick={requestPrune}>
        Delete unused…
      </Button>
    </div>
  )
}
