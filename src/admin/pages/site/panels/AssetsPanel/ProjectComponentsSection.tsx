/**
 * ProjectComponentsSection — the components the open project declares itself
 * (`components/Card.tsx`), as insertable Assets cards.
 *
 * They were missing: the Assets panel listed registry modules (the design
 * system and packages) and saved Visual Components, so a project's OWN
 * components could not be dragged into a frame or placed from the panel at all.
 * The list is the same parsed-never-executed catalog the Component inspector
 * reads (`componentCatalog.ts`, `GET /admin/api/studio/components`).
 *
 * Insertion is a source write — `<Card />` plus its `import` into the file the
 * target frame element lives in (`insertProjectComponent`) — through the same
 * target resolution every other Assets insert uses (`resolveInsertLocation`:
 * the selected container, else the frame root), and the same drag session
 * (`useCanvasInsertionDrag`) onto a frame. Onto the empty board it lands as a
 * loose layer module that imports the component by a relative path
 * (`placeProjectComponentOnCanvas`).
 *
 * Cards are deliberately plain (name + file): rendering a project component
 * needs its real runtime, which Studio does not start for a thumbnail.
 */
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { resolveInsertLocation, type InsertLocation } from '@site/store/insertLocation'
import { useLocalComponentCatalog } from '@site/studio/componentCatalog'
import type { LocalComponentSpec } from '@site/property-controls/componentPropKind'
import { placeProjectComponentOnCanvas } from '@site/hooks/placeModuleOnCanvas'
import { useCanvasInsertionDrag } from '@site/canvas/useCanvasInsertionDrag'
import { CanvasInsertionDragOverlay } from '@site/canvas/CanvasInsertionDragOverlay'
import { Button } from '@ui/components/Button'
import { AssetGrid, AssetSection } from './AssetSection'
import { insertableProjectComponents, matchProjectComponents } from './projectComponents'
import cardStyles from './AssetCard.module.css'

interface ProjectComponentsSectionProps {
  query: string
  collapsed: boolean
  onToggle: () => void
}

export function ProjectComponentsSection({ query, collapsed, onToggle }: ProjectComponentsSectionProps) {
  const catalog = useLocalComponentCatalog()
  const insertProjectComponent = useEditorStore((s) => s.insertProjectComponent)

  const drag = useCanvasInsertionDrag<LocalComponentSpec>({
    onDrop: (component, location) => insertProjectComponent(component, location.parentId, location.index),
    freeCanvas: {
      accepts: () => true,
      onDrop: placeProjectComponentOnCanvas,
    },
  })

  if (!catalog) return null
  const all = insertableProjectComponents(catalog)
  if (all.length === 0) return null
  const matches = matchProjectComponents(all, query)
  if (matches.length === 0) return null

  // The page and the selection are read when a card is clicked, not
  // subscribed — see `useInsertModule` for why.
  const insertAtSelection = (component: LocalComponentSpec) => {
    const state = useEditorStore.getState()
    const page = selectActiveCanvasPage(state)
    if (!page) return
    const location: InsertLocation | null = resolveInsertLocation(page, state.selectedNodeId ?? page.rootNodeId)
    if (!location) return
    insertProjectComponent(component, location.parentId, location.index)
  }

  return (
    <AssetSection title="Project components" count={matches.length} collapsed={collapsed} onToggle={onToggle}>
      <AssetGrid>
        {matches.map((component) => (
          <div key={`${component.file}#${component.exportName}`} className={cardStyles.cell}>
            <Button
              variant="ghost"
              className={cardStyles.card}
              tooltip={`${component.name} — ${component.file}`}
              data-asset-kind="projectComponent"
              data-asset-id={component.name}
              onClick={() => {
                // The pointerup that ends a drag also fires a click on the
                // card it started from — which would insert a SECOND copy.
                if (drag.shouldSuppressClick()) return
                insertAtSelection(component)
              }}
              onPointerDown={(event) => drag.startDrag(event, component, `Drop ${component.name}`)}
            >
              <span className={cardStyles.name}>{component.name}</span>
              <span className={cardStyles.description}>{component.file}</span>
            </Button>
          </div>
        ))}
      </AssetGrid>
      <CanvasInsertionDragOverlay drag={drag.drag}>
        {drag.drag?.ghost.name}
      </CanvasInsertionDragOverlay>
    </AssetSection>
  )
}
