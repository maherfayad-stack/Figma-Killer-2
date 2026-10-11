/**
 * realSourceHarness — the real-source half of the structural-undo tests.
 *
 * `/save` is `applyStudioEditBatchLocked` against a temp workspace with exactly
 * the editor route's options (`journal: true`, canvas layers allowed), `/load`
 * and `/reload-scope` are `loadStudioPages` against the same files, and the
 * store is loaded from that parse. A hand-scripted network hands the store the
 * ids the test author believed a write would produce; here the write produces
 * them, which is the only way to catch an undo that recorded an id before its
 * own write shifted it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '@modules/base'
import { canvasLayerIdFromRel, canvasLayerPageId } from '@core/studio-board'
import { useEditorStore } from '@site/store/store'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { applySitePagesPatch } from '@site/hooks/siteReloadApply'
import { CMS_SITE_PAGES_PATCH_EVENT, type CmsSitePagesPatchDetail } from '@admin/state/adminEvents'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { noteBoardRead, resetSourceIdentities } from '@site/studio/sourceIdentity'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { makeSite } from '../fixtures'
import { applyStudioEditBatchLocked } from '../../../server/handlers/studioWriteback'
import { applyStudioEditSequenceLocked } from '../../../server/handlers/studioEditSequence'
import { loadStudioPages } from '../../../server/handlers/studioPageLoad'
import { studioLoadStreamLines } from '../../../server/handlers/studio/studioLoadResponse'

export interface RealSourceProject {
  dir: string
  /** Every `/save` batch the editor posted, in order. */
  saves: { edits: { kind: string; [field: string]: unknown }[] }[]
  read: (rel: string) => string
  exists: (rel: string) => boolean
  /** Poll until `predicate` holds. */
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>
  /** Restore fetch, listeners and the temp folder. */
  close: () => void
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Write `files` (workspace-relative path to text) to a fresh project, open it in the editor store, and return the handle. */
export async function openRealSourceProject(files: Record<string, string>): Promise<RealSourceProject> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-real-undo-'))
  const full = (rel: string) => path.join(dir, ...rel.split('/'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(full(rel)), { recursive: true })
    fs.writeFileSync(full(rel), text, 'utf8')
  }

  __resetToastBusForTests()
  resetStructuralCommitQueue()
  resetSourceIdentities()
  const originalFetch = globalThis.fetch
  const saves: RealSourceProject['saves'] = []
  const unregisterSave = registerEditorSave(async () => {})
  setStudioLoadedDir(dir)

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = url.split('?')[0]
    if (route === '/admin/api/studio/save') {
      const body = JSON.parse(String(init?.body)) as {
        edits: Parameters<typeof applyStudioEditBatchLocked>[1]
        expect?: Parameters<typeof applyStudioEditBatchLocked>[2]
        sequence?: boolean
      }
      // The route's own choice: a `sequence` body is the ordered, step-by-step writer.
      const result = await (body.sequence ? applyStudioEditSequenceLocked : applyStudioEditBatchLocked)(dir, body.edits, body.expect ?? {}, { canvasLayers: 'allow', journal: true })
      saves.push({ edits: [...body.edits] })
      return new Response(
        JSON.stringify({
          ok: true,
          ...result,
          touchedFiles: result.touchedFiles.map((file) => path.relative(dir, file).split(path.sep).join('/')),
        }),
        { status: 200 },
      )
    }
    if (route === '/admin/api/studio/reload-scope') {
      // The real scope names a free-canvas layer by its `canvas:<id>` page id —
      // also one the write just REMOVED — which is what makes the narrow
      // re-read refresh the layers too.
      const { pages, canvasLayers } = await loadStudioPages(dir)
      const touched = (JSON.parse(String(init?.body)) as { files?: string[] }).files ?? []
      const touchedLayerPageIds = touched.flatMap((rel) => {
        const layerId = canvasLayerIdFromRel(rel)
        return layerId ? [canvasLayerPageId(layerId)] : []
      })
      const pageIds = [...new Set([...pages.map((p) => p.id), ...canvasLayers.map((layer) => layer.pageId), ...touchedLayerPageIds])]
      return new Response(JSON.stringify({ ok: true, narrow: true, pageIds }), { status: 200 })
    }
    if (route === '/admin/api/studio/load') {
      const result = await loadStudioPages(dir)
      const lines: string[] = []
      for await (const line of studioLoadStreamLines({
        ...result,
        dir,
        projectName: 'shop',
        trust: 'static',
        projectKey: null,
        paletteHiddenModuleIds: [],
        missingPageIds: undefined,
      })) {
        lines.push(JSON.stringify(line))
      }
      return new Response(lines.join('\n') + '\n', { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch

  const patchListener = (evt: Event) => applySitePagesPatch((evt as CustomEvent<CmsSitePagesPatchDetail>).detail)
  window.addEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)

  const loaded = await loadStudioPages(dir)
  const store = useEditorStore.getState()
  store.loadSite(makeSite({ pages: loaded.pages, styleRules: loaded.styleRules }))
  store.loadBoards({ version: 1, boards: [{ id: 'b1', name: 'Board 1', frames: [], notes: [], docs: [] }] })
  store.setCanvasLayers(loaded.canvasLayers)
  noteBoardRead(loaded.pages, 'reset')

  return {
    dir,
    saves,
    read: (rel) => fs.readFileSync(full(rel), 'utf8'),
    exists: (rel) => fs.existsSync(full(rel)),
    waitFor,
    close: () => {
      globalThis.fetch = originalFetch
      unregisterSave()
      window.removeEventListener(CMS_SITE_PAGES_PATCH_EVENT, patchListener)
      setStudioLoadedDir(null)
      resetStructuralCommitQueue()
      useEditorStore.getState().setCanvasLayers([])
      useEditorStore.getState().clearSite()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
