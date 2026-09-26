/**
 * VariantsCard — the directions a turn planned, as thumbnails (AI-28).
 *
 * A creative turn plans N variants (`studio_plan_variants`), builds each as
 * its own page and screenshots it. The transcript used to say so in text and
 * leave the pictures scattered through the tool rows; this puts one tile per
 * variant side by side under the turn. A tile's picture is the newest
 * screenshot of that page in the same turn (`variantTiles`) — a variant the
 * turn never captured says so instead of borrowing a picture of something else.
 * Pictures are session-only, like every tool image: a reloaded conversation
 * shows the tiles without them.
 */
import { Button } from '@ui/components/Button'
import type { AgentPreviewImage } from './agentImageTypes'
import type { VariantTile } from './turnPresentation'
import styles from './AgentPanel.module.css'

export function VariantsCard({
  tiles,
  onOpenImage,
}: {
  tiles: readonly VariantTile[]
  onOpenImage(image: AgentPreviewImage): void
}) {
  return (
    <section className={styles.variants} aria-label="Design directions">
      <p className={styles.variantsTitle}>{tiles.length} directions</p>
      <div className={styles.variantGrid}>
        {tiles.map((tile) => (
          <figure key={tile.pageName} className={styles.variantTile}>
            {tile.image ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                shape="flush"
                className={styles.variantThumb}
                aria-label={`Open variant ${tile.letter}: ${tile.pageName}`}
                aria-haspopup="dialog"
                onClick={() =>
                  onOpenImage({
                    id: `variant-${tile.pageName}`,
                    src: tile.image!,
                    alt: `Variant ${tile.letter}: ${tile.pageName}`,
                    title: `Variant ${tile.letter} — ${tile.pageName}`,
                    filename: tile.pageName,
                  })
                }
              >
                <img className={styles.variantThumbImage} src={tile.image} alt="" draggable={false} />
              </Button>
            ) : (
              <div className={styles.variantThumb}>
                <span className={styles.variantThumbEmpty}>Not captured yet</span>
              </div>
            )}
            <figcaption className={styles.variantLabel}>
              {tile.letter} · {tile.pageName}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}
