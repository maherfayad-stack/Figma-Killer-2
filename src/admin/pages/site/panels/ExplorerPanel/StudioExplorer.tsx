/**
 * StudioExplorer — the editor's explorer body: Boards above, an all-pages
 * Layers tree below, with the board's loose Canvas layers between. `ExplorerPanel` mounts this directly — there is no
 * Layers / Site / Code / Media tab row (those were CMS-only content-
 * workspace concepts from before Studio became the only editor mode, and the
 * panels that served them have been deleted), so this component only ever
 * mounts `StudioBoardsList` + `StudioCanvasLayersList` + `StudioPagesTree`.
 */
import { StudioBoardsList } from './StudioBoardsList'
import { StudioCanvasLayersList } from './StudioCanvasLayersList'
import { StudioPagesTree } from './StudioPagesTree'
import styles from './StudioExplorer.module.css'

interface StudioExplorerProps {
  editable?: boolean
}

export function StudioExplorer({ editable = true }: StudioExplorerProps) {
  return (
    <div className={styles.explorer}>
      <StudioBoardsList />
      <StudioCanvasLayersList />
      <StudioPagesTree editable={editable} />
    </div>
  )
}
