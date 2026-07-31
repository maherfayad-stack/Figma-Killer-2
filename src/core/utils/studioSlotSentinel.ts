/**
 * studioSlotSentinel — WS-3.4's wire shape for a package-component prop whose
 * JSX value was captured as a materialized child node rather than a scalar:
 * `"studio-slot:<nodeId>"`.
 *
 * `<Cell icon={<Icon/>}/>` — the page-parser mints `<Icon/>` as a REAL
 * `ParsedNode` (see `parsePageFile.ts`'s slot-capture pass), exactly like any
 * other element, but it is reachable only through this sentinel in the
 * PARENT's `props`, not through `children` (a slot value isn't a DOM child of
 * the host — it's handed to one specific prop). `registerProjectModules.ts`
 * (browser) recognizes the sentinel and renders the referenced node through
 * the ordinary `NodeRenderer`, then passes the resulting React element as
 * that prop's value — reusing the "real, locked node materialized in the
 * flat page tree" shape `base.slot-instance` established for VC slots
 * (see CLAUDE.md §"Visual Components and slots"), not its code path.
 *
 * Mirrors `STUDIO_ASSET_SENTINEL`'s shape (a string prefix naming a real
 * thing elsewhere) but, unlike that sentinel, is never rewritten server-side
 * before the wire: an asset sentinel resolves to a fetchable URL
 * (`rewriteStudioAssetSentinels`); a slot sentinel names a PAGE-TREE NODE ID,
 * which only means something once resolved against the `SiteDocument` the
 * client already holds — there is nothing server-side to resolve it against.
 *
 * Lives in `@core/utils` (dependency-free) rather than `@core/page-parser`
 * (ts-morph-heavy, Node/server-only) because both the parser (server) AND
 * `registerProjectModules.ts` (browser bundle) need the identical prefix —
 * importing the page-parser barrel from browser code would pull ts-morph
 * into the client bundle. Mirrors `ComponentSourceSchema`'s own reasoning in
 * `fsCodemodAdapter.ts`: agree on the wire shape, not the implementation.
 */
export const STUDIO_SLOT_SENTINEL = 'studio-slot:'

/** Builds the sentinel value for a materialized slot child node id. */
export function studioSlotValue(nodeId: string): string {
  return `${STUDIO_SLOT_SENTINEL}${nodeId}`
}

/** The referenced node id, or `undefined` when `value` isn't a slot sentinel. */
export function studioSlotNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith(STUDIO_SLOT_SENTINEL)
    ? value.slice(STUDIO_SLOT_SENTINEL.length)
    : undefined
}
