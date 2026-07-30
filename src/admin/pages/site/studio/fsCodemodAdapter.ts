/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → every source-derived Instatic
 *               Page in the workspace's `pages/` dir, wrapped in a default
 *               SiteDocument shell (multi-frame board — Phase 1 Increment 1B).
 *               `site.settings.framework` (Colors/Typography/Spacing) is then
 *               overridden from `GET /admin/api/studio/framework`, if the
 *               project has a persisted `.studio/framework.json` — otherwise
 *               the default shell's framework settings stand as-is.
 *   saveSite  → POST /admin/api/studio/save   → a batch of typed edits
 *               (`kind: 'prop' | 'text' | 'style'`) for every source-backed
 *               node (id = `relFile:line:col`), written back to the .tsx via
 *               the server-side ts-morph codemods (`setJsxProp` / `setJsxText`
 *               / `setJsxStyle`). Independently, if `site.settings.framework`
 *               changed since the last load/save, it's POSTed to
 *               `/admin/api/studio/framework` — a framework-only edit (no
 *               node prop/text/style changes) still needs to persist, so this
 *               does NOT gate on there being any node edits in the batch.
 *
 * Wired in only when the editor is opened with `?studio` (see AdminCanvasLayout);
 * the normal DB-backed editor is untouched. This is the filesystem-as-truth
 * path — Instatic's autosave (debounce / Cmd+S) is the commit-on-idle trigger.
 *
 * Paths live under /admin/api so the Vite dev proxy forwards them to the :3001
 * server (same-origin in prod behind Caddy).
 */
import type { IPersistenceAdapter, SaveSiteOptions } from '@core/persistence/types'
import {
  type Page,
  type SiteDocument,
  ConditionDefSchema,
  PageSchema,
  StyleRuleSchema,
  hasWritableSourceLocation,
  isPropWritableToSource,
  isStyleWritableToSource,
  styleValueKey,
} from '@core/page-tree'
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { registry } from '@core/module-engine'
import { CUSTOM_HTML_TAG_VALUE } from '@modules/base/utils/htmlTag'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import { pushToast } from '@ui/components/Toast'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'


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

/** GET /admin/api/studio/load — every source-derived page in the workspace. */
const StudioLoadResponseSchema = Type.Object({
  dir: Type.String(),
  /** The project's DISPLAY name (`.studio/meta.json`, falls back to the folder name). */
  projectName: Type.String(),
  pages: Type.Array(PageSchema),
  /** Keyed by node id (`relFile:line:col`) — only `kind: 'component'` nodes appear. */
  componentSources: Type.Record(Type.String(), ComponentSourceSchema),
  /**
   * §6 — the page's imported `.css` files, parsed into style rules and keyed
   * by a deterministic id (see `server/handlers/studioCss.ts`). READ-ONLY:
   * there is no CSS writeback codemod, so an edit made here is lost on the
   * next reload.
   */
  styleRules: Type.Record(Type.String(), StyleRuleSchema),
  /** §6 — reusable `@media`/`@container`/`@supports` conditions referenced by those rules' `contextStyles`. */
  conditions: Type.Array(ConditionDefSchema),
})

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
    const { dir, projectName, pages, componentSources: sources, styleRules, conditions } = await apiRequest('/admin/api/studio/load', {
      schema: StudioLoadResponseSchema,
      query: overrideDir ? { dir: overrideDir } : undefined,
    })
    loadedDir = dir
    componentSources = sources
    // Baseline for the save-time diff — see `loadedValues`.
    loadedValues = snapshotNodeValues(pages)
    // Distinct from `site.name` (the "Studio" product wordmark, unchanged per
    // project) — this is the per-project display name shown under the brand
    // in the toolbar (see Toolbar.tsx's StudioProjectLabel).
    useAdminUi.getState().setStudioProject({ dir, name: projectName })
    // Wrap the source-derived pages in a valid default site shell (breakpoints,
    // settings, framework, …) — every workspace page becomes a board frame.
    const site = createDefaultSiteDocument('Studio')
    site.pages = pages
    // §6 — styling imported from the workspace's `.css` files. One-way: these
    // rules are re-derived from disk on every load, so an edit made in the CSS
    // Classes panel is lost on the next reload (see studioCss.ts's §6.6 note).
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

    if (edits.length > 0) {
      const result = await apiRequest('/admin/api/studio/save', {
        method: 'POST',
        body: { dir: loadedDir, edits },
        schema: StudioSaveResponseSchema,
      })

      // Some edits resolved to no writable source location, so nothing reached
      // disk for them. The commonest cause is text that is not a literal in the
      // target element at all: `<p className="title">{title}</p>` renders a prop
      // the CALL SITE passes, and `setJsxText` refuses rather than baking the
      // binding away into a string. Say so — the alternative is the user
      // watching their edit snap back with no explanation.
      if (result.skipped > 0) {
        pushToast({
          kind: 'error',
          title: 'Some changes were not saved to source',
          body:
            `${result.skipped} edit${result.skipped === 1 ? '' : 's'} had no writable location in the code. ` +
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
