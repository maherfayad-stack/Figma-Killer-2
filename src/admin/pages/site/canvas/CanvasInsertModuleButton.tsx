/**
 * CanvasInsertModuleButton — the "Insert module" action on the canvas
 * selection toolbar.
 *
 * It used to open the full-screen inserter dialog. It now reveals the
 * **Assets panel** with its search focused (`openAssetsSearch`), which is the
 * same surface the left rail's Assets item opens — one library, reachable from
 * both the chrome and the selection.
 *
 * Nothing about insertion changes: a card clicked in that panel routes through
 * `useInsertInserterItem` → `useInsertModule` → `resolveInsertLocation`, so the
 * node still lands relative to the CURRENT selection — container targets nest
 * it as a last child, leaf targets get a sibling-after under their parent.
 */

import { Button } from '@ui/components/Button'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { openAssetsSearch } from '@site/panels/AssetsPanel'

interface CanvasInsertModuleButtonProps {
  /** Class applied to the trigger button so it matches the toolbar chrome. */
  buttonClassName?: string
}

export function CanvasInsertModuleButton({
  buttonClassName,
}: CanvasInsertModuleButtonProps) {
  return (
    <Button
      variant="secondary"
      size="xs"
      iconOnly
      aria-label="Insert module"
      tooltip="Insert from Assets"
      className={buttonClassName}
      onClick={openAssetsSearch}
    >
      <AppGridPlusGlyphIcon size={13} color="var(--text)" />
    </Button>
  )
}
