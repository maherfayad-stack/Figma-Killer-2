/**
 * AssetPreview — the picture on an asset card.
 *
 * DS-4 renders the item's declared mark; DS-5 replaces the module case with a
 * live render of the real component inside a shadow root. The seam is here so
 * the card never has to know which it is looking at.
 */
import { ModuleIcon } from '@site/ui/ModuleIcon'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import type { AssetItem } from './assetsModel'
import styles from './AssetCard.module.css'

export function AssetPreview({ item }: { item: AssetItem }) {
  if (item.kind === 'savedLayout') {
    return <LayoutSolidIcon size={20} aria-hidden="true" className={styles.previewGlyph} />
  }
  if (item.kind === 'component') {
    return <BracesIcon size={20} aria-hidden="true" className={styles.previewGlyph} />
  }
  return (
    <ModuleIcon
      module={item.module}
      size={20}
      aria-hidden="true"
      className={styles.previewGlyph}
    />
  )
}
