/**
 * StudioExplorer — Studio mode's explorer body: Boards above, an
 * all-pages Layers tree below. Replaces the Layers / Site / Code / Media
 * tab row entirely in studio mode (`isStudioMode()`) — the tabbed
 * `SiteExplorerPanel` / `MediaExplorerPanel` surfaces stay CMS-only, so this
 * component only ever mounts `StudioBoardsList` + `StudioPagesTree`.
 */
import { StudioBoardsList } from './StudioBoardsList'
import { StudioPagesTree } from './StudioPagesTree'
import styles from './StudioExplorer.module.css'

interface StudioExplorerProps {
  editable?: boolean
}

export function StudioExplorer({ editable = true }: StudioExplorerProps) {
  return (
    <div className={styles.explorer}>
      <StudioBoardsList />
      <StudioPagesTree editable={editable} />
    </div>
  )
}
