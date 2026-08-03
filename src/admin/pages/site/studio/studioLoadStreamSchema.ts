/**
 * studioLoadStreamSchema — the wire shape of `GET /admin/api/studio/load?stream=1`
 * (WS-5.5): a `kind: 'meta'` line (everything except `pages`) first, then one
 * `kind: 'page'` line per page. The non-streamed, single-JSON-envelope shape
 * of this same endpoint (used by tests and any HTTP tooling that just wants
 * one response) is documented server-side by `StudioLoadResult`/`studio.ts`'s
 * load route — this schema only needs to describe the wire shape a CLIENT
 * actually consumes. MUST stay in sync with `studioLoadStreamLines` in
 * `server/handlers/studio/studioLoadResponse.ts`.
 *
 * Pulled out to its own leaf, STORE-AGNOSTIC module rather than living inline
 * in `fsCodemodAdapter.ts` (which imports `useEditorStore` directly) for the
 * same reason `loadedValuesBaseline.ts` was: `studioLiveReloadFetch.ts`'s
 * live-reload bridge is reachable from `executor.ts`, which the editor STORE
 * itself imports transitively — importing anything from `fsCodemodAdapter.ts`
 * there would close a `store.ts -> agent/* -> fsCodemodAdapter.ts -> store.ts`
 * cycle even for a schema that never touches the store.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { ConditionDefSchema, PageSchema, StyleRuleSchema } from '@core/page-tree'
import { TrustTierSchema } from './studioProjectTrust'
import { StyleRuleSourceSchema } from './styleRuleWriteback'

/**
 * One `kind: 'component'` node's classification (Phase 7A — multi-file
 * workspace backend): **local** components resolve to a real file inside the
 * workspace (recorded as a workspace-relative path); **package** components
 * come from a bare specifier (an npm dependency, e.g.
 * `@alm-design/design-system`) and stay a read-only prop surface this slice.
 * Mirrors `ComponentSource` in `@core/page-parser` (server-only ts-morph
 * module) — this file runs in the browser, so it only needs to agree on the
 * JSON wire shape, not import the server-side type.
 */
export const ComponentSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('local'), file: Type.String() }),
  Type.Object({ kind: Type.Literal('package'), specifier: Type.String() }),
])

export type ComponentSource = Static<typeof ComponentSourceSchema>

export const StudioLoadStreamLineSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('meta'),
    dir: Type.String(),
    projectName: Type.String(),
    componentSources: Type.Record(Type.String(), ComponentSourceSchema),
    styleRules: Type.Record(Type.String(), StyleRuleSchema),
    styleRuleSources: Type.Record(Type.String(), StyleRuleSourceSchema),
    conditions: Type.Array(ConditionDefSchema),
    vendorCss: Type.String(),
    trust: TrustTierSchema,
    paletteHiddenModuleIds: Type.Array(Type.String()),
    pageCount: Type.Number(),
    /**
     * mcp-tooling (WS-9's live-reload bridge) — present only on a `?pageIds=`
     * filtered load: every requested id that matched no page (deleted/renamed
     * by the very edit that triggered the reload). `Type.Optional` because an
     * unfiltered load's `JSON.stringify` drops the `undefined`-valued field
     * entirely — see `studioLoadResponse.ts`'s own doc for why this rides in
     * `meta` rather than as a top-level stream line.
     */
    missingPageIds: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    kind: Type.Literal('page'),
    page: PageSchema,
  }),
])

export type StudioLoadStreamLine = Static<typeof StudioLoadStreamLineSchema>
