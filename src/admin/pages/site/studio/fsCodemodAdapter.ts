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
import { type SiteDocument, PageSchema } from '@core/page-tree'
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { registry } from '@core/module-engine'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import { getStudioWorkspaceDir } from './studioWorkspaceDir'

/** Node ids from page-parser are `relFile:line:col` — a decodable source location. */
const SOURCE_NODE_ID = /^.+:\d+:\d+$/

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
    const { dir, projectName, pages, componentSources: sources } = await apiRequest('/admin/api/studio/load', {
      schema: StudioLoadResponseSchema,
      query: overrideDir ? { dir: overrideDir } : undefined,
    })
    loadedDir = dir
    componentSources = sources
    // Distinct from `site.name` (the "Studio" product wordmark, unchanged per
    // project) — this is the per-project display name shown under the brand
    // in the toolbar (see Toolbar.tsx's StudioProjectLabel).
    useAdminUi.getState().setStudioProject({ dir, name: projectName })
    // Wrap the source-derived pages in a valid default site shell (breakpoints,
    // settings, framework, …) — every workspace page becomes a board frame.
    const site = createDefaultSiteDocument('Studio')
    site.pages = pages

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
        if (!SOURCE_NODE_ID.test(node.id)) continue

        // The module's declared inline-text-edit prop (if any) routes that
        // one prop as a `text` edit (rewrites the element's text children)
        // instead of a `prop` edit (rewrites an attribute) — capturing it as
        // an attribute would corrupt the source (e.g. `label="Click me"` on a
        // <Button> whose label is really its text child).
        const textProp = registry.get(node.moduleId)?.inlineTextEdit?.prop

        for (const [prop, value] of Object.entries(node.props ?? {})) {
          if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
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
          if (Object.keys(style).length > 0) {
            edits.push({ kind: 'style', nodeId: node.id, style })
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

      // A write shifted line numbers, so every `line:col` node id below that
      // point is now stale against disk. Re-parse the workspace to re-derive
      // fresh ids (`requestCmsSiteReload` → usePersistence reload → loadSite),
      // otherwise the NEXT edit on a shifted node would target the wrong source
      // location and silently fail. The reload also clears the unsaved flag, so
      // it can't loop into another save (there is no file watcher — a studio
      // write never re-enters as an external change). Rare in practice: source
      // formatting stabilizes after the first normalizing write, so `shifted`
      // is false on subsequent idempotent saves.
      if (result.shifted) requestCmsSiteReload()
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
