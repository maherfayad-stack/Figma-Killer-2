/**
 * fsCodemodAdapter — an IPersistenceAdapter that makes the editor load from,
 * and save back to, a real React page on disk (via the /admin/api/studio
 * server endpoints), instead of the SQLite CMS draft.
 *
 *   loadSite  → GET  /admin/api/studio/load   → a source-derived Instatic Page,
 *               wrapped in a default SiteDocument shell.
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
import type { Page, SiteDocument } from '@core/page-tree'
import { createDefaultSiteDocument } from '@site/store/slices/site/defaults'

/** Node ids from page-parser are `relFile:line:col` — a decodable source location. */
const SOURCE_NODE_ID = /^.+:\d+:\d+$/

interface StudioLoadResponse {
  dir: string
  page: Page
}

/** Remembered from the last load so saveSite can tell the server which folder to write. */
let loadedDir: string | null = null

async function fetchServerPage(): Promise<StudioLoadResponse> {
  const res = await fetch('/admin/api/studio/load', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`studio load failed: HTTP ${res.status}`)
  return (await res.json()) as StudioLoadResponse
}

export const fsCodemodAdapter: IPersistenceAdapter = {
  async loadSite(): Promise<SiteDocument | undefined> {
    const { dir, page } = await fetchServerPage()
    loadedDir = dir
    // Wrap the source-derived page in a valid default site shell (breakpoints,
    // settings, framework, …) and make it the single homepage.
    const site = createDefaultSiteDocument('Studio')
    site.pages = [page]
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

    const res = await fetch('/admin/api/studio/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ dir: loadedDir, edits }),
    })
    if (!res.ok) throw new Error(`studio save failed: HTTP ${res.status}`)
  },
}
