/**
 * ImagesSection — the project's own images inside the Assets panel (P5-B3,
 * IMG-6): every image file already in the repository, as thumbnails you drag
 * onto a frame or click to add beside the selection.
 *
 * ## Nothing is uploaded
 *
 * The file is already in the project, so the insert only REFERENCES it
 * (`ImageDropSource` kind `project`, `landImageSource.ts`): a file the
 * production build serves at a URL (`public/`) is written as that literal
 * `src`; any other file is written as an import (`src={heroPng}` plus
 * `import heroPng from '…'`, the server spelling the specifier). Dragging the
 * same image in twice leaves no second file behind.
 *
 * ## One drag mechanism
 *
 * A card is dragged with the canvas's own pointer gesture
 * (`useCanvasInsertionDrag`), the one every Assets card, notch primitive and
 * inserter uses — never HTML5 drag-and-drop (`single-drag-mechanism`). Its
 * drop line is the one a component gets, and its write is the one a dropped
 * file gets (`insertImagesAtTarget` → `dropImagesIntoPage`): the ghost, the
 * width clamp to the container, one undo step.
 *
 * ## Unused images (IMG-11)
 *
 * The footer names how many images Studio itself added that nothing in the
 * project references any more, with an explicit "Delete unused…" behind a
 * confirmation (`UnusedImagesFooter`). Nothing is ever deleted on its own.
 *
 * The thumbnails come from the authenticated admin preview route
 * (`studioAssetPreviewUrl`), lazily; the list is the cached
 * `project-assets` walk the Fill picker shares, refreshed whenever a drop
 * lands a new file.
 */
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorStore } from '@site/store/store'
import { useCanvasInsertionDrag } from '@site/canvas/useCanvasInsertionDrag'
import { CanvasInsertionDragOverlay } from '@site/canvas/CanvasInsertionDragOverlay'
import { insertImagesAtTarget, readSelectionInsertTarget } from '@site/canvas/canvasSelectionInsert'
import type { ImageDropSource } from '@site/store/slices/site/imageDropShapes'
import { studioAssetPreviewUrl, useProjectImageAssets, type ProjectImageAsset } from '@site/studio/projectAssets'
import { pushToast } from '@ui/components/Toast'
import { IMAGE_DROP_TITLE } from '@site/store/slices/site/imageDropActions'
import { AssetSection } from './AssetSection'
import { queryTokens } from './rankAssets'
import { UnusedImagesFooter } from './UnusedImagesFooter'
import styles from './ImagesSection.module.css'

/** How many thumbnails render at once; search reaches the rest. */
const VISIBLE_LIMIT = 120

interface ImagesSectionProps {
  query: string
  collapsed: boolean
  onToggle: () => void
}

/** What a card's drag carries: the file, and the thumbnail it shows under the cursor. */
interface ImageDragGhost {
  asset: ProjectImageAsset
  name: string
  /** Intrinsic size read off the card's own loaded thumbnail, when there was one. */
  size: { width: number; height: number } | null
}

function assetName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1)
}

/**
 * The intrinsic size of a card's thumbnail, once it has loaded. An SVG with no
 * declared size reports the browser's 150×150 default rather than anything the
 * file says, so an SVG never contributes one — the insert then writes no
 * `width`/`height` at all rather than a number nothing measured.
 */
function thumbnailSize(card: HTMLElement, relPath: string): { width: number; height: number } | null {
  if (/\.svg$/i.test(relPath)) return null
  const img = card.querySelector('img')
  if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null
  return { width: img.naturalWidth, height: img.naturalHeight }
}

function sourceOf(ghost: ImageDragGhost): ImageDropSource {
  return {
    kind: 'project',
    relPath: ghost.asset.relPath,
    src: ghost.asset.src,
    buildSafe: ghost.asset.buildSafe,
    width: ghost.size?.width ?? null,
    height: ghost.size?.height ?? null,
  }
}

export function ImagesSection({ query, collapsed, onToggle }: ImagesSectionProps) {
  const assets = useProjectImageAssets()

  const drag = useCanvasInsertionDrag<ImageDragGhost>({
    // `useCanvasInsertionDrag` has already made the dropped-on frame's page
    // the active one, so the location's ids are that page's.
    onDrop: (ghost, location) => {
      const pageId = useEditorStore.getState().activePageId
      if (!pageId) return false
      insertImagesAtTarget({ pageId, parentId: location.parentId, index: location.index }, [sourceOf(ghost)])
      return true
    },
  })

  function insertBesideSelection(ghost: ImageDragGhost) {
    const target = readSelectionInsertTarget()
    if (!target.ok) {
      pushToast({ kind: 'warning', title: IMAGE_DROP_TITLE, body: target.message, location: 'site-editor' })
      return
    }
    insertImagesAtTarget(target, [sourceOf(ghost)])
  }

  const tokens = queryTokens(query)
  const matches = (assets ?? []).filter((asset) =>
    tokens.every((token) => asset.relPath.toLowerCase().includes(token)),
  )
  const visible = matches.slice(0, VISIBLE_LIMIT)

  function ghostFor(asset: ProjectImageAsset, card: HTMLElement): ImageDragGhost {
    return { asset, name: assetName(asset.relPath), size: thumbnailSize(card, asset.relPath) }
  }

  return (
    <AssetSection
      title="Images"
      count={assets === null ? 0 : matches.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {assets === null ? (
        <EmptyState plain compact title="Loading images…" />
      ) : visible.length === 0 ? (
        <EmptyState
          plain
          compact
          title={tokens.length > 0 ? 'No matching images' : 'No images yet'}
          description="Drop an image file on a frame and it lands in your project, ready to reuse from here."
        />
      ) : (
        <>
          <div className={styles.grid} data-testid="assets-images">
            {visible.map((asset) => {
              const name = assetName(asset.relPath)
              return (
                <Button
                  key={asset.relPath}
                  variant="ghost"
                  className={styles.tile}
                  tooltip={asset.buildSafe ? asset.relPath : `${asset.relPath} — added as an import`}
                  aria-label={`Add image ${name}`}
                  data-testid="assets-image-card"
                  data-asset-path={asset.relPath}
                  onClick={(event) => {
                    // The pointerup that ends a drag also clicks the card it
                    // started from — which would add a SECOND copy.
                    if (drag.shouldSuppressClick()) return
                    insertBesideSelection(ghostFor(asset, event.currentTarget))
                  }}
                  onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) =>
                    drag.startDrag(event, ghostFor(asset, event.currentTarget), `Drop ${name}`)
                  }
                >
                  <span className={styles.thumb}>
                    <img
                      src={studioAssetPreviewUrl(asset.relPath)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                  </span>
                  <span className={styles.name}>{name}</span>
                </Button>
              )
            })}
          </div>
          {matches.length > visible.length && (
            <p className={styles.count}>
              Showing {visible.length} of {matches.length} — keep typing to narrow it down.
            </p>
          )}
        </>
      )}
      <UnusedImagesFooter assets={assets} />

      <CanvasInsertionDragOverlay drag={drag.drag}>
        {drag.drag && (
          <>
            <span className={styles.ghostThumb} aria-hidden="true">
              <img src={studioAssetPreviewUrl(drag.drag.ghost.asset.relPath)} alt="" draggable={false} />
            </span>
            {drag.drag.ghost.name}
          </>
        )}
      </CanvasInsertionDragOverlay>
    </AssetSection>
  )
}
