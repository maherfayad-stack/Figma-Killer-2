/**
 * ExpansionStore — external observable for DOM tree expand/collapse state.
 *
 * Kept out of React state so a toggle notifies the tree without going through
 * the editor store: this is UI-only state and must never enter `siteSlice`
 * (Constraint #182).
 *
 * The expanded set is COPY-ON-WRITE. `getExpandedIds` is the snapshot the
 * windowed list reads through a single `useSyncExternalStore` for the whole
 * tree, and a `useSyncExternalStore` snapshot has to change identity when the
 * data changes — an in-place `Set.add` would leave React (and the React
 * Compiler, which treats the set as an input to the flatten) unable to tell
 * that anything happened. One subscription for the tree replaced one per row:
 * with the tree flattened up front the parent already knows every row's
 * expanded flag, so N per-row external-store subscriptions bought nothing.
 *
 * All public methods are arrow class fields so their references are
 * permanently stable — no bind(), no useCallback() needed at call sites.
 */
export class ExpansionStore {
  private expanded: ReadonlySet<string> = new Set<string>()
  private listeners = new Set<() => void>()

  private notify = () => {
    for (const l of this.listeners) l()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isExpanded = (nodeId: string): boolean => this.expanded.has(nodeId)

  /** Immutable snapshot — a new reference on every actual change, never otherwise. */
  getExpandedIds = (): ReadonlySet<string> => this.expanded

  toggle = (nodeId: string): void => {
    const next = new Set(this.expanded)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    this.expanded = next
    this.notify()
  }

  /** Add a single node to the expanded set. No-op (no notification) if already expanded. */
  expand = (nodeId: string): void => {
    if (this.expanded.has(nodeId)) return
    const next = new Set(this.expanded)
    next.add(nodeId)
    this.expanded = next
    this.notify()
  }

  expandAll = (nodeIds: string[]): void => {
    this.expanded = new Set(nodeIds)
    this.notify()
  }

  collapseAll = (): void => {
    this.expanded = new Set()
    this.notify()
  }
}
