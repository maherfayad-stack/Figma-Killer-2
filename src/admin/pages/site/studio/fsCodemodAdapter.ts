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
  hasWritableSourceLocation,
  isPropWritableToSource,
  isStyleWritableToSource,
  styleValueKey,
} from '@core/page-tree'
import { apiRequest, ndjsonRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { CUSTOM_HTML_TAG_VALUE } from '@modules/base/utils/htmlTag'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import { pushToast } from '@ui/components/Toast'
import { notifyUnexplainedSkips } from '@site/panels/unexplainedSkipsNotice'
import { notifyClassAssignmentUnsaved } from '@site/panels/classAssignmentUnsavedNotice'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'
import { fetchExtractedTokens, type TokenExtractionStatus } from './studioTokenStatus'
import { setStudioTrustTier } from './studioProjectTrust'
import { StudioSaveResponseSchema, notifyCreatedStylesheets, setStudioLoadedDir, studioWriteDir } from './studioSaveRequests'
import { StudioLoadStreamLineSchema, type ComponentSource } from './studioLoadStreamSchema'
import {
  commitClassIdsBaseline,
  commitNodeValuesBaseline,
  getLoadedNodeValues,
  literalInlineStyles,
  resetLoadedValues,
  type NodeValueBump,
} from './loadedValuesBaseline'
import { collectClassNameEdits } from './classNameWriteback'
import {
  collectStyleRuleEdits,
  commitBaseline as commitStyleRuleBaseline,
  setStudioStyleRuleSources,
} from './styleRuleWriteback'
import {
  collectLocalizedTextEdits,
  commitLocalizedTextBaseline,
  resetLocalizedTextBaseline,
  watchLocalizedPagesForBaseline,
} from './localizedPageWriteback'

export type { ComponentSource } from './studioLoadStreamSchema'

/** GET /admin/api/studio/framework response — `null` when nothing is persisted yet. */
const StudioFrameworkLoadResponseSchema = Type.Object({
  framework: Type.Union([FrameworkSettingsSchema, Type.Null()]),
})

/** POST /admin/api/studio/framework response. */
const StudioFrameworkSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  framework: FrameworkSettingsSchema,
})

/**
 * Remembered from the last load so saveSite can tell the server which folder
 * to write. Held by `studioSaveRequests`, which every one-shot commit shares.
 */
function loadedDir(): string | null {
  return studioWriteDir()
}

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
 * Every source-backed node's values AS LOADED, keyed by node id, so `saveSite`
 * can write only what the user actually changed. Owned by `loadedValuesBaseline.ts`
 * (a store-agnostic leaf — see that module's own doc for why); this file only
 * ever reads it (`getLoadedNodeValues`) or replaces it wholesale on a fresh
 * `loadSite()` (`resetLoadedValues`).
 */

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
  const dir = loadedDir()
  if (dir === null) throw new Error('[fsCodemodAdapter] refreshExtractedTokens called before a project loaded')
  const { framework, status } = await fetchExtractedTokens(dir)
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
 *
 * Track B1 — the `css` variant is now three ops (`studioCssWriteback.ts`'s
 * `CssEditSchema`): `set`, `insert` (one editable stylesheet exists),
 * `create` (none do, but the server can invent a co-located one). Widened
 * here only because `collectStyleRuleEdits`'s return type includes all
 * three. `create`'s "which file was created" surfacing is wired: `saveSite`
 * calls `notifyCreatedStylesheets` (`studioSaveRequests.ts`) once the save
 * response arrives, alongside the `unexplainedSkips` handling.
 *
 * Track B2 — `class` (`server/handlers/studioEditSchemas.ts`'s
 * `ClassEditSchema`, matching `classNameWriteback.ts`'s `ClassNameEditPayload`)
 * replaces Phase 0 item 0.6's honesty-only stopgap: a `node.classIds` add/
 * remove now reaches disk via `setJsxClassName` instead of only ever warning
 * that it couldn't.
 */
type StudioEditPayload =
  | { kind: 'prop'; nodeId: string; prop: string; value: string | number | boolean }
  | { kind: 'text'; nodeId: string; text: string }
  | { kind: 'style'; nodeId: string; style: Record<string, string | number> }
  | { kind: 'class'; nodeId: string; add: string[]; remove: string[] }
  | { kind: 'literal'; nodeId: string; text: string }
  | { kind: 'tag'; nodeId: string; tag: string }
  | { kind: 'asset'; nodeId: string; assetPath: string }
  | { kind: 'css'; op: 'set'; nodeId: string; file: string; selector: string; property: string; value: string }
  | { kind: 'css'; op: 'insert'; nodeId: string; file: string; selector: string; declarations: Record<string, string>; atMedia?: string }
  | { kind: 'css'; op: 'create'; nodeId: string; pageFile: string; selector: string; declarations: Record<string, string>; atMedia?: string }

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
    setStudioLoadedDir(dir)
    componentSources = sources
    paletteHiddenModuleIds = loadedPaletteHiddenModuleIds
    setStudioVendorCss(loadedVendorCss)
    setStudioTrustTier(trust)
    // Baseline for the save-time diff — see `loadedValuesBaseline.ts`.
    resetLoadedValues(pages)
    // `panel-02` (WS-6.3) — the CSS write-back map + its diff baseline.
    setStudioStyleRuleSources(loadedStyleRuleSources, styleRules)
    // WS-10 §4.4 (Phase 4) — a fresh project load (or a `requestCmsSiteReload()`
    // re-load) must not carry a locale-variant page, or its writeback
    // baseline, over from whatever project was open before: `pageId` is only
    // unique WITHIN one project, so a stale entry could silently suppress or
    // misdirect a real diff in the new one. `watchLocalizedPagesForBaseline`
    // is idempotent — safe to call on every load, only subscribes once.
    useEditorStore.getState().resetLocalizedPages()
    resetLocalizedTextBaseline()
    watchLocalizedPagesForBaseline()
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

  async saveSite(site: SiteDocument, opts: SaveSiteOptions = {}): Promise<void> {
    // Collect current literal props + inline styles for every source-backed
    // node across all pages. Re-writing unchanged values is idempotent, so we
    // don't need a per-field diff for this first pass. Synthetic nodes (e.g.
    // `index:body`) don't match the loc pattern and are skipped server-side.
    const edits: StudioEditPayload[] = []
    // Parallel to `edits` — one `(nodeId, baseline key, value)` entry per
    // node-value edit pushed below, so `loadedValues` can be advanced to
    // exactly what this batch wrote once the POST confirms it landed. See
    // `commitNodeValuesBaseline`'s doc for why this is E1's fix and why it is
    // gated on `unexplainedSkips === 0` below rather than committed
    // unconditionally.
    const bumps: NodeValueBump[] = []

    // C4 — this loop used to scan every node of every page on every autosave
    // tick, ignoring `opts.dirty` (fed correctly by every `mutateSite`/
    // `mutateActiveTree` call, see `dirtyTracking.ts`). A page NOT in
    // `dirty.pageIds` produced zero site patches since the last snapshot, so
    // it holds no unshipped edit — skipping its scan is lossless. Absent
    // hints or `dirty.all` fall back to the full scan (`SaveSiteOptions`'s own
    // "Absent -> replace-mode full save" contract). Scope: only THIS loop is
    // filtered — `collectClassIdsDrift`/`commitClassIdsBaseline`/
    // `collectStyleRuleEdits` below stay unfiltered (cheaper per-node checks,
    // lower risk to touch alongside the 0.6 seam than the payoff is worth).
    const dirty = opts.dirty
    const dirtyPages =
      !dirty || dirty.all ? site.pages : site.pages.filter((page) => dirty.pageIds.has(page.id))

    for (const page of dirtyPages) {
      for (const node of Object.values(page.nodes)) {
        // The module's declared inline-text-edit prop (if any) routes that
        // one prop as a `text` edit (rewrites the element's text children)
        // instead of a `prop` edit (rewrites an attribute) — capturing it as
        // an attribute would corrupt the source (e.g. `label="Click me"` on a
        // <Button> whose label is really its text child).
        const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop
        const baseline = getLoadedNodeValues(node.id)

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
            bumps.push({ nodeId: node.id, key: textProp, value })
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
            // `effectiveTag(baseline)` reads BOTH raw keys — bump both so a
            // later save's `baselineTag` recomputes from what's now on disk,
            // not from the as-loaded pair.
            const rawTag = node.props?.tag
            if (typeof rawTag === 'string') bumps.push({ nodeId: node.id, key: 'tag', value: rawTag })
            const rawCustomTag = node.props?.customTag
            if (typeof rawCustomTag === 'string') bumps.push({ nodeId: node.id, key: 'customTag', value: rawCustomTag })
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
          bumps.push({ nodeId: node.id, key: prop, value })
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
            bumps.push({ nodeId: node.id, key: codeKey, value })
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
            for (const [k, v] of changed) bumps.push({ nodeId: node.id, key: styleValueKey(k), value: v })
          }
        }
      }
    }

    // Track B2 — Studio (filesystem) mode now has a real `class` edit kind
    // (`setJsxClassName`): `collectClassNameEdits` diffs `node.classIds`
    // against the load-time baseline right here — the same place
    // `collectStyleRuleEdits` (just below) diffs `site.styleRules` — and
    // turns most of the drift into `kind: 'class'` edits sent in the same
    // batch as everything else. The residual `unwritable` subset (a `.map`
    // row, a synthetic root — no single JSX location a class token could
    // land on) still gets Phase 0.6's honesty toast, now scoped to exactly
    // that subset instead of every class change in the project. Fires
    // exactly when the write is attempted, catches every entry point
    // (including a future AI-agent-driven class edit), and never re-fires
    // for a node whose classes are unchanged since the last save.
    const classPlan = collectClassNameEdits(site.pages, site.styleRules, site.visualComponents)
    edits.push(...classPlan.edits)
    if (classPlan.unwritable.length > 0) notifyClassAssignmentUnsaved(classPlan.unwritable)
    // Advance unconditionally, same discipline `commitStyleRuleBaseline`
    // below uses: one user change produces exactly one write attempt and
    // (if refused) exactly one refusal toast, not a re-send/re-toast on
    // every later autosave tick. A `class` edit's per-token REFUSAL (a CSS
    // Modules binding, a dynamic template, …) is reported once via
    // `result.refusals` below, same channel `detach`/`swap`/`css` use.
    commitClassIdsBaseline(site.pages)

    // `panel-02` (WS-6.3) — CSS write-back, owned by `styleRuleWriteback.ts`:
    // it diffs each rule's BASE `styles` bag against the load-time baseline
    // and reports both the edits to send and the classes the user changed
    // that have NO hand-editable `.css` source. See that module's doc for why
    // the second list exists — an unmapped rule used to be skipped silently,
    // which meant a Tailwind project's style edits vanished on reload with
    // nothing ever said about it.
    const cssPlan = collectStyleRuleEdits(site.styleRules)
    edits.push(...cssPlan.edits)

    if (cssPlan.unmapped.length > 0) {
      const names = cssPlan.unmapped.join(', ')
      pushToast({
        kind: 'error',
        title: 'Style not saved to source',
        body:
          `${names} ${cssPlan.unmapped.length === 1 ? 'has' : 'have'} no hand-editable CSS file in this project ` +
          '(a generated utility class, a CSS Modules compile, or a build artefact), so this change stays on the ' +
          'canvas only and will be lost on reload. Style the element instead to write it to source.',
      })
    }

    if (cssPlan.unwritableContexts.length > 0) {
      pushToast({
        kind: 'error',
        title: 'Breakpoint override not saved to source',
        body:
          `${cssPlan.unwritableContexts.join(', ')} changed under a breakpoint or condition. Studio can only write ` +
          'a class’s default declarations back to CSS today, so this override stays on the canvas only and ' +
          'will be lost on reload.',
      })
    }

    // WS-10 §4.4 (Phase 4) — a locale-variant board frame's text edits.
    // `localizedPages` lives OUTSIDE `site` (a parallel map, not part of
    // `SiteDocument` — see `localizedPageSlice.ts`'s module doc), so it is
    // read directly from the store here rather than arriving via `site`
    // the way every edit above does. Owns its own `(pageId, locale,
    // nodeId)`-keyed baseline — see `localizedPageWriteback.ts` for why it
    // cannot share `loadedValues` with the default tree above.
    const localizedEdits = collectLocalizedTextEdits(useEditorStore.getState().localizedPages)
    edits.push(...localizedEdits)

    if (edits.length > 0) {
      const result = await apiRequest('/admin/api/studio/save', {
        method: 'POST',
        body: { dir: loadedDir(), edits },
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
        class: 'Class change not saved to source',
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
      //
      // Phase 0 item 0.7 — `result.unexplainedSkips` (added alongside
      // `refusals`/`shifted`/etc. on `StudioSaveResponseSchema`) carries the
      // actual `{ nodeId, kind }[]` behind this count, so the toast can name
      // the affected node(s) instead of a bare number — see
      // `unexplainedSkipsNotice.ts`. `?? []` covers an older/dev server that
      // hasn't picked up the field yet; `notifyUnexplainedSkips([])` is a
      // documented no-op, matching the old `unexplainedSkips > 0` guard.
      const unexplainedSkips = result.skipped - refusals.length
      notifyUnexplainedSkips(result.unexplainedSkips ?? [])

      // Track B1 create branch — name the file Studio invented and register it
      // in the write-back map, so the same rule is writable through the ordinary
      // `set` path on its next edit with no reload. Creating a file is a bigger
      // surprise than choosing one, so it is never silent.
      notifyCreatedStylesheets(result, site.styleRules)

      // E1 fix (`STUDIO-FIGMA-PARITY-PLAN.md` 0.1) — advance the node-value
      // baseline to what this batch wrote, so the NEXT autosave tick diffs
      // against disk-as-it-now-is rather than the as-loaded snapshot. Gated
      // on `unexplainedSkips === 0`: the response only reports aggregate
      // counts for the whole POST (props + text + style + tag + CSS +
      // localized text all share one `written`/`skipped`), so there is no
      // per-edit signal to tell which SPECIFIC bump landed when only some of
      // the batch did. Skipping the whole commit in that rare case is the
      // safe direction — a bump that should have landed just gets re-diffed
      // (harmless, `setJsxProp`/`setJsxText` are idempotent) on the next
      // tick, instead of a refused/skipped edit's value being silently
      // adopted as the new baseline and the user never seeing why their
      // change didn't stick.
      if (unexplainedSkips === 0) commitNodeValuesBaseline(bumps)

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

    // WS-10 §4.4 (Phase 4) — advance the locale-variant text baseline to
    // what was just sent, for the same reason the CSS baseline below does:
    // without it, every later autosave tick re-sends an already-applied
    // literal edit (harmless — `setJsxText` is idempotent — but wasteful,
    // and it would keep the "pending" edit alive across reloads it
    // shouldn't be). See `localizedPageWriteback.ts`'s "Baseline discipline".
    if (localizedEdits.length > 0) {
      commitLocalizedTextBaseline(useEditorStore.getState().localizedPages)
    }

    // `panel-02` — advance the CSS diff baseline to what was just sent, so one
    // user change produces exactly one write attempt and exactly one refusal
    // message. Without this every later autosave tick would re-send an
    // already-applied declaration and re-toast an already-reported refusal on
    // a two-second timer. See `styleRuleWriteback`'s "Baseline discipline".
    if (cssPlan.edits.length > 0 || cssPlan.unmapped.length > 0 || cssPlan.unwritableContexts.length > 0) {
      commitStyleRuleBaseline(site.styleRules)
    }

    // Framework settings (Colors/Typography/Spacing) live outside the
    // per-node edit batch above — sync them independently so a framework-only
    // change (no node prop/text/style edits at all) still persists.
    const nextFrameworkJson = JSON.stringify(site.settings.framework)
    if (nextFrameworkJson !== lastSyncedFrameworkJson) {
      await apiRequest('/admin/api/studio/framework', {
        method: 'POST',
        body: { dir: loadedDir(), framework: site.settings.framework },
        schema: StudioFrameworkSaveResponseSchema,
      })
      lastSyncedFrameworkJson = nextFrameworkJson
    }
  },
}
