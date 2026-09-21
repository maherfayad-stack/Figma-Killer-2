/**
 * AssetCard — one insertable thing in the Assets panel.
 *
 * The card IS the action (a `Button`), so the whole tile is the click target;
 * the favourite star sits beside it rather than inside it, because a button
 * inside a button is invalid HTML and a click on the star must not insert.
 *
 * Four things are shown, in the order a designer looks for them: what it looks
 * like (`AssetPreview`), what it is called, what it is for (the description,
 * clamped to two lines), and — only when the search hit came from a keyword
 * rather than the name — WHY it matched, as a small chip. That chip is the
 * honest answer to "why is `Chip` in my results for 'pill'?".
 *
 * `speed-06` — the card is also a DRAG source: `onPointerDown` starts
 * `useCanvasInsertionDrag`'s gesture the same way the notch's own primitives
 * do (`AssetsPanel.tsx` owns the one shared hook instance and its overlay). A
 * plain click still inserts at the current selection; the card stays an
 * ordinary `Button` either way — no new element, no changed a11y semantics.
 */
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@ui/components/Button'
import { StarSolidIcon } from 'pixel-art-icons/icons/star-solid'
import { cn } from '@ui/cn'
import { itemDescription, type AssetItem } from './assetsModel'
import { AssetPreview } from './AssetPreview'
import styles from './AssetCard.module.css'

interface AssetCardProps {
  item: AssetItem
  /** The keyword that earned this card its place in the results, if any. */
  matchedKeyword: string | null
  favorite: boolean
  onInsert: () => void
  onToggleFavorite: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void
  /** `speed-06` — starts a canvas-insertion drag from this card. Omitted keeps the card click-to-insert only (used nowhere today, but keeps the prop honestly optional rather than assumed). */
  onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}

export function AssetCard({
  item,
  matchedKeyword,
  favorite,
  onInsert,
  onToggleFavorite,
  onContextMenu,
  onDragStart,
}: AssetCardProps) {
  const disabled = Boolean(item.disabledReason)
  return (
    <div className={styles.cell} onContextMenu={onContextMenu}>
      <Button
        variant="ghost"
        className={cn(styles.card, disabled && styles.cardDisabled)}
        disabled={disabled}
        tooltip={item.disabledReason ?? itemDescription(item)}
        data-asset-id={item.id}
        data-asset-kind={item.kind}
        onClick={onInsert}
        onPointerDown={onDragStart}
      >
        <span className={styles.preview}>
          <AssetPreview item={item} />
        </span>
        <span className={styles.name}>{item.name}</span>
        <span className={styles.description}>{itemDescription(item)}</span>
        {matchedKeyword && <span className={styles.keywordChip}>{matchedKeyword}</span>}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        pressed={favorite}
        className={styles.favorite}
        aria-label={
          favorite
            ? `Remove ${item.name} from notch favorites`
            : `Add ${item.name} to notch favorites`
        }
        tooltip={favorite ? 'Remove from the notch' : 'Pin to the notch'}
        onClick={onToggleFavorite}
      >
        <StarSolidIcon size={11} aria-hidden="true" />
      </Button>
    </div>
  )
}
