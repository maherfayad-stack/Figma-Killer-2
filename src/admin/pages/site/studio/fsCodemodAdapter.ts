/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → every source-derived Instatic
 *               Page in the workspace's `pages/` dir, wrapped in a default
 *               SiteDocument shell (multi-frame board — Phase 1 Increment 1B).
 *   saveSite  → POST /admin/api/studio/save   → prop edits for every
 *               source-backed node (id = `relFile:line:col`) written back to
 *               the .tsx via the server-side ts-morph codemod.
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

/** Node ids from page-parser are `relFile:line:col` — a decodable source location. */
const SOURCE_NODE_ID = /^.+:\d+:\d+$/

/** GET /admin/api/studio/load — every source-derived page in the workspace. */
const StudioLoadResponseSchema = Type.Object({
  dir: Type.String(),
  pages: Type.Array(PageSchema),
})

/** POST /admin/api/studio/save — count of props written back to source. */
const StudioSaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  written: Type.Number(),
})

/** Remembered from the last load so saveSite can tell the server which folder to write. */
let loadedDir: string | null = null

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
    // Collect current literal props for every source-backed node across all
    // pages. Re-writing unchanged props is idempotent, so we don't need a
    // per-prop diff for this first pass. Synthetic nodes (e.g. `index:body`)
    // don't match the loc pattern and are skipped server-side anyway.
    const edits: Array<{ nodeId: string; prop: string; value: string | number | boolean }> = []
    for (const page of site.pages) {
      for (const node of Object.values(page.nodes)) {
        if (!SOURCE_NODE_ID.test(node.id)) continue
        for (const [prop, value] of Object.entries(node.props ?? {})) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            edits.push({ nodeId: node.id, prop, value })
          }
        }
      }
    }
    if (edits.length === 0) return

    await apiRequest('/admin/api/studio/save', {
      method: 'POST',
      body: { dir: loadedDir, edits },
      schema: StudioSaveResponseSchema,
    })
  },
}
