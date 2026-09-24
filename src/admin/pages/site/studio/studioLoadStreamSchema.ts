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
import { CanvasLayerIdSchema } from '@core/studio-board'
import { TrustTierSchema } from './studioProjectTrust'
import { StyleRuleSourceSchema } from './styleRuleWriteback'
import { StyledRuleSourceSchema } from './styledRuleSources'

/**
 * One `kind: 'component'` node's classification (Phase 7A — multi-file
 * workspace backend): **local** components resolve to a real file inside the
 * workspace (recorded as a workspace-relative path); **package** components
 * come from a bare specifier (an npm dependency) and stay a read-only prop
 * surface this slice; **design-system** components come from Studio's own
 * built-in design system, reached through the project's `design-system/`
 * folder, and are a black box by design (`name` is the component's public
 * export name — what `alm.<Name>` is minted from).
 *
 * Mirrors `ComponentSource` in `@core/page-parser` (server-only ts-morph
 * module) — this file runs in the browser, so it only needs to agree on the
 * JSON wire shape, not import the server-side type. **A variant missing here
 * fails the whole `meta` line's validation, which fails the whole load** — so
 * this union is not optional bookkeeping, it is the load contract.
 */
export const ComponentSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('local'), file: Type.String() }),
  Type.Object({ kind: Type.Literal('package'), specifier: Type.String() }),
  Type.Object({ kind: Type.Literal('design-system'), name: Type.String() }),
])

export type ComponentSource = Static<typeof ComponentSourceSchema>

/**
 * WB-23/WB-24 — one thing the load degraded instead of failing. Mirrors
 * `StudioLoadWarning` in `server/handlers/studio/studioLoadContract.ts`:
 * `tsconfig-unreadable` (the project loaded without its tsconfig, so path
 * aliases do not resolve), `syntax-error` (a page's own file does not
 * parse; it renders from a recovered tree and every write to the file is
 * refused, naming the line, until it parses) and `unreadable-page-export`
 * (P3-B WB-5: the page's default export is a shape Studio cannot read a
 * component out of; its frame names the shape instead of "This page is empty").
 */
const StudioLoadWarningSchema = Type.Union([
  Type.Object({ code: Type.Literal('tsconfig-unreadable'), file: Type.Literal('tsconfig.json'), message: Type.String() }),
  Type.Object({
    code: Type.Literal('syntax-error'),
    pageId: Type.String(),
    file: Type.String(),
    line: Type.Number(),
    col: Type.Number(),
    message: Type.String(),
  }),
  Type.Object({
    code: Type.Literal('unreadable-page-export'),
    pageId: Type.String(),
    file: Type.String(),
    line: Type.Number(),
    col: Type.Number(),
    message: Type.String(),
  }),
])

export type StudioLoadWarning = Static<typeof StudioLoadWarningSchema>

/**
 * P5-G — one loose layer on the free canvas, as `/load` carries it. Mirrors
 * `CanvasLayerLoad` in `server/handlers/studio/studioLoadContract.ts`. The
 * layer id is validated against the one id grammar here too, so nothing the
 * client later builds from it (a page id, a `canvas-layer-*` edit) can carry
 * a malformed one.
 */
export const CanvasLayerLoadSchema = Type.Object({
  layerId: CanvasLayerIdSchema,
  pageId: Type.String(),
  page: PageSchema,
})

export type CanvasLayerLoad = Static<typeof CanvasLayerLoadSchema>

export const StudioLoadStreamLineSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('meta'),
    dir: Type.String(),
    projectName: Type.String(),
    componentSources: Type.Record(Type.String(), ComponentSourceSchema),
    styleRules: Type.Record(Type.String(), StyleRuleSchema),
    styleRuleSources: Type.Record(Type.String(), StyleRuleSourceSchema),
    /**
     * W4-4 Phase B — the CSS-in-JS counterpart of `styleRuleSources`: which
     * styled-component template (a `.tsx` file plus the `styled.…` tag's
     * `line:col`) each rule flattened out of. A styled rule reaches the
     * registry through `extraCss` and so never appears in `styleRuleSources`;
     * this is what lets a VALUE edit on one write back into the user's own
     * template instead of being refused as unmapped.
     */
    styledStyleRuleSources: Type.Record(Type.String(), StyledRuleSourceSchema),
    conditions: Type.Array(ConditionDefSchema),
    vendorCss: Type.String(),
    /**
     * `board-27` — the project's own stylesheets, read RAW and concatenated
     * in cascade order. `styleRules`/`StyleRuleSchema` above lost fidelity
     * going through happy-dom's CSSOM (`color-mix()`, system colours,
     * slash-alpha `rgb()` all silently dropped) — `AuthoredCssInjector`
     * renders THIS text instead, so the canvas matches what a real browser
     * would render. See `server/handlers/studioCss.ts`'s "CSSOM in Bun" doc.
     */
    authoredCss: Type.String(),
    /**
     * WB-23/WB-24 — see `StudioLoadWarningSchema`. `Type.Optional` for the
     * reason `projectKey` below is: the real route always sends it, but the
     * hand-written fixture lines across this codebase's tests predate it.
     * `unreadable-page-export` reaches the frame (`studioLoadWarningsStore.ts`
     * → `CanvasEmptyPageHint`); the in-frame `syntax-error` badge is canvas
     * work left for a later pass — the write refusal already names the line.
     */
    warnings: Type.Optional(Type.Array(StudioLoadWarningSchema)),
    trust: TrustTierSchema,
    /**
     * L8 Phase A (`perf-06`, STATE.md) — the `/p/<projectKey>` path segment
     * `server/liveOrigin.ts` (L2) routes on, `registeredMcpServerProjectKey(dir)`'s
     * server-only sanitization of `dir` (NOT a plain basename — spaces and
     * other non-`[A-Za-z0-9._-]` characters become `_`, so a client can't
     * safely re-derive it from `dir` alone without risking drift from the
     * real routing key). `null` below Tier 2 — there is no live origin to
     * scope a URL against. `Type.Optional` (not just nullable), same
     * reasoning as `missingPageIds` below: every real route response always
     * sends it, but the many hand-written fixture lines across this
     * codebase's existing tests predate this field and have no reason to
     * know about it.
     */
    projectKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    /**
     * P5-G — the free canvas's loose layers, ALWAYS the full set (a narrowed
     * load included), each a parsed `.studio/canvas/<id>.tsx`. They ride the
     * meta line rather than the `page` lines on purpose: the client stores them
     * apart from `site.pages` (`canvasLayerSlice.ts`), which is what keeps them
     * out of every page list, publish and preview. `Type.Optional` for the
     * fixture-lines reason `projectKey` gives.
     */
    canvasLayers: Type.Optional(Type.Array(CanvasLayerLoadSchema)),
    /**
     * The project-relative directory served at the site root (`public`, or
     * `apps/web/public`), so a design canvas can DISPLAY `<img src="/x.png">`
     * through the asset route (`studioPublicAssets.ts`). Optional for the
     * fixture-lines reason `projectKey` gives.
     */
    publicRoot: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('page'),
    page: PageSchema,
  }),
])

export type StudioLoadStreamLine = Static<typeof StudioLoadStreamLineSchema>
