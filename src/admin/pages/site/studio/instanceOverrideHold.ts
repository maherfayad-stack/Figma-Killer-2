/**
 * instanceOverrideHold — the values an instance override is still writing.
 *
 * OD-19 shows a value edited inside a component instance on the canvas at
 * once, then writes it through `expose-prop` (`instanceOverrideActions.ts`):
 * a one-shot commit that adds an optional prop to the component and passes the
 * value at this one call site. Until that commit settles the tree holds a
 * value the save-diff baseline does not — and the autosave diff
 * (`nodeDiffWriteback.ts`) writes exactly such a value to the element's own
 * source location, which for a node inside a component is the COMPONENT, for
 * every instance. The commit even flushes the autosave first, so without this
 * the "only this instance" edit would have rewritten every instance before it
 * began.
 *
 * So the override holds its keys here for the commit's lifetime and the diff
 * skips them. A hold is released whatever the outcome: a landed write
 * replaced the page (the baseline is the file's again), a refused one rolled
 * the preview back (nothing differs), and the fallback re-applies the edit
 * through the ordinary write with the hold already gone.
 *
 * A leaf module with no imports: `nodeDiffWriteback.ts` reads it and the
 * store writes it, and neither may import the other.
 */
const held = new Map<string, Map<string, number>>()

/** Hold `keys` (prop names, or `style:<property>`) of `nodeId`. Returns the release; calling it twice is harmless. */
export function holdInstanceOverride(nodeId: string, keys: readonly string[]): () => void {
  const forNode = held.get(nodeId) ?? new Map<string, number>()
  held.set(nodeId, forNode)
  for (const key of keys) forNode.set(key, (forNode.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = held.get(nodeId)
    if (!current) return
    for (const key of keys) {
      const count = (current.get(key) ?? 0) - 1
      if (count > 0) current.set(key, count)
      else current.delete(key)
    }
    if (current.size === 0) held.delete(nodeId)
  }
}

/** True while an instance override is writing `key` of `nodeId` — the autosave diff leaves it alone. */
export function isInstanceOverrideHeld(nodeId: string, key: string): boolean {
  return held.get(nodeId)?.has(key) === true
}
