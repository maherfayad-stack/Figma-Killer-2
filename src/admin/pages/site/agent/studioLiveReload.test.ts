/**
 * P1-D (ERR-19) — the browser half of "an edit made outside Studio reaches the
 * board": a `studio_live_reload` push carrying `diskChanged` re-reads the named
 * files through the same resync Studio's own writes use, and saves anything
 * the user typed FIRST, so pending edits are posted against the ids they were
 * made on (where the server re-finds them) rather than against a board that
 * was re-read under them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { registerEditorSave } from '../hooks/editorSaveRef'
import { setStudioLoadedDir } from '../studio/studioWorkspaceDir'
import { getAgentStoreApi, setAgentStoreApi } from './storeRef'
import { runStudioLiveReload } from './studioLiveReload'

const PROJECT = '/tmp/studio-disk-change'

let order: string[]
let scopeBodies: unknown[]
let unsaved: boolean
let originalFetch: typeof globalThis.fetch
let previousStore: ReturnType<typeof getAgentStoreApi> | null = null
let unregisterSave: () => void
const onReload = () => order.push('full-reload')

beforeAll(() => {
  try {
    previousStore = getAgentStoreApi()
  } catch (_err) {
    previousStore = null // no store registered in this process — nothing to restore
  }
})

afterAll(() => {
  if (previousStore) setAgentStoreApi(previousStore)
})

beforeEach(() => {
  order = []
  scopeBodies = []
  unsaved = false
  originalFetch = globalThis.fetch
  setStudioLoadedDir(PROJECT)
  setAgentStoreApi({ getState: () => ({ hasUnsavedChanges: unsaved }), setState: () => {} })
  unregisterSave = registerEditorSave(async () => {
    order.push('save')
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.split('?')[0] === '/admin/api/studio/reload-scope') {
      order.push('reload-scope')
      scopeBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
      return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  window.addEventListener(CMS_SITE_RELOAD_EVENT, onReload)
})

afterEach(() => {
  window.removeEventListener(CMS_SITE_RELOAD_EVENT, onReload)
  globalThis.fetch = originalFetch
  unregisterSave()
  setStudioLoadedDir(null)
})

const push = (files: string[], dir = PROJECT) =>
  runStudioLiveReload({ dir, pageIds: [], boardsChanged: false, commentsChanged: false, diskChanged: { files } })

describe('studio_live_reload — files changed outside Studio', () => {
  it('re-reads the changed files through the board resync', async () => {
    const result = await push(['pages/Home.tsx'])
    expect(result.ok).toBe(true)
    expect(order).toEqual(['reload-scope', 'full-reload'])
    expect(scopeBodies).toEqual([{ dir: PROJECT, files: ['pages/Home.tsx'] }])
  })

  it('saves what the user typed BEFORE re-reading', async () => {
    unsaved = true
    await push(['pages/Home.tsx'])
    expect(order).toEqual(['save', 'reload-scope', 'full-reload'])
  })

  it('re-reads everything when the server could not name the files', async () => {
    await push([])
    expect(order).toEqual(['full-reload'])
  })

  it('leaves a board on a different project alone', async () => {
    const result = await push(['pages/Home.tsx'], '/tmp/some-other-project')
    expect(result.ok && (result.data as { applied: boolean }).applied).toBe(false)
    expect(order).toEqual([])
  })
})
