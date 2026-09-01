import { useEffect, useRef, type CSSProperties } from 'react'
import { selectRightSidebarExpanded, useEditorStore } from '@site/store/store'
import { PropertiesPanel } from '@site/panels/PropertiesPanel'
import { CommentsPanel } from '@site/panels/CommentsPanel'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import type { RightSidebarTab } from '@site/store/slices/uiSlice'
import styles from './RightSidebar.module.css'

const TABS: ReadonlyArray<{ value: RightSidebarTab; label: string }> = [
  { value: 'properties', label: 'Properties' },
  { value: 'comments', label: 'Comments' },
]

/**
 * Right-sidebar mode — picked by the parent layout based on workspace and
 * permissions. Decouples the sidebar's expanded/collapsed state from the
 * (async) availability of its `contentPanel`:
 *
 * - `site`     — Site editor. Holds the Properties panel (available iff a
 *                node/class is selected AND docked AND not collapsed) and the
 *                Comments panel (available iff `commentsPaneOpen`, set by
 *                arming the `C` tool or the rail toggle). The comments pane is
 *                independent of `propertiesPanelMode`: it is not the properties
 *                panel, so undocking or collapsing that one must not take it
 *                away.
 *
 *                WHEN BOTH ARE AVAILABLE, THE USER PICKS.
 *                Comments used to WIN outright, on the reasoning that clicking
 *                a pin does not clear the node selection, so without a winner
 *                the pane would show stale properties beside a freshly-opened
 *                comment. That reasoning was right about the conflict and wrong
 *                about the remedy: it made the inspector unreachable during a
 *                review. Selecting an element with the comments pane open did
 *                nothing visible at all — the panel was not underneath the
 *                comments, it was not rendered.
 *
 *                So the arbitration is a visible tab strip, shown only when
 *                both panels are actually available, and it defaults to
 *                whichever surface the user last acted on: selecting something
 *                switches to Properties (the effect below), opening a thread or
 *                arming the tool switches to Comments (`commentsSlice`). The
 *                stale-properties case the old rule feared cannot happen,
 *                because a selection is what puts the sidebar on Properties in
 *                the first place.
 * - `hidden`   — Site viewer (no `pages.draft.save` capability). Always
 *                closed; renders nothing inside.
 */
type RightSidebarMode = 'site' | 'hidden'

interface RightSidebarProps {
  mode: RightSidebarMode
}

export function RightSidebar({ mode }: RightSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const propertiesPanel = useEditorStore((s) => s.propertiesPanel)
  const propertiesPanelMode = useEditorStore((s) => s.propertiesPanelMode)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)

  const isDocked = propertiesPanelMode === 'docked'
  const sitePropertiesExpanded = useEditorStore(selectRightSidebarExpanded)
  const commentsPaneOpen = useEditorStore((s) => s.commentsPaneOpen)
  const rightSidebarTab = useEditorStore((s) => s.rightSidebarTab)
  const setRightSidebarTab = useEditorStore((s) => s.setRightSidebarTab)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedSelectorClassId = useEditorStore((s) => s.selectedSelectorClassId)
  const hasFrameSelection = useEditorStore((s) => s.selectedFrameIds.length > 0)

  const commentsAvailable = mode === 'site' && commentsPaneOpen
  const propertiesAvailable = mode === 'site' && isDocked && sitePropertiesExpanded
  const bothAvailable = commentsAvailable && propertiesAvailable
  // A tab can only be active if its panel is there at all, so a stale
  // `rightSidebarTab` can never blank the sidebar.
  const showComments = commentsAvailable && (!propertiesAvailable || rightSidebarTab === 'comments')

  /**
   * Selecting something on the canvas puts the sidebar on Properties.
   *
   * The counterpart of `commentsSlice`'s "opening a thread selects Comments":
   * between them, the tab always follows the surface the user last acted on, so
   * the strip is a correction rather than a thing you have to drive. Clicking a
   * comment pin does not change the node selection, so the two never fight.
   */
  useEffect(() => {
    if (!selectedNodeId && !selectedSelectorClassId && !hasFrameSelection) return
    setRightSidebarTab('properties')
  }, [selectedNodeId, selectedSelectorClassId, hasFrameSelection, setRightSidebarTab])

  // Width is derived purely from synchronous state — same model the
  // left sidebar uses. No dependence on the async `contentPanel` prop
  // means the sidebar lands at its final width on first paint and
  // stays there, only changing when the user explicitly toggles
  // open/close (which the CSS transition in RightSidebar.module.css
  // animates smoothly).
  const isExpanded = commentsAvailable || (mode === 'site' ? sitePropertiesExpanded : false)

  const panelWidth = isExpanded ? propertiesPanel.width : 0

  const style = {
    '--right-sidebar-panel-width': `${panelWidth}px`,
    '--right-sidebar-panel-layout-width': `${propertiesPanel.width}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={styles.sidebar}
      data-testid="right-sidebar"
      data-expanded={isExpanded ? 'true' : 'false'}
      data-mode={propertiesPanelMode}
      style={style}
    >
      {isExpanded && (
        <SidebarResizeHandle
          side="right"
          width={propertiesPanel.width}
          targetRef={sidebarRef}
          cssVariable="--right-sidebar-panel-width"
          layoutCssVariable="--right-sidebar-panel-layout-width"
          ariaLabel="Resize right sidebar"
          onResize={(width) => setPropertiesPanel({ width })}
        />
      )}

      <div className={styles.stack}>
        {/*
          Only when there is a genuine conflict. A tab strip over a lone panel
          is chrome describing a choice the user does not have.
        */}
        {bothAvailable && (
          <div className={styles.tabs} data-testid="right-sidebar-tabs">
            <SegmentedControl<RightSidebarTab>
              value={showComments ? 'comments' : 'properties'}
              options={TABS}
              onChange={setRightSidebarTab}
              fullWidth
              aria-label="Right sidebar panel"
            />
          </div>
        )}

        {showComments ? (
          <div className={styles.panelSlot} data-testid="right-sidebar-panel-slot">
            <CommentsPanel />
          </div>
        ) : (
          mode === 'site' &&
          isDocked && (
            <div
              className={styles.panelSlot}
              data-testid="right-sidebar-panel-slot"
              inert={isExpanded ? undefined : true}
            >
              <PropertiesPanel variant="docked" />
            </div>
          )
        )}
      </div>
    </aside>
  )
}
