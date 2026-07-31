/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → every source-derived Studio
 *               Page in the workspace's `pages/` dir, wrapped in a default
 *               SiteDocument shell (multi-frame board — Phase 1 Increment 1B).
 *               `site.settings.framework` (Colors/Typography/Spacing) is then
 *               overridden from `GET /admin/api/studio/framework`, if the
 *               project has a persisted `.studio/framework.json` — otherwise
 *               the default shell's framework settings stand as-is.
 *   saveSite  → POST /admin/api/studio/save   → a batch of typed edits
 *               (`kind: 'prop' | 'text' | 'style' | ...`) for every source-backed
 *               node (id = `relFile:line:col`), written back to the .tsx via
 *               the server-side ts-morph codemods (`setJsxProp` / `setJsxText`
 *               / `setJsxStyle`). `panel-02` (WS-6.3) adds `kind: 'css'`: a
 *               `site.styleRules` base-declaration change is diffed against
 *               `loadedStyleRuleValues` and, for a rule `styleRuleSources`
 *               mapped to a real `.css` file, written through the same
 *               `/save` batch via `setDeclaration` (a postcss CST codemod) —
 *               see `loadedStyleRuleValues`'s doc for the scope (base
 *               declarations only) and `StyleTargetChip` for what a user sees
 *               per tier. Independently, if `site.settings.framework`
 *               changed since the last load/save, it's POSTed to
 *               `/admin/api/studio/framework` — a framework-only edit (no
 *               node prop/text/style changes) still needs to persist, so this
 *               does NOT gate on there being any node edits in the batch.
 *
 * Wired in only when the editor is opened with `?studio` (see AdminCanvasLayout);
 * the normal DB-backed editor is untouched. This is the filesystem-as-truth
 * path — Studio's autosave (debounce / Cmd+S) is the commit-on-idle trigger.
 *
 * Paths live under /admin/api so the Vite dev proxy forwards them to the :3001
 * server (same-origin in prod behind Caddy).
 */
import type { IPersistenceAdapter, SaveSiteOptions } from '@core/persistence/types'
import {
  type Page,
  type SiteDocument,
  type StyleRule,
  ConditionDefSchema,
  PageSchema,
  StyleRuleSchema,
  hasWritableSourceLocation,
  isPropWritableToSource,
  isStyleWritableToSource,
  styleValueKey,
} from '@core/page-tree'
import { apiRequest, ndjsonRequest } from '@core/http'
import { camelToKebabCssProperty } from '@core/css-codemods'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { CUSTOM_HTML_TAG_VALUE } from '@modules/base/utils/htmlTag'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import { pushToast } from '@ui/components/Toast'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { fetchExtractedTokens, type TokenExtractionStatus } from './studioTokenStatus'
import { setStudioTrustTier, TrustTierSchema } from './studioProjectTrust'


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
const ComponentSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('local'), file: Type.String() }),
  Type.Object({ kind: Type.Literal('package'), specifier: Type.String() }),
])

export type ComponentSource = Static<typeof ComponentSourceSchema>

/**
 * GET /admin/api/studio/load?stream=1 — every source-derived page in the
 * workspace, as an NDJSON stream (WS-5.5): the meta line (everything except
 * `pages`, `kind: 'meta'`) first, then one `kind: 'page'` line per page. The
 * non-streamed, single-JSON-envelope shape of this same endpoint (used by
 * tests and any HTTP tooling that just wants one response) is documented
 * server-side by `StudioLoadResult`/`studio.ts`'s load route — this schema
 * only needs to describe the wire shape THIS client actually consumes.
 * MUST stay in sync with `studioLoadStreamLines` in `server/handlers/studio.ts`.
 */
/**
 * `panel-02` (WS-6.3) — a `StyleRule.id`'s write-back target, exactly
 * `server/handlers/studioCss.ts`'s `StyleRuleSource`. A rule id absent from
 * the meta line's `styleRuleSources` map has no hand-editable `.css` source.
 */
const StyleRuleSourceSchema = Type.Object({
  file: Type.String(),
  selector: Type.String(),
})

const StudioLoadStreamLineSchema = Type.Union([
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
  }),
  Type.Object({
    kind: Type.Literal('page'),
    page: PageSchema,
  }),
])

/**
 * POST /admin/api/studio/save response. `shifted` is true when a write changed
 * a file's line count (e.g. `setJsxStyle` collapsing a multiline `style={{…}}`
 * to one line) — the in-memory `line:col` node ids are then stale against disk
 * and must be re-derived by re-parsing (see the `shifted` branch in saveSite).
 */
const StudioSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  written: Type.Number(),
  skipped: Type.Number(),
  shifted: Type.Boolean(),
  /**
   * True when any edit in the batch targeted an inlined node, whose writeback
   * goes to the component's own file and therefore changes EVERY instance of
   * it. The other instances on the board still show their old values, so the
   * client reloads — same remedy as `shifted`, different cause.
   */
  sharedComponents: Type.Boolean(),
  /**
   * WS-4.4/4.5 — every `detach`/`swap` edit in the batch that REFUSED rather
   * than writing, with a specific reason + message (`StudioEditRefusal` on
   * the server). `Type.Optional` (not every server build has this field yet
   * mid-rollout; tolerant like every other response schema here) and defaults
   * to empty when read below.
   */
  refusals: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    kind: Type.String(),
    reason: Type.String(),
    message: Type.String(),
  }))),
  /**
   * instance-ui-01 — every `swap` edit in the batch that SUCCEEDED, with
   * what changed on the call site (mirrors `refusals` for the failure case).
   * `Type.Optional`, same tolerant-rollout reasoning as `refusals` above.
   */
  swapDetails: Type.Optional(Type.Array(Type.Object({
    nodeId: Type.String(),
    removedProps: Type.Array(Type.String()),
    unfilledRequiredProps: Type.Array(Type.String()),
  }))),
})

/** POST /admin/api/studio/page response — the newly scaffolded page. */
const StudioCreatePageResponseSchema = Type.Object({
  ok: Type.Boolean(),
  relPath: Type.String(),
  /** Kebab id derived from the file path — the value a board frame references. */
  pageId: Type.String(),
  title: Type.String(),
})
export type CreatedStudioPage = Static<typeof StudioCreatePageResponseSchema>

/**
 * Creates a new page (`pages/<Component>.tsx` with a starter component) in the
 * active project and resolves to its `{ pageId, title }`. Targets the SAME
 * `dir` every other studio call uses (`getStudioWorkspaceDir`), so the file
 * lands in the project the canvas is currently showing. `name` is optional —
 * omit it and the server auto-names the page `Page`, `Page2`, …. Throws
 * `ApiError` on failure (e.g. a name collision → 409) so the caller can toast
 * the message. The caller reloads the workspace afterwards
 * (`requestCmsSiteReload`) to render the new page.
 */
export function createStudioPage(name?: string): Promise<CreatedStudioPage> {
  const overrideDir = getStudioWorkspaceDir()
  const body: { name?: string; dir?: string } = {}
  if (name) body.name = name
  if (overrideDir) body.dir = overrideDir
  return apiRequest('/admin/api/studio/page', {
    method: 'POST',
    body,
    schema: StudioCreatePageResponseSchema,
  })
}

/**
 * Commits ONE `kind: 'asset'` edit immediately — WS-8.3's "replace this
 * image" action — instead of letting the ordinary optimistic prop-diff loop
 * in `saveSite` pick it up. Deliberately a direct, standalone `apiRequest`
 * call, same shape as `createStudioPage` above, rather than routed through
 * `updateNodeProps`:
 *
 *   - An image swap is a discrete, deliberate commit (pick a file, confirm),
 *     not a value the user is continuously typing — there is nothing to debounce.
 *   - The edit's target is `PageNode.assetOrigin` (the import declaration),
 *     never the node's own `src` prop — writing it as an ordinary prop diff
 *     would need `updateNodeProps`'s codeProps guard to special-case this one
 *     prop, which the store slices do not currently know how to do.
 *   - The save route ALWAYS reports an asset edit as shared
 *     (`isSharedSourceNodeId`'s `kind === 'asset'` branch) because the import
 *     it rewrites can back more than one node — so this always reloads on a
 *     successful write, the same remedy `saveSite` uses for `shifted`/
 *     `sharedComponents`, without needing to wait for the next autosave tick.
 *
 * `nodeId` is the ORIGIN's own `rel:line:col` (`PageNode.assetOrigin`), not
 * the editing node's id — same convention the `literal` edit kind uses for
 * resolved text. `assetPath` is the new file's workspace-relative POSIX path,
 * from `uploadStudioAsset`'s response or an existing asset the picker offered.
 */
export async function saveStudioAssetEdit(nodeId: string, assetPath: string): Promise<void> {
  const overrideDir = getStudioWorkspaceDir()
  const result = await apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: overrideDir ?? loadedDir, edits: [{ kind: 'asset', nodeId, assetPath }] },
    schema: StudioSaveResponseSchema,
  })

  if (result.skipped > 0) {
    pushToast({
      kind: 'error',
      title: 'Image was not saved to source',
      body: 'The import naming this image could not be rewritten — it may no longer exist at the location the canvas last saw.',
    })
    return
  }
  if (result.written > 0) requestCmsSiteReload()
}

/**
 * instance-ui-01 — the outcome of a single `detach`/`swap` edit, as reported
 * to the Properties panel. Mirrors the server's `StudioEditRefusal` /
 * `StudioEditSwapDetail` shapes (`server/handlers/studioWriteback.ts`)
 * one-for-one, without importing them — same "browser/server agree on the
 * wire shape, not the type" split every other schema in this file follows.
 */
export type InstanceCodemodResult =
  | { ok: true; swapDetail?: { removedProps: string[]; unfilledRequiredProps: string[] } }
  | { ok: false; reason: string; message: string }

/**
 * WS-4.4 — the Properties panel's Detach action. A direct, standalone
 * `apiRequest` call (same shape as `saveStudioAssetEdit` above), not routed
 * through `updateNodeProps`/`saveSite`'s diff loop: detach is a deliberate,
 * one-shot structural rewrite (replace the call site with its own inlined
 * JSX), not a value the diff loop's "what did the user type" model fits.
 *
 * A refusal (`uses-hooks`, `maps-over-props`, …) is a NAMED, expected
 * outcome — returned to the caller rather than just toasted, so the panel
 * can offer the `extractComponentCopy` escape hatch inline for the specific
 * reasons that warrant it. `detach` always shifts lines (a call site is
 * replaced by a whole subtree) and is always reported `sharedComponents` by
 * the server (`isSharedSourceNodeId`'s `kind === 'detach'` branch), so a
 * successful write always reloads the board — the detached node's OWN id is
 * about to become stale, same reasoning `saveStudioAssetEdit` already
 * documents for `asset`.
 */
export async function detachInstance(nodeId: string): Promise<InstanceCodemodResult> {
  const overrideDir = getStudioWorkspaceDir()
  const result = await apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: overrideDir ?? loadedDir, edits: [{ kind: 'detach', nodeId }] },
    schema: StudioSaveResponseSchema,
  })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  return { ok: true }
}

/**
 * WS-4.5 — the Properties panel's Swap action. Same standalone-call shape as
 * `detachInstance` above. On success, `swapDetail` names the props the new
 * component dropped and the required props it still needs — the codemod's
 * own numbers, never re-derived here.
 */
export async function swapInstance(
  nodeId: string,
  target: { newComponentName: string; newComponentSource: 'local' | 'package'; newComponentFile: string },
): Promise<InstanceCodemodResult> {
  const overrideDir = getStudioWorkspaceDir()
  const result = await apiRequest('/admin/api/studio/save', {
    method: 'POST',
    body: { dir: overrideDir ?? loadedDir, edits: [{ kind: 'swap', nodeId, ...target }] },
    schema: StudioSaveResponseSchema,
  })
  const refusal = (result.refusals ?? [])[0]
  if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message }
  if (result.written > 0) requestCmsSiteReload()
  const swapDetail = (result.swapDetails ?? []).find((detail) => detail.nodeId === nodeId)
  return { ok: true, swapDetail }
}

/** POST /admin/api/studio/extract-component response — see that route's module doc. */
const ExtractComponentResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), newFile: Type.String(), newComponentName: Type.String() }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String(), message: Type.String() }),
])

/**
 * WS-4.4's detach-refusal escape hatch — the Properties panel's "Card uses
 * useState — duplicate it as Card2.tsx and edit that instead?" offer.
 * Duplicates the instance's own component under a fresh name and repoints
 * THIS call site at the copy; always reloads on success (same "always
 * shifts lines, always shared" posture `detachInstance`/`swapInstance`
 * document — a brand-new file plus a rewritten import is exactly the shape
 * of edit that invalidates in-memory node ids downstream of it).
 */
export async function extractInstanceCopy(nodeId: string): Promise<InstanceCodemodResult & { newFile?: string; newComponentName?: string }> {
  const overrideDir = getStudioWorkspaceDir()
  const result = await apiRequest('/admin/api/studio/extract-component', {
    method: 'POST',
    body: { dir: overrideDir ?? loadedDir, nodeId },
    schema: ExtractComponentResponseSchema,
  })
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
  requestCmsSiteReload()
  return { ok: true, newFile: result.newFile, newComponentName: result.newComponentName }
}

/** GET /admin/api/studio/framework response — `null` when nothing is persisted yet. */
const StudioFrameworkLoadResponseSchema = Type.Object({
  framework: Type.Union([FrameworkSettingsSchema, Type.Null()]),
})

/** POST /admin/api/studio/framework response. */
const StudioFrameworkSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  framework: FrameworkSettingsSchema,
})

/** Remembered from the last load so saveSite can tell the server which folder to write. */
let loadedDir: string | null = null

/**
 * Serialized `site.settings.framework` as of the last load/save — lets
 * `saveSite` tell whether the framework settings actually changed this round,
 * independent of whether there were any per-node prop/text/style edits.
 * `undefined` means "not yet initialized" (before the first `loadSite` call).
 */
let lastSyncedFrameworkJson: string | undefined

/**
 * Remembered from the last load — local-vs-package classification for every
 * `kind: 'component'` node in the workspace, keyed by node id. Consumed by
 * future inspector/property-panel UI that needs to tell a local (editable)
 * component apart from a read-only npm-package one (Phase 7A only resolves
 * and classifies; rendering local components as their own editable canvas
 * modules is deferred — see V1-CANVAS-PLAN.md's Phase 7A backlog note).
 */
let componentSources: Record<string, ComponentSource> = {}

/** WS-3.3 — `.studio/meta.json`'s `paletteHiddenModuleIds` override, from the last load. See `getStudioComponentSources` for the same "remembered from last load" shape. */
let paletteHiddenModuleIds: readonly string[] = []

/**
 * `panel-02` (WS-6.3) — `StyleRule.id -> (file, selector)` from the last
 * load's meta-line `styleRuleSources` (see `StyleRuleSourceSchema`'s doc). A
 * rule id absent here has no hand-editable `.css` source: `StyleTargetChip`
 * reads this to explain why, and `saveSite`'s CSS diff below never attempts
 * a write for it.
 */
let styleRuleSources: Record<string, { file: string; selector: string }> = {}

/** The current workspace's `StyleRule.id -> (file, selector)` write-back map, from the last load. */
export function getStudioStyleRuleSources(): Record<string, { file: string; selector: string }> {
  return styleRuleSources
}

/**
 * Every source-backed node's values AS LOADED, keyed by node id, so `saveSite`
 * can write only what the user actually changed.
 *
 * A full idempotent rewrite is not safe on an imported page. A prop whose
 * source is an expression — `svg={checkSvg}`, `label={t.common.needHelp}` —
 * arrives in the document as the value §7 resolved it to, and `setJsxProp`
 * will happily replace the expression with that baked literal, destroying the
 * binding. Diffing against this baseline means an untouched prop is never
 * written at all.
 *
 * Inline styles are folded in under a `style:` key prefix so one flat map
 * covers both prop and style diffing.
 */
let loadedValues = new Map<string, Record<string, string | number | boolean>>()

/**
 * `panel-02` (WS-6.3) — every style rule's BASE `styles` bag as loaded, keyed
 * by rule id. Same "only write what the user actually changed" discipline as
 * `loadedValues` above, applied to `site.styleRules` instead of node props.
 *
 * Scoped to BASE declarations only — `contextStyles` (breakpoint/condition
 * overrides) are not diffed or written back this pass; see
 * `server/handlers/studioWriteback.ts`'s `CssEditSchema` doc for the honest
 * gap and what would close it (`setDeclarationAtMedia` already exists).
 */
let loadedStyleRuleValues = new Map<string, Record<string, unknown>>()

/** Snapshot for `loadedStyleRuleValues` — see its doc comment. */
function snapshotStyleRuleValues(rules: Record<string, StyleRule>): Map<string, Record<string, unknown>> {
  const snapshot = new Map<string, Record<string, unknown>>()
  for (const [id, rule] of Object.entries(rules)) snapshot.set(id, { ...rule.styles })
  return snapshot
}

/** Snapshot for `loadedValues` — see its doc comment. */
function snapshotNodeValues(pages: readonly Page[]): Map<string, Record<string, string | number | boolean>> {
  const snapshot = new Map<string, Record<string, string | number | boolean>>()
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      const values: Record<string, string | number | boolean> = {}
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

/** The current workspace's local-vs-package classification for every component node, from the last load. */
export function getStudioComponentSources(): Record<string, ComponentSource> {
  return componentSources
}

/** WS-3.3 — the current project's `paletteHiddenModuleIds` override, from the last load. */
export function getStudioPaletteHiddenModuleIds(): readonly string[] {
  return paletteHiddenModuleIds
}

/**
 * WS-2.3 — vendor package CSS from the last load (`StudioLoadStreamLineSchema`'s
 * meta-line `vendorCss` — see its doc). Read-only, concatenated raw bytes; lives OUTSIDE
 * `SiteDocument` for the same reason `componentSources` does above: it is
 * ephemeral, server-derived, per-load state, not part of the
 * persisted/published document shape `SiteDocument` also serves for the CMS
 * half of this fork.
 *
 * A tiny external store (not a Zustand slice) rather than a module-level
 * variable read imperatively: `ProjectCssInjector` needs to know when a fresh
 * value has actually landed so it can re-inject, and `useSyncExternalStore`
 * gives it that without subscribing to `site` itself — a `site` reference
 * changes on every unrelated node edit (Mutative mints a new root object per
 * mutation), which would re-run the injector's DOM work far more often than
 * vendor CSS actually changes (once per project load).
 */
let vendorCss = ''
const vendorCssListeners = new Set<() => void>()

export function getStudioVendorCss(): string {
  return vendorCss
}

export function subscribeStudioVendorCss(listener: () => void): () => void {
  vendorCssListeners.add(listener)
  return () => vendorCssListeners.delete(listener)
}

function setStudioVendorCss(next: string): void {
  if (next === vendorCss) return
  vendorCss = next
  for (const listener of vendorCssListeners) listener()
}

/**
 * `tokens-01` — re-runs server-side token extraction for the CURRENTLY
 * loaded project (`studioTokenStatus.ts`'s `fetchExtractedTokens` does the
 * actual fetch + status-store update) and applies the result to the LIVE
 * document (`applyExtractedFrameworkTokens` — undo-able). This is the
 * Framework panel's "Re-scan tokens" action; `loadSite` below calls
 * `fetchExtractedTokens` directly instead (it has no live document yet to
 * apply the result to). Throws `ApiError` on failure so the caller can toast.
 */
export async function refreshExtractedTokens(): Promise<TokenExtractionStatus> {
  if (loadedDir === null) throw new Error('[fsCodemodAdapter] refreshExtractedTokens called before a project loaded')
  const { framework, status } = await fetchExtractedTokens(loadedDir)
  useEditorStore.getState().applyExtractedFrameworkTokens(framework)
  lastSyncedFrameworkJson = JSON.stringify(framework)
  return status
}

/**
 * Studio's idle-commit cadence — how long the canvas waits after the last
 * edit before writing source back through `saveSite`. Deliberately snappier
 * than the CMS's user-configurable, default-30s cadence (see
 * `readAutoSaveDelayMs` in `preferences/editorPreferences.ts`): a design
 * canvas needs source to "follow" an edit within a beat, and studio has no
 * exposed autosave-delay setting to protect. 2s sits in the middle of the
 * ~1.5-3s target band — long enough that a burst of keystrokes (typing a
 * heading) or a drag gesture collapses into one write instead of one per
 * keystroke, short enough to feel immediate. It stays well above the actual
 * round trip (a same-machine HTTP POST + ts-morph codemod over a handful of
 * `.tsx` files, typically tens of milliseconds), so there's no risk of a
 * save queueing up before the previous one lands.
 */
export const STUDIO_AUTOSAVE_DELAY_MS = 2_000

/**
 * One studio edit — mirrors the discriminated union `server/handlers/studio.ts`
 * validates (`SaveBodySchema`/`StudioEdit`). Kept as a local mirror rather than
 * a shared import: this file runs in the browser, the server file runs in
 * Node/ts-morph, and the two sides only need to agree on the JSON wire shape.
 */
type StudioEditPayload =
  | { kind: 'prop'; nodeId: string; prop: string; value: string | number | boolean }
  | { kind: 'text'; nodeId: string; text: string }
  | { kind: 'style'; nodeId: string; style: Record<string, string | number> }
  | { kind: 'literal'; nodeId: string; text: string }
  | { kind: 'tag'; nodeId: string; tag: string }
  | { kind: 'asset'; nodeId: string; assetPath: string }
  | { kind: 'css'; nodeId: string; file: string; selector: string; property: string; value: string }

/**
 * The HTML tag an element node renders as, or `undefined` when the module has no
 * tag property. `base.container`'s select uses a sentinel plus a free-text
 * `customTag` for anything outside its built-in list, so the effective name is
 * one of two props — collapsed here so the writeback deals in one value.
 */
function effectiveTag(props: Record<string, unknown> | undefined): string | undefined {
  const tag = props?.tag
  if (typeof tag !== 'string') return undefined
  if (tag !== CUSTOM_HTML_TAG_VALUE) return tag
  const custom = props?.customTag
  return typeof custom === 'string' && custom.length > 0 ? custom : undefined
}

/** Narrows a node's `inlineStyles` bag down to the string/number values `setJsxStyle` can write. */
function literalInlineStyles(inlineStyles: Record<string, unknown> | undefined): Record<string, string | number> {
  const style: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(inlineStyles ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') style[key] = value
  }
  return style
}

export const fsCodemodAdapter: IPersistenceAdapter = {
  async loadSite(): Promise<SiteDocument | undefined> {
    // The active project is a subfolder of studio-workspace/ (hand-authored or
    // GitHub-imported) — see studioWorkspaceDir's doc comment for why every
    // studio client call must agree on the same active dir.
    const overrideDir = getStudioWorkspaceDir()
    // WS-5.5 — stream the load response page-by-page (NDJSON) rather than
    // waiting for one buffered JSON body: the meta line (componentSources,
    // styleRules, …) plus every page arrive as separate lines, each parsed
    // and validated as it's received instead of gating on the whole payload.
    // See the server route's own doc comment (`studio.ts`'s
    // `studioLoadStreamLines`) for exactly what this does and does not
    // achieve — server-side parse cost is unchanged, this shortens the time
    // between "server has an answer" and "client has usable bytes".
    type StudioLoadStreamLine = Static<typeof StudioLoadStreamLineSchema>
    let meta: (StudioLoadStreamLine & { kind: 'meta' }) | null = null
    const pages: Page[] = []
    await ndjsonRequest('/admin/api/studio/load', {
      lineSchema: StudioLoadStreamLineSchema,
      query: { ...(overrideDir ? { dir: overrideDir } : {}), stream: 1 },
      onLine: (line) => {
        if (line.kind === 'meta') meta = line
        else pages.push(line.page)
      },
    })
    if (!meta) throw new Error('Studio load stream produced no metadata line.')
    const {
      dir,
      projectName,
      componentSources: sources,
      styleRules,
      styleRuleSources: loadedStyleRuleSources,
      conditions,
      vendorCss: loadedVendorCss,
      trust,
      paletteHiddenModuleIds: loadedPaletteHiddenModuleIds,
    } = meta
    loadedDir = dir
    componentSources = sources
    styleRuleSources = loadedStyleRuleSources
    paletteHiddenModuleIds = loadedPaletteHiddenModuleIds
    setStudioVendorCss(loadedVendorCss)
    setStudioTrustTier(trust)
    // Baseline for the save-time diff — see `loadedValues`.
    loadedValues = snapshotNodeValues(pages)
    // `panel-02` (WS-6.3) — baseline for the CSS write-back diff, see `loadedStyleRuleValues`.
    loadedStyleRuleValues = snapshotStyleRuleValues(styleRules)
    // Distinct from `site.name` (the "Studio" product wordmark, unchanged per
    // project) — this is the per-project display name shown under the brand
    // in the toolbar (see Toolbar.tsx's StudioProjectLabel).
    useAdminUi.getState().setStudioProject({ dir, name: projectName })
    // Wrap the source-derived pages in a valid default site shell (breakpoints,
    // settings, framework, …) — every workspace page becomes a board frame.
    const site = createDefaultSiteDocument('Studio')
    site.pages = pages
    // §6 — styling imported from the workspace's `.css` files, re-derived
    // from disk on every load. `panel-02` (WS-6.3) — an edit to a rule
    // mapped in `styleRuleSources` now reaches disk on the next `saveSite`;
    // an edit to an unmapped rule (Tailwind/Sass/PostCSS output, a CSS
    // Modules compile) still only lives in-memory until reload — see
    // `studioCss.ts`'s "Write-back mapping" doc and `StyleTargetChip`, which
    // states which tier a given class is in.
    site.styleRules = styleRules
    site.conditions = conditions

    // Override the default shell's framework settings with whatever's
    // persisted for this project, if anything — `null` means no
    // `.studio/framework.json` yet, so the default stands as-is.
    const { framework } = await apiRequest('/admin/api/studio/framework', {
      schema: StudioFrameworkLoadResponseSchema,
      query: overrideDir ? { dir: overrideDir } : undefined,
    })
    if (framework) site.settings.framework = framework

    // `tokens-01` — populate the Framework panel from the project's OWN
    // design tokens (`:root` custom properties, a Tailwind theme, or a vendor
    // design-system package's CSS — see `tokenExtract.ts`). Runs every load:
    // the server's own merge only ever fills a currently-EMPTY family, so
    // this is a no-op once populated (by extraction or by the user), and it
    // means a project whose tokens only became reachable later — e.g. after
    // "Install dependencies" resolves a vendor CSS import — picks them up on
    // the very next load, with no separate "re-scan" step required. A
    // failure here (e.g. the route isn't wired up yet) must not block the
    // rest of the project from loading — logged, not thrown.
    try {
      const tokensResult = await fetchExtractedTokens(dir)
      site.settings.framework = tokensResult.framework
    } catch (err) {
      console.error('[fsCodemodAdapter] token extraction failed', err)
    }

    lastSyncedFrameworkJson = JSON.stringify(site.settings.framework)

    return site
  },

  async saveSite(site: SiteDocument, _opts: SaveSiteOptions = {}): Promise<void> {
    // Collect current literal props + inline styles for every source-backed
    // node across all pages. Re-writing unchanged values is idempotent, so we
    // don't need a per-field diff for this first pass. Synthetic nodes (e.g.
    // `index:body`) don't match the loc pattern and are skipped server-side.
    const edits: StudioEditPayload[] = []

    for (const page of site.pages) {
      for (const node of Object.values(page.nodes)) {
        // The module's declared inline-text-edit prop (if any) routes that
        // one prop as a `text` edit (rewrites the element's text children)
        // instead of a `prop` edit (rewrites an attribute) — capturing it as
        // an attribute would corrupt the source (e.g. `label="Click me"` on a
        // <Button> whose label is really its text child).
        const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
        const baseline = loadedValues.get(node.id)

        // A resolved text's ORIGIN is a literal in some other file, so this
        // branch does not care whether the node's own id is a writable JSX
        // location — which is what lets a `.map` row be edited individually. Each
        // iteration resolved a DIFFERENT array element, so each carries its own
        // origin and writes only its own string.
        if (textProp !== undefined && node.textOrigin) {
          const value = node.props?.[textProp]
          if (typeof value === 'string' && !(baseline && Object.is(baseline[textProp], value))) {
            const { rel, line, col } = node.textOrigin
            edits.push({ kind: 'literal', nodeId: `${rel}:${line}:${col}`, text: value })
          }
        }

        // No single source location to write to (a synthetic `index:body` root, a
        // `.map` iteration). Reached only after the text-origin branch above,
        // which is why a `.map` row can still have its own copy edited.
        if (!hasWritableSourceLocation(node.id)) continue

        // The element's own name, not an attribute — see `effectiveTag`. Diffed
        // against the loaded baseline the same way, then routed to the rename
        // codemod instead of the attribute writer.
        // Restricted to `base.*`, whose source element IS the host tag at this
        // location. A design-system component's `tag`, if it has one, is a real
        // prop it forwards — renaming `<Sheet>` is not what the user asked for.
        if (node.moduleId.startsWith('base.')) {
          const tag = effectiveTag(node.props)
          const baselineTag = effectiveTag(baseline)
          if (tag !== undefined && tag !== baselineTag) {
            edits.push({ kind: 'tag', nodeId: node.id, tag })
          }
        }

        for (const [prop, value] of Object.entries(node.props ?? {})) {
          if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
          // Already emitted as a `tag` edit above; writing either as an attribute
          // would put a junk `tag="section"` on the element and leave it a `<div>`.
          if (prop === 'tag' || prop === 'customTag') continue
          // Only write what the USER actually changed. This is the guard that
          // makes writeback safe on an imported page: a prop whose source is
          // an expression (`svg={checkSvg}`, `label={t.common.needHelp}`)
          // arrives here as the value §7 resolved it to, and re-writing that
          // unchanged value would replace the expression with a baked literal
          // — silently destroying the binding. `setJsxText` refuses that on
          // the text path, but `setJsxProp` will happily do it.
          if (baseline && Object.is(baseline[prop], value)) continue
          // Second gate on the same rule the store applies, here because THIS is
          // the boundary that writes files: `updateNodeProps` refuses a
          // code-valued prop, but a tree can also arrive from an agent or a
          // plugin, and a mis-aimed `setJsxProp` bakes a literal over a binding.
          if (!isPropWritableToSource(node, prop)) continue
          // Already emitted as a `literal` edit aimed at its origin, above.
          if (prop === textProp && node.textOrigin) continue
          if (prop === textProp) {
            edits.push({ kind: 'text', nodeId: node.id, text: String(value) })
          } else {
            edits.push({ kind: 'prop', nodeId: node.id, prop, value })
          }
        }

        // instance-ui-01 — a `studio.instance`'s call-site props are a
        // NESTED bag (`props.callSiteProps`), invisible to the flat loop
        // above. Same diff/writability/text-origin discipline, keyed under
        // the `callSiteProps:<name>` convention `parsedPageToSitePage.ts`
        // already uses for `codeProps` — reusing it here (rather than a
        // parallel field) is what lets `isPropWritableToSource` and the
        // server's `callSiteProps:` prefix strip (`applyStudioEdit`'s
        // `'prop'` case) work completely unchanged.
        if (node.moduleId === 'studio.instance') {
          const callSiteProps = (node.props as { callSiteProps?: Record<string, unknown> }).callSiteProps ?? {}
          for (const [name, value] of Object.entries(callSiteProps)) {
            if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
            const codeKey = `callSiteProps:${name}`
            if (baseline && Object.is(baseline[codeKey], value)) continue
            if (!isPropWritableToSource(node, codeKey)) continue
            edits.push({ kind: 'prop', nodeId: node.id, prop: codeKey, value })
          }
        }

        // Inline color/shadow edits write a `style={{}}` attribute onto the
        // source element. Only safe for `base.*` nodes: their source element
        // IS the host tag at this location, so a literal `style` prop lands
        // where the editor expects it. `alm.*` design-system components may
        // not forward a `style` prop to their root element at all — out of
        // scope for source writeback this slice.
        if (node.moduleId.startsWith('base.')) {
          const style = literalInlineStyles(node.inlineStyles)
          const changed = Object.entries(style).filter(
            ([k, v]) =>
              isStyleWritableToSource(node, k) &&
              (!baseline || !Object.is(baseline[styleValueKey(k)], v)),
          )
          if (changed.length > 0) {
            edits.push({ kind: 'style', nodeId: node.id, style: Object.fromEntries(changed) })
          }
        }
      }
    }

    // `panel-02` (WS-6.3) — CSS write-back. Diffs each rule's BASE `styles`
    // bag against the load-time baseline (`loadedStyleRuleValues` — a
    // breakpoint/condition override in `contextStyles` is NOT diffed here,
    // an explicit, documented gap) and emits a `kind: 'css'` edit for any
    // rule this project's load mapped to a real `.css` file + selector
    // (`styleRuleSources`). A rule with no mapping — Tailwind/Sass/PostCSS
    // output, a CSS Modules compile, an ambient rule with no source — is
    // left alone here: `StyleTargetChip` already told the user, at the
    // point they started editing, that this class's changes stay
    // preview-only, so silently not attempting a write is the honest
    // outcome, not a swallowed error. A property REMOVED since load (present
    // in the baseline, absent from `rule.styles` now) is also left alone —
    // `setDeclaration` only sets a value, it has no "remove" operation yet.
    for (const [ruleId, rule] of Object.entries(site.styleRules)) {
      const source = styleRuleSources[ruleId]
      if (!source) continue
      const baseline = loadedStyleRuleValues.get(ruleId) ?? {}
      for (const [property, value] of Object.entries(rule.styles)) {
        if (typeof value !== 'string' && typeof value !== 'number') continue
        if (Object.is(baseline[property], value)) continue
        // `rule.styles` keys are camelCase (`CSSPropertyBag`'s convention
        // everywhere in this editor) — the codemod writes into a real .css
        // file, which only understands kebab-case property names.
        const kebabProperty = camelToKebabCssProperty(property)
        edits.push({
          kind: 'css',
          nodeId: `css:${source.file}#${source.selector}#${kebabProperty}`,
          file: source.file,
          selector: source.selector,
          property: kebabProperty,
          value: String(value),
        })
      }
    }

    if (edits.length > 0) {
      const result = await apiRequest('/admin/api/studio/save', {
        method: 'POST',
        body: { dir: loadedDir, edits },
        schema: StudioSaveResponseSchema,
      })

      // WS-4.4/4.5/6.3 — a `detach`/`swap`/`css` refusal is a NAMED, expected
      // outcome (Card uses a hook, the new name would shadow a binding, this
      // stylesheet is a compiled build artefact, …), so it gets its own toast
      // carrying the actual reason rather than folding into the generic "no
      // writable location" message below, which would be actively misleading
      // here (the location WAS writable — the codemod declined on purpose).
      const REFUSAL_TITLES: Record<string, string> = {
        detach: 'Detach refused',
        swap: 'Swap refused',
        css: 'Style not saved to source',
      }
      const refusals = result.refusals ?? []
      for (const refusal of refusals) {
        pushToast({ kind: 'error', title: REFUSAL_TITLES[refusal.kind] ?? 'Edit refused', body: refusal.message })
      }

      // Some edits resolved to no writable source location, so nothing reached
      // disk for them. The commonest cause is text that is not a literal in the
      // target element at all: `<p className="title">{title}</p>` renders a prop
      // the CALL SITE passes, and `setJsxText` refuses rather than baking the
      // binding away into a string. Say so — the alternative is the user
      // watching their edit snap back with no explanation. Excludes skips
      // already explained by a refusal toast above.
      const unexplainedSkips = result.skipped - refusals.length
      if (unexplainedSkips > 0) {
        pushToast({
          kind: 'error',
          title: 'Some changes were not saved to source',
          body:
            `${unexplainedSkips} edit${unexplainedSkips === 1 ? '' : 's'} had no writable location in the code. ` +
            'Text that comes from a prop or a variable cannot be edited on the canvas yet — ' +
            'edit it where the value is defined.',
        })
      }

      // A write shifted line numbers, so every `line:col` node id below that
      // point is now stale against disk. Re-parse the workspace to re-derive
      // fresh ids (`requestCmsSiteReload` → usePersistence reload → loadSite),
      // otherwise the NEXT edit on a shifted node would target the wrong source
      // location and silently fail. The reload also clears the unsaved flag, so
      // it can't loop into another save (there is no file watcher — a studio
      // write never re-enters as an external change). Rare in practice: source
      // formatting stabilizes after the first normalizing write, so `shifted`
      // is false on subsequent idempotent saves.
      // A shared-component edit rewrote the component's own file, so every
      // OTHER instance of it on the board is showing a stale value. Reload for
      // the same reason as `shifted`: the document no longer matches disk.
      //
      // Gated on `written > 0`. When nothing reached disk the document still
      // matches the files, so there is nothing to re-sync — and reloading would
      // replace the user's in-memory edit with the unchanged source, making the
      // edit visibly revert two seconds after they typed it. That was the whole
      // bug: an unwritable text edit reverted itself on a timer.
      if (result.written > 0 && (result.shifted || result.sharedComponents)) {
        requestCmsSiteReload()
      }
    }

    // Framework settings (Colors/Typography/Spacing) live outside the
    // per-node edit batch above — sync them independently so a framework-only
    // change (no node prop/text/style edits at all) still persists.
    const nextFrameworkJson = JSON.stringify(site.settings.framework)
    if (nextFrameworkJson !== lastSyncedFrameworkJson) {
      await apiRequest('/admin/api/studio/framework', {
        method: 'POST',
        body: { dir: loadedDir, framework: site.settings.framework },
        schema: StudioFrameworkSaveResponseSchema,
      })
      lastSyncedFrameworkJson = nextFrameworkJson
    }
  },
}
