/**
 * AssetsPanel — everything you can put on the canvas, in the left rail.
 *
 * Replaces the full-screen insert dialog. A modal was the wrong shape for this
 * job: choosing a component is not a mode you enter and leave, it is something
 * you do WHILE looking at the frame you are building — which is exactly what a
 * docked panel is for, and what Figma's own assets panel is.
 *
 * Sections, in order:
 *   - **Recent** — the last dozen inserts, when there are any and nothing is
 *     typed. Shown first because "the one I just used" is the most likely next
 *     pick, and hidden during a search because a search already says what you
 *     are looking for.
 *   - **Design system** — every code-backed component the project can import,
 *     sub-grouped by purpose (`module.category`), with the package-bundle
 *     refusal notice at its head so an EMPTY list is never silent.
 *   - **Elements** — the `base.*` primitives that have an honest spelling in
 *     source. In Studio that is Container and Text; `moduleAvailability` hides
 *     the rest, because there is no JSX Studio could write for them.
 *   - **Layouts** — saved layouts, then one group per plugin pack.
 *   - **Saved components** — the project's Visual Components.
 *   - **Images** — the project's own image files (`ImagesSection`, IMG-6):
 *     drag one onto a frame, or click to add it beside the selection. Nothing
 *     is uploaded; the insert references the file where it already is.
 *   - **Icons** — the design system's own icon set (`IconsSection`).
 *   - **Colors** — the built-in design system's palette (`ColorsSection`).
 *     Copy a variable, or apply one to the selected layer's fill or text.
 *
 * Clicking a card inserts through `useInsertInserterItem` — the same handler
 * every other insert surface uses, so the target resolution (selected
 * container, else the frame root) and every refusal are identical here and in
 * the canvas selection toolbar.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { registry } from '@core/module-engine'
import { pluginRuntime } from '@core/plugins/runtime'
import type { SavedLayout } from '@core/layouts'
import type { VisualComponent } from '@core/visualComponents'
import { useEditorStore } from '@site/store/store'
import type { InsertLocation } from '@site/store/insertLocation'
import { useInsertInserterItem } from '@site/hooks/useInsertInserterItem'
import { Panel } from '@admin/shared/Panel'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { useCanvasInsertionDrag } from '@site/canvas/useCanvasInsertionDrag'
import { CanvasInsertionDragOverlay } from '@site/canvas/CanvasInsertionDragOverlay'
import {
  buildAssetItems,
  composeLayoutsSection,
  refForAssetItem,
  resolveRecentAssetItems,
  type AssetItem,
} from './assetsModel'
import { readAssetPrefs, trackAssetInsert, useAssetFavorites } from './assetsPrefs'
import { rankAssets, type RankedAsset } from './rankAssets'
import { useModuleInsertionContext } from './useModuleInsertionContext'
import { AssetCard } from './AssetCard'
import { AssetPreview } from './AssetPreview'
import { AssetGrid, AssetGroupLabel, AssetSection } from './AssetSection'
import { buildColorAssetItems } from './colorTokens'
import { ColorsSection } from './ColorsSection'
import { IconsSection } from './IconsSection'
import { ImagesSection } from './ImagesSection'
import { PackageBundleNotice } from './PackageBundleNotice'
import { SavedLayoutManageMenu, type SavedLayoutMenuState } from './SavedLayoutManageMenu'
import { subscribeAssetsSearchFocus } from './assetsPanelFocus'
import styles from './AssetsPanel.module.css'

const EMPTY_COMPONENTS: VisualComponent[] = []
const EMPTY_LAYOUTS: SavedLayout[] = []

/**
 * The palette is a build-time constant — it describes the design system, not
 * the open project — so it is built once for the module rather than per
 * render of a panel that re-renders on every keystroke.
 */
const COLOR_ASSET_ITEMS = buildColorAssetItems()

/**
 * The design system's own purpose groups, in the order its `design.md` states
 * them — a component library reads as a journey (navigate → act → input →
 * choose → list → respond), not as an alphabet. Any group this list has not
 * heard of sorts after these, alphabetically, so a new group appears rather
 * than disappears.
 */
const DESIGN_SYSTEM_GROUP_ORDER = [
  'Navigation',
  'Actions',
  'Inputs',
  'Selection',
  'Lists & cells',
  'Feedback',
  'Progress',
  'Content & cards',
  'Brand',
]

type SectionId =
  | 'recent'
  | 'designSystem'
  | 'elements'
  | 'layouts'
  | 'components'
  | 'images'
  | 'icons'
  | 'colors'

export function AssetsPanel() {
  const setLeftSidebarPanel = useEditorStore((s) => s.setLeftSidebarPanel)
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_COMPONENTS)
  const savedLayouts = useEditorStore((s) => s.site?.layouts ?? EMPTY_LAYOUTS)
  const insertionContext = useModuleInsertionContext()
  const insertItem = useInsertInserterItem()
  const { isFavorite, toggleFavorite } = useAssetFavorites()

  const [query, setQuery] = useState('')
  // Icons and Colors start collapsed on purpose. Icons' catalogue is a few
  // hundred KB (each icon's markup travels with it) and `IconsSection` only
  // fetches on first expand; Colors' grid is where `useSelectionModel` mounts,
  // so leaving it closed keeps the panel's cost at zero until you ask for it.
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionId>>(
    () => new Set<SectionId>(['icons', 'colors']),
  )
  const [recentRefs, setRecentRefs] = useState(() => readAssetPrefs().recent)
  const [layoutMenu, setLayoutMenu] = useState<SavedLayoutMenuState | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Opening the panel from a shortcut or the canvas toolbar means "I want to
  // search" — `assetsPanelFocus` is how those callers say so without the panel
  // having to own a store field for a transient intent.
  useEffect(() => subscribeAssetsSearchFocus(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }), [])

  const { moduleItems, savedLayoutItems, componentItems, allItems } = buildAssetItems({
    modules: registry.list(),
    context: insertionContext,
    savedLayouts,
    visualComponents,
  })

  const designSystemItems = moduleItems.filter((item) => !item.id.startsWith('base.'))
  const elementItems = moduleItems.filter((item) => item.id.startsWith('base.'))
  const layoutsSection = composeLayoutsSection(savedLayoutItems, (pluginId) =>
    pluginRuntime.getPluginName(pluginId),
  )
  const recentItems = resolveRecentAssetItems(recentRefs, allItems)

  const searching = query.trim().length > 0
  const rankedDesignSystem = rankAssets(query, designSystemItems)
  const rankedElements = rankAssets(query, elementItems)
  const rankedLayouts = rankAssets(query, layoutsSection.items)
  const rankedComponents = rankAssets(query, componentItems)
  const rankedRecent = searching ? [] : rankAssets('', recentItems)
  const rankedColors = rankAssets(query, COLOR_ASSET_ITEMS)

  const totalMatches =
    rankedDesignSystem.length +
    rankedElements.length +
    rankedLayouts.length +
    rankedComponents.length +
    rankedColors.length

  function toggleSection(id: SectionId) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // `speed-06` — one drag session shared by every card: the ghost + drop
  // preview overlay is drawn once for the whole panel (`CanvasInsertionDragOverlay`
  // below), exactly the shape the notch's own primitives already use.
  const canvasDrag = useCanvasInsertionDrag<AssetItem>({
    onDrop: (item, location) => handleInsert(item, location),
  })

  function handleInsert(item: AssetItem, target?: InsertLocation) {
    if (!insertItem(item, target)) return false
    trackAssetInsert(refForAssetItem(item))
    setRecentRefs(readAssetPrefs().recent)
    return true
  }

  function renderCard({ item, matchedKeyword }: RankedAsset<AssetItem>) {
    return (
      <AssetCard
        key={item.key}
        item={item}
        matchedKeyword={matchedKeyword}
        favorite={isFavorite(refForAssetItem(item))}
        onInsert={() => {
          // The pointerup that ends a drag also fires a click on the card it
          // started from — which would insert a SECOND copy at the current
          // selection.
          if (canvasDrag.shouldSuppressClick()) return
          handleInsert(item)
        }}
        onToggleFavorite={() => toggleFavorite(refForAssetItem(item))}
        onDragStart={(event) => canvasDrag.startDrag(event, item, `Drop ${item.name}`)}
        onContextMenu={
          item.kind === 'savedLayout'
            ? (event) => {
                event.preventDefault()
                setLayoutMenu({
                  x: event.clientX,
                  y: event.clientY,
                  layoutId: item.id,
                  name: item.name,
                })
              }
            : undefined
        }
      />
    )
  }

  function renderCards(ranked: readonly RankedAsset<AssetItem>[]) {
    return ranked.map(renderCard)
  }

  return (
    <Panel
      panelId="assets"
      title="Assets"
      testId="assets-panel"
      onClose={() => setLeftSidebarPanel(null)}
      body="bare"
    >
      <div className={styles.searchRow}>
        <SearchBar
          ref={searchRef}
          value={query}
          onValueChange={setQuery}
          placeholder="Search components, images, icons & colors…"
          aria-label="Search assets"
        />
      </div>

      <div className={styles.scroll}>
        {rankedRecent.length > 0 && (
          <AssetSection
            title="Recent"
            count={rankedRecent.length}
            collapsed={collapsed.has('recent')}
            onToggle={() => toggleSection('recent')}
          >
            <AssetGrid>{renderCards(rankedRecent)}</AssetGrid>
          </AssetSection>
        )}

        <AssetSection
          title="Design system"
          count={rankedDesignSystem.length}
          collapsed={collapsed.has('designSystem')}
          onToggle={() => toggleSection('designSystem')}
          notice={<PackageBundleNotice size="roomy" />}
        >
          {groupByCategory(rankedDesignSystem).map(([category, group]) => (
            <Fragment key={category}>
              <AssetGroupLabel>{category}</AssetGroupLabel>
              <AssetGrid>{renderCards(group)}</AssetGrid>
            </Fragment>
          ))}
        </AssetSection>

        <AssetSection
          title="Elements"
          count={rankedElements.length}
          collapsed={collapsed.has('elements')}
          onToggle={() => toggleSection('elements')}
        >
          <AssetGrid>{renderCards(rankedElements)}</AssetGrid>
        </AssetSection>

        <AssetSection
          title="Layouts"
          count={rankedLayouts.length}
          collapsed={collapsed.has('layouts')}
          onToggle={() => toggleSection('layouts')}
        >
          {rankedLayouts.length === 0 ? (
            <EmptyState
              plain
              compact
              title="No layouts yet"
              description="Save a selection as a layout to reuse it here."
            />
          ) : (
            <AssetGrid>
              {rankedLayouts.map((ranked) => (
                <Fragment key={ranked.item.key}>
                  {layoutsSection.labelByKey.has(ranked.item.key) && (
                    <AssetGroupLabel>
                      {layoutsSection.labelByKey.get(ranked.item.key)}
                    </AssetGroupLabel>
                  )}
                  {renderCard(ranked)}
                </Fragment>
              ))}
            </AssetGrid>
          )}
        </AssetSection>

        <AssetSection
          title="Saved components"
          count={rankedComponents.length}
          collapsed={collapsed.has('components')}
          onToggle={() => toggleSection('components')}
        >
          {rankedComponents.length === 0 ? (
            <EmptyState
              plain
              compact
              title="No components yet"
              description="Turn a selection into a Visual Component to insert it from here."
            />
          ) : (
            <AssetGrid>{renderCards(rankedComponents)}</AssetGrid>
          )}
        </AssetSection>

        <ImagesSection
          query={query}
          collapsed={collapsed.has('images')}
          onToggle={() => toggleSection('images')}
        />

        <IconsSection
          query={query}
          collapsed={collapsed.has('icons')}
          onToggle={() => toggleSection('icons')}
        />

        <ColorsSection
          ranked={rankedColors}
          collapsed={collapsed.has('colors')}
          onToggle={() => toggleSection('colors')}
        />

        {searching && totalMatches === 0 && (
          <EmptyState
            plain
            compact
            icon={<PackageSolidIcon size={20} />}
            title="No matches"
            description="Try a purpose instead of a name — “header”, “pill”, “row”."
          />
        )}
      </div>

      {layoutMenu && (
        <SavedLayoutManageMenu menu={layoutMenu} onClose={() => setLayoutMenu(null)} />
      )}

      <CanvasInsertionDragOverlay drag={canvasDrag.drag}>
        {canvasDrag.drag && (
          <>
            <span className={styles.dragGhostPreview} aria-hidden="true">
              <AssetPreview item={canvasDrag.drag.ghost} />
            </span>
            {canvasDrag.drag.ghost.name}
          </>
        )}
      </CanvasInsertionDragOverlay>
    </Panel>
  )
}

/**
 * Splits the design-system results into their purpose groups, in
 * `DESIGN_SYSTEM_GROUP_ORDER` first and then alphabetically — deterministic
 * either way, so two renders never disagree about the order.
 */
function groupByCategory(
  ranked: readonly RankedAsset<AssetItem>[],
): [string, RankedAsset<AssetItem>[]][] {
  const groups = new Map<string, RankedAsset<AssetItem>[]>()
  for (const entry of ranked) {
    const category = entry.item.kind === 'module' ? entry.item.category : 'Components'
    const bucket = groups.get(category) ?? []
    bucket.push(entry)
    groups.set(category, bucket)
  }
  return [...groups.entries()].sort(([a], [b]) => {
    const orderA = DESIGN_SYSTEM_GROUP_ORDER.indexOf(a)
    const orderB = DESIGN_SYSTEM_GROUP_ORDER.indexOf(b)
    if (orderA !== -1 && orderB !== -1) return orderA - orderB
    if (orderA !== -1) return -1
    if (orderB !== -1) return 1
    return a.localeCompare(b)
  })
}
