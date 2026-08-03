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
import type { Page } from '@core/page-tree'
import { styleValueKey } from '@core/page-tree'

export type LoadedNodeValues = Record<string, string | number | boolean>

let loadedValues = new Map<string, LoadedNodeValues>()

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

/** Replaces the WHOLE baseline — correct after a full `loadSite()`, where the incoming pages ARE the new document. */
export function resetLoadedValues(pages: readonly Page[]): void {
  loadedValues = snapshotNodeValues(pages)
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
}
