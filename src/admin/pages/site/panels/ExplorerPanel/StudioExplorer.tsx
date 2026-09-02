/**
 * StudioExplorer — the editor's explorer body: Boards above, an all-pages
 * Layers tree below. `ExplorerPanel` mounts this directly — there is no
 * Layers / Site / Code / Media tab row (those were CMS-only content-
 * workspace concepts from before Studio became the only editor mode; the
 * `SiteExplorerPanel` / `MediaExplorerPanel` components that served them are
 * unreachable now), so this component only ever mounts `StudioBoardsList` +
 * `StudioPagesTree`.
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
