/**
 * IconsSection — the project's icon catalogue inside the Assets panel.
 *
 * Reads the same client cache the slot picker does (`fetchStudioIconCatalog`,
 * one fetch per project, ~hundreds of KB because the response carries each
 * icon's markup) and sanitises the same way (`sanitizeSvg` before anything is
 * rendered — the panel is same-origin `/admin` chrome, so it is its own trust
 * boundary and does not get to assume the server already checked).
 *
 * **Clicking an icon INSERTS it** as an inline `<svg>` right after the
 * selection (P5-D SVG-5), and **dragging it onto a frame inserts it where the
 * drop line shows** — the same insertion drag every other Assets card uses.
 * Both go through `insertSvgAtTarget` (`canvasSvgInsert.ts`), the one SVG
 * write P5-A's paste uses too: sanitised, converted to JSX (`svgToJsxNode`:
 * no `style` strings, per-insert ids), ONE `insert` of the whole subtree, one
 * undo step. Inline JSX, never an import — see `svgToJsxNode.ts` for why an
 * SVG import is not a write Studio can honestly make.
 *
 * Copying the markup (the old click) is on the icon's context menu.
 *
 * The catalogue is fetched lazily — on first expand, never on panel open — so
 * opening Assets costs nothing for a project whose icons you never look at.
 */
import { useEffect, useRef, useState } from 'react'
import { sanitizeSvg } from '@core/sanitize'
import { getErrorMessage } from '@core/utils/errorMessage'
import { fetchStudioIconCatalog, type StudioIcon } from '@site/studio/iconCatalog'
import { useEditorStore } from '@site/store/store'
import { useCanvasInsertionDrag } from '@site/canvas/useCanvasInsertionDrag'
import { CanvasInsertionDragOverlay } from '@site/canvas/CanvasInsertionDragOverlay'
import { readSelectionInsertTarget } from '@site/canvas/canvasSelectionInsert'
import { insertSvgAtTarget } from '@site/canvas/canvasSvgInsert'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { AssetSection } from './AssetSection'
import { queryTokens } from './rankAssets'
import styles from './AssetsPanel.module.css'

/** How many icons render at once. The set runs to several hundred; search reaches the rest. */
const VISIBLE_LIMIT = 120

interface IconsSectionProps {
  query: string
  collapsed: boolean
  onToggle: () => void
}

export function IconsSection({ query, collapsed, onToggle }: IconsSectionProps) {
  const [icons, setIcons] = useState<StudioIcon[] | null>(null)
  // A ref, not state: "we have already asked" is a fact about this mount, and
  // flipping it in the effect body would be a synchronous setState in an
  // effect (cascading render) for a value nothing renders.
  const requested = useRef(false)

  // Fetch on first expand. `fetchStudioIconCatalog` caches per project, so a
  // collapse/expand cycle — or the slot picker having already asked — costs
  // nothing.
  useEffect(() => {
    if (collapsed || requested.current) return
    requested.current = true
    let cancelled = false
    void fetchStudioIconCatalog().then((list) => {
      if (!cancelled) setIcons(list)
    })
    return () => {
      cancelled = true
    }
  }, [collapsed])

  const tokens = queryTokens(query)
  const matches = (icons ?? []).filter((icon) =>
    tokens.every(
      (token) =>
        icon.name.toLowerCase().includes(token) || icon.group.toLowerCase().includes(token),
    ),
  )
  const visible = matches.slice(0, VISIBLE_LIMIT)
  const [menu, setMenu] = useState<{ icon: StudioIcon; x: number; y: number } | null>(null)

  const insertWords = (icon: StudioIcon) => ({ undoLabel: `Add ${icon.name} icon`, refusalTitle: 'Cannot add that icon' })

  /** Click: right after the selection, else at the end of the active frame's root (⇧K's and ⌘V's rule). */
  function insertIcon(icon: StudioIcon) {
    const target = readSelectionInsertTarget()
    if (!target.ok) {
      pushToast({ kind: 'warning', title: 'Cannot add that icon', body: target.message, location: 'site-editor' })
      return
    }
    void insertSvgAtTarget({ kind: 'text', markup: icon.markup }, target, insertWords(icon))
  }

  // Drag: where the drop line shows. The hook has already made the dropped-on
  // frame's page the active one when this runs.
  const canvasDrag = useCanvasInsertionDrag<StudioIcon>({
    onDrop: (icon, location) => {
      const state = useEditorStore.getState()
      const pageId = state.activePageId
      const page = pageId ? state.site?.pages.find((candidate) => candidate.id === pageId) : undefined
      if (!pageId || !page) return false
      const index = location.index ?? page.nodes[location.parentId]?.children.length ?? 0
      void insertSvgAtTarget({ kind: 'text', markup: icon.markup }, { ok: true, pageId, parentId: location.parentId, index }, insertWords(icon))
      return true
    },
  })

  async function copyIcon(icon: StudioIcon) {
    try {
      await navigator.clipboard.writeText(sanitizeSvg(icon.markup))
      pushToast({ kind: 'success', title: `Copied ${icon.name}`, body: 'SVG markup is on your clipboard.' })
    } catch (err) {
      console.error('[AssetsPanel] copy icon failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy that icon',
        body: getErrorMessage(err, 'Clipboard access was refused'),
      })
    }
  }

  return (
    <AssetSection
      title="Icons"
      count={icons === null ? 0 : matches.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {icons === null ? (
        <EmptyState plain compact title="Loading icons…" />
      ) : visible.length === 0 ? (
        <EmptyState
          plain
          compact
          title="No icons"
          description="Studio offers the icons your installed design system ships as files."
        />
      ) : (
        <>
          <div className={styles.iconGrid}>
            {visible.map((icon) => (
              <Button
                key={icon.id}
                variant="ghost"
                iconOnly
                className={styles.iconTile}
                aria-label={`Add the ${icon.name} icon`}
                tooltip={`Add ${icon.name} — click, or drag onto a frame`}
                onPointerDown={(event) => canvasDrag.startDrag(event, icon, `Drop ${icon.name}`)}
                onClick={() => {
                  // The pointerup that ends a drag also clicks the tile.
                  if (canvasDrag.shouldSuppressClick()) return
                  insertIcon(icon)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ icon, x: event.clientX, y: event.clientY })
                }}
              >
                <span
                  className={styles.iconGlyph}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: sanitizeSvg(icon.markup) }}
                />
              </Button>
            ))}
          </div>
          {matches.length > visible.length && (
            <p className={styles.iconCount}>
              Showing {visible.length} of {matches.length} — keep typing to narrow it down.
            </p>
          )}
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} ariaLabel={`${menu.icon.name} icon actions`} width={188} onClose={() => setMenu(null)}>
          <ContextMenuItem
            onClick={() => {
              const icon = menu.icon
              setMenu(null)
              void copyIcon(icon)
            }}
          >
            <span aria-hidden="true"><CopySolidIcon size={13} /></span>
            Copy SVG
          </ContextMenuItem>
        </ContextMenu>
      )}
      <CanvasInsertionDragOverlay drag={canvasDrag.drag}>
        {canvasDrag.drag && (
          <>
            <span
              className={styles.dragGhostPreview}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(canvasDrag.drag.ghost.markup) }}
            />
            {canvasDrag.drag.ghost.name}
          </>
        )}
      </CanvasInsertionDragOverlay>
    </AssetSection>
  )
}
