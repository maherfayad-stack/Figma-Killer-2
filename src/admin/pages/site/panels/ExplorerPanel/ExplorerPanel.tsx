/**
 * ExplorerPanel — the consolidated navigation panel.
 *
 * Studio's explorer body: no tab row. Renders `StudioExplorer` directly — a
 * Boards list above an all-pages Layers tree (`StudioPagesTree`). Studio has
 * no separate "Site"/"Code"/"Media" concepts of its own (those were CMS-only
 * content-workspace ideas that lived here as a tab row + `SiteExplorerPanel`/
 * `MediaExplorerPanel`/`DomPanel`-as-tab, before Studio became the only
 * editor mode), so there is nothing else to switch between.
 */
import { Suspense, lazy } from 'react'
import { useEditorStore } from '@site/store/store'
import { Panel } from '@admin/shared/Panel'

// lazy() keeps StudioExplorer (+ StudioBoardsList, StudioPagesTree, their
// prefs + CSS) out of the eager editor-body chunk until the panel actually
// mounts.
const StudioExplorer = lazy(() =>
  import('./StudioExplorer').then((m) => ({ default: m.StudioExplorer })),
)

interface ExplorerPanelProps {
  /** Whether the caller can perform structural edits (drives DnD/insert). */
  editable?: boolean
}

export function ExplorerPanel({ editable = true }: ExplorerPanelProps) {
  const setOpen = useEditorStore((s) => s.setExplorerPanelOpen)

  return (
    <Panel
      panelId="explorer"
      title="Explorer"
      testId="explorer-panel"
      onClose={() => setOpen(false)}
      body="bare"
    >
      <Suspense fallback={null}>
        <StudioExplorer editable={editable} />
      </Suspense>
    </Panel>
  )
}
