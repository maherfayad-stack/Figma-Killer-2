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
 *
 * ## All three panels are mounted; the inactive two are `hidden`
 *
 * This is deliberate and unchanged since P1. Switching tabs keeps each
 * surface's scroll offset and transient local state (`InspectPanel`'s
 * copied-key flash, the Design column's scroll position — and the Design
 * column really does scroll: see `docs/features/inspector.md` §6 for the
 * measured numbers), which a mount/unmount swap would throw away on every
 * round trip.
 *
 * The cost is that a section rendered in TWO tabs — `transform`,
 * `animations` and `interaction` all declare `tabs: ['design','prototype']`
 * (`sections/index.ts`) — has two live DOM subtrees at once, only one of
 * them visible. **Anything querying the inspector's DOM must therefore say
 * which tab it means**: a document-wide `[data-section-id="transform"]`
 * lookup finds the hidden Prototype copy even while Design is showing. That
 * is what `data-inspector-tab` below is for — an additive, queryable-only
 * attribute (same posture as `StyleSurface.tsx`'s `data-section-id`), so a
 * caller scopes with `[data-inspector-tab="design"]:not([hidden])` instead
 * of relying on which tabs happen to be mounted today. `STATE.md` panel-37
 * is the defect that made this explicit.
 *
 * ## Each tab is its own failure domain
 *
 * `panel-40` — every tab's content is wrapped in a `PanelBoundary`, so a
 * throw inside Prototype leaves Design, the canvas, the layers tree and the
 * toolbar exactly where they were, and the fallback renders in the tab's own
 * geometry. Before this, the nearest boundary was `AdminCanvasLayout`'s
 * `LazyChunkBoundary location="site-editor-body"` — canvas and panels
 * together — so one section throwing replaced the whole editor body
 * (`verify-3` case 5). The Design tab's SECTIONS have a second, inner
 * boundary each; see `StyleSurface.tsx`'s mount loop.
 */
import { useState, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { PrototypePanel } from '@site/panels/PrototypePanel'
import { InspectPanel } from '@site/panels/InspectPanel'
import { PanelBoundary } from '@site/ui/PanelBoundary'
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
      <div className={styles.tabContent} data-inspector-tab="design" hidden={tab !== 'design'}>
        <PanelBoundary id="design" label="Design" frame="panel">
          {designContent}
        </PanelBoundary>
      </div>
      <div className={styles.tabContent} data-inspector-tab="prototype" hidden={tab !== 'prototype'}>
        <PanelBoundary id="prototype" label="Prototype" frame="panel">
          <PrototypePanel />
        </PanelBoundary>
      </div>
      <div className={styles.tabContent} data-inspector-tab="inspect" hidden={tab !== 'inspect'}>
        <PanelBoundary id="inspect" label="Inspect" frame="panel">
          <InspectPanel />
        </PanelBoundary>
      </div>
    </div>
  )
}
