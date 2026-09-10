/**
 * InspectorShell — the Design / Prototype / Inspect tab strip
 * `STUDIO-LIVE-CANVAS-PLAN.md` §P1 asks for ("one paradigm: the shell").
 *
 * This wraps `PropertiesPanel`'s EXISTING floating/docked chrome — the
 * `<aside>`, `PanelHeader`, drag handling, `ProjectVariablesProvider` all
 * stay exactly where they were in `PropertiesPanel.tsx`. This component only
 * swaps the CONTENT region below the header:
 *
 *   - **Design** — everything `PropertiesPanelBody` already rendered
 *     (selector inspector, multi-select, VC params, or the default node
 *     surface). Unchanged branching logic; only chrome moved out from
 *     underneath it (see `StyleSurface.tsx`'s own rewrite).
 *   - **Prototype** — `PrototypePanel`'s sections, reused as content, not
 *     forked. Available for ANY selection now, not gated to board-level
 *     prototype mode (`STATE.md` panel-21 decision, user-confirmed
 *     2026-09-08). Entering prototype mode from the canvas toolbar still
 *     jumps the shell here for continuity; leaving is an ordinary tab click.
 *   - **Inspect** — `InspectPanel`'s read-only report, moved out of the left
 *     sidebar (removed in the same change — see `LeftSidebar.tsx`) into a
 *     tab beside the surface it describes, instead of a different panel on
 *     the other side of the canvas.
 *
 * Tabs render REGARDLESS of whether a node is selected — Prototype and
 * Inspect both have real "nothing selected" states of their own already
 * (`EmptyState`/`"Select an element to inspect."`); only Design's own
 * branching (in `PropertiesPanelBody`) decides what that tab shows.
 */
import { useState, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { PrototypePanel } from '@site/panels/PrototypePanel'
import { InspectPanel } from '@site/panels/InspectPanel'
import styles from './InspectorShell.module.css'

export type InspectorTab = 'design' | 'prototype' | 'inspect'

const TABS: ReadonlyArray<{ value: InspectorTab; label: string }> = [
  { value: 'design', label: 'Design' },
  { value: 'prototype', label: 'Prototype' },
  { value: 'inspect', label: 'Inspect' },
]

interface InspectorShellProps {
  designContent: ReactNode
}

export function InspectorShell({ designContent }: InspectorShellProps) {
  const boardMode = useEditorStore((s) => s.boardMode)
  const [tab, setTab] = useState<InspectorTab>('design')
  // Tracks the `boardMode` this render last reconciled against — the
  // React-recommended "adjust state during render" shape for "when this
  // external value changes, reset/derive local state" (react.dev's
  // alternative to a `useEffect` that calls `setState` synchronously, which
  // `react-hooks/set-state-in-effect` correctly flags as a cascading-render
  // smell). Continuity with the canvas toolbar's Design/Prototype toggle —
  // see this file's own doc for why entering prototype mode still moves the
  // shell here even though leaving this tab no longer changes `boardMode`.
  const [reconciledBoardMode, setReconciledBoardMode] = useState(boardMode)
  if (boardMode !== reconciledBoardMode) {
    setReconciledBoardMode(boardMode)
    if (boardMode === 'prototype') setTab('prototype')
  }

  return (
    <div className={styles.shell}>
      <div className={styles.tabBar}>
        <SegmentedControl<InspectorTab>
          value={tab}
          options={TABS}
          onChange={setTab}
          fullWidth
          aria-label="Inspector tab"
        />
      </div>
      <div className={styles.tabContent} hidden={tab !== 'design'}>
        {designContent}
      </div>
      <div className={styles.tabContent} hidden={tab !== 'prototype'}>
        <PrototypePanel />
      </div>
      <div className={styles.tabContent} hidden={tab !== 'inspect'}>
        <InspectPanel />
      </div>
    </div>
  )
}
