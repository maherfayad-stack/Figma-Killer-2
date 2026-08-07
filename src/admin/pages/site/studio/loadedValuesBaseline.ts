/**
 * loadedValuesBaseline — the save-diff baseline `fsCodemodAdapter.ts`'s
 * `saveSite` diffs a node's live prop/style values against before deciding
 * whether to ship an edit: every source-backed node's values AS LOADED, keyed
 * by node id, so an untouched prop is never written at all.
 *
 * A full idempotent rewrite is not safe on an imported page. A prop whose
 * source is an expression — `svg={checkSvg}`, `label={t.common.needHelp}` —
 * arrives in the document as the value §7 resolved it to, and `setJsxProp`
 * will happily replace the expression with that baked literal, destroying the
 * binding. Diffing against this baseline is what prevents that.
 *
 * Inline styles are folded in under a `style:` key prefix (`styleValueKey`)
 * so one flat map covers both prop and style diffing.
 *
 * Pulled out to its own leaf, STORE-AGNOSTIC module — as opposed to living
 * inline in `fsCodemodAdapter.ts`, which imports `useEditorStore` directly —
 * so `studioLiveReloadFetch.ts`'s live-reload bridge (reachable from
 * `executor.ts`, which the editor STORE itself imports transitively through
 * `agent/index.ts`) can resync this baseline for a targeted reload WITHOUT
 * creating a `store.ts -> agent/* -> studioLiveReloadFetch.ts ->
 * fsCodemodAdapter.ts -> store.ts` import cycle. Same fix shape as moving
 * `getActiveBoard` out of `boardSlice.ts` into `boardsModel.ts`: a pure
 * function two sides need belongs in a leaf, not in whichever side happened
 * to write it first.
 */
import type { Page, PageNode } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'

export type LoadedNodeValues = Record<string, string | number | boolean>

let loadedValues = new Map<string, LoadedNodeValues>()

/**
 * Phase 0 item 0.6 — the load-time `classIds` baseline `collectClassIdsDrift`
 * diffs against. Studio (filesystem) mode has no `class` edit kind yet
 * (`StudioEditSchema` is `prop`/`text`/`style`/`literal`/`tag`/`asset`/`css`
 * only — see Track B2 / `setJsxClassName`), so a class add/remove/reorder can
 * never reach disk. Tracked separately from `loadedValues` (a different value
 * shape — an ordered id array, not a scalar) but kept in lockstep with it:
 * every function below that resets/merges `loadedValues` does the same to
 * this map in the same call, so the two baselines can never observe a
 * different "as loaded" moment.
 */
let loadedClassIds = new Map<string, readonly string[]>()

/** Narrows a node's `inlineStyles` bag down to the string/number values `setJsxStyle` can write. */
export function literalInlineStyles(inlineStyles: Record<string, unknown> | undefined): Record<string, string | number> {
  const style: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(inlineStyles ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') style[key] = value
  }
  return style
}

/** Snapshot every source-backed node's current literal values — the shape `loadedValues` stores. */
export function snapshotNodeValues(pages: readonly Page[]): Map<string, LoadedNodeValues> {
  const snapshot = new Map<string, LoadedNodeValues>()
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      const values: LoadedNodeValues = {}
      for (const [prop, value] of Object.entries(node.props ?? {})) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          values[prop] = value
        }
      }
      // instance-ui-01 — a `studio.instance`'s call-site props live NESTED
      // (`props.callSiteProps`, deliberately not a flat spread — see
      // `parser-05`'s STATE.md entry), so the loop above's `typeof value ===
      // 'object'` skip never sees them. Snapshot each key under the same
      // `callSiteProps:<name>` convention the codeProps/writeback side
      // already uses, so the diff loop below can tell an edited call-site
      // prop apart from an untouched one exactly like every other prop.
      if (node.moduleId === 'studio.instance') {
        const callSiteProps = (node.props as { callSiteProps?: Record<string, unknown> })?.callSiteProps ?? {}
        for (const [name, value] of Object.entries(callSiteProps)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            values[`callSiteProps:${name}`] = value
          }
        }
      }
      for (const [key, value] of Object.entries(literalInlineStyles(node.inlineStyles))) {
        values[styleValueKey(key)] = value
      }
      snapshot.set(node.id, values)
    }
  }
  return snapshot
}

/** The current baseline entry for one node id, or `undefined` before any load. */
export function getLoadedNodeValues(nodeId: string): LoadedNodeValues | undefined {
  return loadedValues.get(nodeId)
}

/** Snapshot every node's current `classIds` — the shape `loadedClassIds` stores. Nodes with no assigned classes are omitted (equivalent to an empty array on read via `getLoadedClassIds`'s `?? []` callers). */
function snapshotClassIds(pages: readonly Page[]): Map<string, readonly string[]> {
  const snapshot = new Map<string, readonly string[]>()
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds.length > 0) snapshot.set(node.id, [...node.classIds])
    }
  }
  return snapshot
}

/** The current `classIds` baseline entry for one node id, or `undefined` (no classes as-loaded). */
export function getLoadedClassIds(nodeId: string): readonly string[] | undefined {
  return loadedClassIds.get(nodeId)
}

/** Replaces the WHOLE baseline — correct after a full `loadSite()`, where the incoming pages ARE the new document. */
export function resetLoadedValues(pages: readonly Page[]): void {
  loadedValues = snapshotNodeValues(pages)
  loadedClassIds = snapshotClassIds(pages)
}

/**
 * Merges a fresh snapshot into the EXISTING baseline for exactly the given
 * pages — a targeted reload's counterpart to `resetLoadedValues`. Never
 * replaces the whole map: that would erase the baseline for every OTHER page
 * not in this batch, and the next autosave tick would treat every one of
 * THEIR props as user-changed.
 */
export function mergeLoadedValuesBaseline(pages: readonly Page[]): void {
  for (const [nodeId, values] of snapshotNodeValues(pages)) loadedValues.set(nodeId, values)
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds.length > 0) loadedClassIds.set(node.id, [...node.classIds])
      else loadedClassIds.delete(node.id)
    }
  }
}

/** One node whose `classIds` differ from the load-time baseline — Phase 0 item 0.6. `node` is carried through (not just `nodeId`) so the caller can resolve a display label/class names without a second page scan. */
export interface ClassIdsDrift {
  nodeId: string
  node: PageNode
  addedClassIds: readonly string[]
  removedClassIds: readonly string[]
  /** `true` when the exact same SET of classes is present but in a different order — `addedClassIds`/`removedClassIds` are both empty in that case. */
  reordered: boolean
}

/**
 * Diffs every node's CURRENT `classIds` against the load-time baseline —
 * structural only (ids, not display names): the caller (`fsCodemodAdapter
 * .saveSite`, which already has the registry + `site.styleRules` in scope)
 * resolves node labels and class names for the toast. Returns an empty array
 * on the common case — a save tick where no class was touched since the
 * baseline last advanced.
 */
export function collectClassIdsDrift(pages: readonly Page[]): ClassIdsDrift[] {
  const drift: ClassIdsDrift[] = []
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      const before = loadedClassIds.get(node.id) ?? []
      const after = node.classIds
      if (before.length === after.length && before.every((id, i) => id === after[i])) continue
      const beforeSet = new Set(before)
      const afterSet = new Set(after)
      const addedClassIds = after.filter((id) => !beforeSet.has(id))
      const removedClassIds = before.filter((id) => !afterSet.has(id))
      const reordered = addedClassIds.length === 0 && removedClassIds.length === 0
      drift.push({ nodeId: node.id, node, addedClassIds, removedClassIds, reordered })
    }
  }
  return drift
}

/**
 * Advances the `classIds` baseline to the CURRENT document — called
 * unconditionally on every `saveSite` (unlike `commitNodeValuesBaseline`,
 * there is no "did the write land" gate here, because there is nothing to
 * write: Studio has no `class` edit kind. This purely records "last
 * observed," so an already-toasted drift doesn't re-toast on the next 2s
 * tick if nothing has changed since.
 */
export function commitClassIdsBaseline(pages: readonly Page[]): void {
  loadedClassIds = snapshotClassIds(pages)
}

/** One `(nodeId, key)` -> value pair whose write is known to have landed on disk — see `commitNodeValuesBaseline`. */
export interface NodeValueBump {
  nodeId: string
  key: string
  value: string | number | boolean
}

/**
 * Advances the baseline for exactly the `(nodeId, key)` pairs a just-completed
 * save actually wrote — the fix for E1 (`STUDIO-FIGMA-PARITY-PLAN.md` 0.1):
 * without this, `saveSite`'s diff baseline was never advanced by an ordinary,
 * non-reloading save, so `undo()` back to the as-loaded value produced "no
 * diff" against the still-stale baseline on the next autosave tick, and a
 * value the user undid stayed on disk forever with the UI reporting "Saved."
 *
 * Mirrors `styleRuleWriteback.ts`'s `commitBaseline` / `localizedPageWriteback.ts`'s
 * `commitLocalizedTextBaseline` in shape and in WHEN it runs — called by
 * `fsCodemodAdapter.saveSite` right after a successful POST resolves, so the
 * next diff compares against what is now actually on disk instead of what was
 * loaded at the start of the session.
 *
 * Deliberately per-key rather than a wholesale re-snapshot (unlike
 * `resetLoadedValues`/`mergeLoadedValuesBaseline`, which replace an entire
 * node's bag): a save's response only confirms the batch as a WHOLE landed
 * (`written`/`skipped` are aggregate counts across the whole POST, not
 * per-edit), so the caller only invokes this when every edit in the batch is
 * known to have written — see `fsCodemodAdapter.ts`'s `unexplainedSkips === 0`
 * gate before calling this. Never call this for a key whose edit was refused
 * or skipped: doing so would erase the very diff the user still needs to see
 * refused on a later save.
 */
export function commitNodeValuesBaseline(bumps: readonly NodeValueBump[]): void {
  for (const { nodeId, key, value } of bumps) {
    const existing = loadedValues.get(nodeId)
    if (existing) {
      existing[key] = value
    } else {
      loadedValues.set(nodeId, { [key]: value })
    }
  }
}
