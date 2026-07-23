/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → every source-derived Instatic
 *               Page in the workspace's `pages/` dir, wrapped in a default
 *               SiteDocument shell (multi-frame board — Phase 1 Increment 1B).
 *   saveSite  → POST /admin/api/studio/save   → a batch of typed edits
 *               (`kind: 'prop' | 'text' | 'style'`) for every source-backed
 *               node (id = `relFile:line:col`), written back to the .tsx via
 *               the server-side ts-morph codemods (`setJsxProp` / `setJsxText`
 *               / `setJsxStyle`).
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
import { Type } from '@core/utils/typeboxHelpers'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'
import { registry } from '@core/module-engine'
import { requestCmsSiteReload } from '@admin/state/adminEvents'

/** Node ids from page-parser are `relFile:line:col` — a decodable source location. */
const SOURCE_NODE_ID = /^.+:\d+:\d+$/

/** GET /admin/api/studio/load — every source-derived page in the workspace. */
const StudioLoadResponseSchema = Type.Object({
  dir: Type.String(),
  pages: Type.Array(PageSchema),
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

/** Remembered from the last load so saveSite can tell the server which folder to write. */
let loadedDir: string | null = null

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
    const { dir, pages } = await apiRequest('/admin/api/studio/load', {
      schema: StudioLoadResponseSchema,
    })
    loadedDir = dir
    // Wrap the source-derived pages in a valid default site shell (breakpoints,
    // settings, framework, …) — every workspace page becomes a board frame.
    const site = createDefaultSiteDocument('Studio')
    site.pages = pages
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

    if (edits.length === 0) return

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
  },
}
