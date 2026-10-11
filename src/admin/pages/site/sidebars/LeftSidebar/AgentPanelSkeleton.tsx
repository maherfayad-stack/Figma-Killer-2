/**
 * AgentPanelSkeleton — the docked AI assistant while its chunk downloads.
 *
 * `AgentPanel` is `lazy()` (its provider catalogue and image code stay off
 * the editor's startup path), and its `Suspense` used to fall back to
 * `null`: the first open of the Agent tab showed an empty column for the
 * whole chunk load (P2-H, UX-24). This draws the panel's own silhouette
 * instead — the real header (so the tab can still be closed), a short
 * conversation of placeholder bubbles, and the composer's bar — so the
 * swap to the real panel changes content, not layout.
 *
 * It lives beside `LeftSidebar`, not in the AgentPanel folder: importing it
 * through that folder's barrel would pull the very chunk it stands in for
 * onto the eager path.
 */
import { useEditorStore } from '@site/store/store'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Skeleton } from '@ui/components/Skeleton'
import styles from './AgentPanelSkeleton.module.css'

export function AgentPanelSkeleton() {
  const closeAgent = useEditorStore((s) => s.closeAgent)

  return (
    <div className={styles.skeleton} aria-busy="true" data-testid="agent-panel-skeleton">
      <PanelHeader panelId="agent" title="AI Assistant" onClose={closeAgent} />
      <div className={styles.thread} role="status" aria-label="Loading AI assistant">
        <div className={styles.userBubble}>
          <Skeleton width="100%" height={28} radius="var(--radius)" />
        </div>
        <div className={styles.agentBubble}>
          <Skeleton width="92%" height={10} />
          <Skeleton width="100%" height={10} />
          <Skeleton width="64%" height={10} />
        </div>
        <div className={styles.userBubble}>
          <Skeleton width="100%" height={28} radius="var(--radius)" />
        </div>
      </div>
      <div className={styles.composer}>
        <Skeleton width="100%" height={56} radius="var(--radius)" />
      </div>
    </div>
  )
}
