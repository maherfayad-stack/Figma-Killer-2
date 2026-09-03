/**
 * StudioExplorer — the editor's explorer body: Boards at the top, an all-pages
 * Layers tree below, and Trash at the bottom. `ExplorerPanel` mounts this
 * directly — there is no Layers / Site / Code / Media tab row (those were
 * CMS-only content-workspace concepts from before Studio became the only
 * editor mode; the `SiteExplorerPanel` / `MediaExplorerPanel` components that
 * served them are unreachable now).
 *
 * `StudioTrashList` renders NOTHING while the trash is empty, so it costs a
 * project with nothing deleted no chrome at all — the section appearing is
 * itself the signal. It sits last and outside the pages tree's scroller
 * deliberately: it is a different list about different files, and burying a
 * "where did my page go" answer inside a scrolled tree is how you get asked
 * the question twice.
 */
import { StudioBoardsList } from './StudioBoardsList'
import { StudioPagesTree } from './StudioPagesTree'
import { StudioTrashList } from './StudioTrashList'
import styles from './StudioExplorer.module.css'

interface StudioExplorerProps {
  editable?: boolean
}

export function StudioExplorer({ editable = true }: StudioExplorerProps) {
  return (
    <div className={styles.explorer}>
      <StudioBoardsList />
      <StudioPagesTree editable={editable} />
      <StudioTrashList />
    </div>
  )
}
