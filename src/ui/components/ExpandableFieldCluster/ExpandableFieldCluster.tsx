/**
 * ExpandableFieldCluster — the "one field becomes four" idiom (Figma's
 * padding H/V → T/R/B/L, radius → four corners, stroke weight → four sides),
 * built once so the three consumers cannot draw it three slightly different
 * ways. See `docs/features/inspector-disclosure.md` §3.3 and Law 4.
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

/**
 * Which layout a cluster is showing. `all` is the OPTIONAL most-collapsed
 * state — one field standing for every side at once, Figma's link toggle —
 * and only exists for a cluster that supplies an `all` array.
 */
type ClusterState = 'all' | 'collapsed' | 'expanded'

const stickyStateByClusterId = new Map<string, ClusterState>()

function readStickyState(id: string): ClusterState | undefined {
  return stickyStateByClusterId.get(id)
}

function writeStickyState(id: string, value: ClusterState): void {
  stickyStateByClusterId.set(id, value)
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
  /**
   * OPTIONAL most-collapsed state: ONE field standing for every side at once.
   * Supplying it turns the toggle into a three-way cycle
   * (`all` -> `collapsed` -> `expanded` -> `all`); omitting it leaves the
   * original two-way behaviour untouched.
   */
  all?: ReactNode[]
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
  /** Toggle's aria-label while in the `all` state — names the action that leaves it. Required when `all` is supplied. */
  allLabel?: string
  /**
   * Toggle glyph while COLLAPSED. Defaults to the 2×2 grid mark ("split this
   * into cells"). A cluster whose collapsed state is genuinely one value for
   * every side — corner radius — passes a chain link instead, so the button
   * reads as Figma's link toggle rather than as a generic expander.
   */
  collapsedIcon?: ReactNode
  /** Toggle glyph while EXPANDED. Defaults to the same 2×2 grid mark. */
  expandedIcon?: ReactNode
  /** Toggle glyph while in the `all` state. Defaults to `collapsedIcon`. */
  allIcon?: ReactNode
  className?: string
}

export function ExpandableFieldCluster({
  id,
  all,
  collapsed,
  expanded,
  linked,
  expandLabel,
  collapseLabel,
  allLabel,
  collapsedIcon,
  expandedIcon,
  allIcon,
  className,
}: ExpandableFieldClusterProps) {
  /** The linked resting state: the `all` field when there is one, else the collapsed pair. */
  const restingState: ClusterState = all ? 'all' : 'collapsed'
  const [state, setStateRaw] = useState<ClusterState>(
    () => normalizeState(readStickyState(id), all) ?? (linked ? restingState : 'expanded'),
  )

  const setState = (next: ClusterState) => {
    setStateRaw(next)
    writeStickyState(id, next)
  }

  // Auto-relink: React-19 render-time "adjust state when a prop changes"
  // idiom (no effect — see file doc). `prevLinked` only tracks transitions
  // that happen *while this component is mounted*; a fresh mount (a new
  // node selected) never fires this, so a sticky "expanded" preference is
  // never silently discarded just because the newly-selected node's values
  // happen to already be uniform.
  const [prevLinked, setPrevLinked] = useState(linked)
  if (linked !== prevLinked) {
    setPrevLinked(linked)
    if (linked && state === 'expanded') setState(restingState)
  }

  const handleToggle = () => setState(nextState(state, all != null))

  const isExpanded = state === 'expanded'
  const fields = state === 'expanded' ? expanded : state === 'all' ? all! : collapsed
  const label = state === 'expanded' ? collapseLabel : state === 'all' ? (allLabel ?? expandLabel) : expandLabel
  const stateIcon = state === 'expanded' ? expandedIcon : state === 'all' ? (allIcon ?? collapsedIcon) : collapsedIcon
  const icon = stateIcon ?? <Grid2x22SolidIcon size={14} aria-hidden="true" />

  return (
    <div className={cn(styles.root, className)} data-testid={`expandable-field-cluster-${id}`}>
      <div
        className={isExpanded ? styles.grid : styles.row}
        data-cluster-state={state}
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
        {icon}
      </Button>
    </div>
  )
}

/** The cycle the toggle walks: all -> collapsed -> expanded -> all. */
function nextState(current: ClusterState, hasAll: boolean): ClusterState {
  if (current === 'expanded') return hasAll ? 'all' : 'collapsed'
  if (current === 'all') return 'collapsed'
  return 'expanded'
}

/** A sticky `all` from a previous mount is meaningless for a cluster with no `all` slot. */
function normalizeState(sticky: ClusterState | undefined, all: ReactNode[] | undefined): ClusterState | undefined {
  if (sticky === undefined) return undefined
  if (sticky === 'all' && !all) return 'collapsed'
  return sticky
}
