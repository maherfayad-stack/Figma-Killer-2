/**
 * ExpandableFieldCluster — the "one field becomes four" idiom (Figma's
 * padding H/V → T/R/B/L, radius → four corners, stroke weight → four sides),
 * built once so the three consumers cannot draw it three slightly different
 * ways. See `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md` §3.3 and Law 4.
 *
 * This component is deliberately dumb about what a "side" is: it takes two
 * arrays of already-built field nodes (`collapsed`, usually 1–2; `expanded`,
 * usually 4) and a `linked` flag the caller derives from its own values, and
 * it owns exactly three things:
 *
 *   1. Which array is on screen right now.
 *   2. The expand/collapse toggle (a `Button` with `pressed` + `aria-expanded`).
 *   3. Auto-relink: when `linked` flips from false to true while mounted (an
 *      external change — undo, an agent write, a class swap — made every
 *      side equal again), the cluster collapses itself. This mirrors
 *      `BorderControl.tsx`'s existing auto-relink exactly (see that file's
 *      "auto-relinks when external changes bring all sides back to a
 *      uniform value" note) — same render-time idiom, no effect, so there is
 *      no flash and no extra undo entry from a synthetic write. `BorderControl`
 *      keeps its own copy of this logic for now; it is slated for deletion
 *      once `BorderControl` itself is deleted (work order G7), at which point
 *      its copy should be removed in favour of this one.
 *
 * It never touches CSS. Expanding reveals fields the caller already rendered
 * with their current (possibly empty/placeholder) values — nothing is
 * written until the user commits an edit inside one of those fields. Values
 * live entirely with the caller; this component holds no copy of them,
 * only the boolean "which layout is showing".
 *
 * Stickiness — per cluster `id`, not per selection
 * -------------------------------------------------
 * Figma remembers "I expanded padding" independently of which layer you have
 * selected. The properties panel remounts its whole tree on every selection
 * change (`key={selectedNodeId}` in `PropertiesPanel.tsx`), so component
 * state alone resets on every click on the canvas — that would silently
 * re-collapse a cluster the user just expanded. `useEditorPreference`'s
 * catalog is a closed, `as const` union of ids meant for the Settings screen
 * (every entry shows up there); a per-cluster expand flag is not a user
 * setting and there is no clean id to add for it. Instead, expand/collapse
 * state lives in a module-level `Map<string, boolean>` keyed by the `id`
 * prop, outside the React tree the panel remounts. It survives selection
 * changes for the lifetime of the tab and resets on a full reload — which is
 * the right amount of "sticky" for a layout preference, not a durable
 * document setting.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { cn } from '@ui/cn'
import styles from './ExpandableFieldCluster.module.css'

// ---------------------------------------------------------------------------
// Sticky expand/collapse state — module-level, keyed by cluster id.
// ---------------------------------------------------------------------------

const stickyExpandedByClusterId = new Map<string, boolean>()

function readStickyExpanded(id: string): boolean | undefined {
  return stickyExpandedByClusterId.get(id)
}

function writeStickyExpanded(id: string, value: boolean): void {
  stickyExpandedByClusterId.set(id, value)
}

// ---------------------------------------------------------------------------
// ExpandableFieldCluster
// ---------------------------------------------------------------------------

export interface ExpandableFieldClusterProps {
  /**
   * Stable identity for this cluster's sticky expand state, e.g. `'padding'`,
   * `'radius'`, `'border-sides'`. Shared across every node the user selects —
   * that is what makes the toggle sticky "per user" instead of "per
   * selection". Give unrelated clusters distinct ids.
   */
  id: string
  /** Field nodes rendered while collapsed — usually 1 (radius) or 2 (padding H/V). */
  collapsed: ReactNode[]
  /** Field nodes rendered while expanded — usually 4, one per side/corner. */
  expanded: ReactNode[]
  /**
   * Whether every value this cluster represents is currently equal. The
   * caller derives this from its own values (comparing top/right/bottom/left,
   * or the four corners, etc.) — this component keeps no parallel copy and
   * never reads the underlying values itself.
   */
  linked: boolean
  /** Toggle's aria-label while collapsed — names the expand action, e.g. "Expand to individual padding sides". */
  expandLabel: string
  /** Toggle's aria-label while expanded — names the collapse action, e.g. "Collapse to horizontal and vertical padding". */
  collapseLabel: string
  className?: string
}

export function ExpandableFieldCluster({
  id,
  collapsed,
  expanded,
  linked,
  expandLabel,
  collapseLabel,
  className,
}: ExpandableFieldClusterProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(() => readStickyExpanded(id) ?? !linked)

  // Auto-relink: React-19 render-time "adjust state when a prop changes"
  // idiom (no effect — see file doc). `prevLinked` only tracks transitions
  // that happen *while this component is mounted*; a fresh mount (a new
  // node selected) never fires this, so a sticky "expanded" preference is
  // never silently discarded just because the newly-selected node's values
  // happen to already be uniform.
  const [prevLinked, setPrevLinked] = useState(linked)
  if (linked !== prevLinked) {
    setPrevLinked(linked)
    if (linked && isExpanded) {
      setIsExpanded(false)
      writeStickyExpanded(id, false)
    }
  }

  const handleToggle = () => {
    const next = !isExpanded
    setIsExpanded(next)
    writeStickyExpanded(id, next)
  }

  const fields = isExpanded ? expanded : collapsed
  const label = isExpanded ? collapseLabel : expandLabel

  return (
    <div className={cn(styles.root, className)} data-testid={`expandable-field-cluster-${id}`}>
      <div
        className={isExpanded ? styles.grid : styles.row}
        data-testid={`expandable-field-cluster-${id}-fields`}
      >
        {fields.map((field, index) => (
          // Fields are positional (side/corner order) and never reordered,
          // so the index is a stable key.
          <div key={index} className={styles.cell}>
            {field}
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        pressed={isExpanded}
        aria-expanded={isExpanded}
        aria-label={label}
        tooltip={label}
        data-testid={`expandable-field-cluster-${id}-toggle`}
        onClick={handleToggle}
      >
        <Grid2x22SolidIcon size={14} aria-hidden="true" />
      </Button>
    </div>
  )
}
