/**
 * usePersistence — write→watch→write loop safety (Phase 5B).
 *
 * The concern: could a completed source/draft write re-enter as an external
 * "file changed" reload that RE-DIRTIES the store, which would then schedule
 * another autosave, which would write again, forever?
 *
 * Tracing the loop:
 *   - `saveSite` (both `CmsAdapter` and `fsCodemodAdapter`) never calls
 *     `loadSite` itself and never dispatches `CMS_SITE_RELOAD_EVENT` — a
 *     completed save cannot re-enter as a reload (see `fsCodemodAdapter`'s
 *     own write-loop-safety test for the studio side).
 *   - The only reload path while an editor is mounted is the explicit
 *     `CMS_SITE_RELOAD_EVENT` — dispatched only by `requestCmsSiteReload()`
 *     call sites, all of which are user-triggered (manual save-and-reload,
 *     plugin install), never fired by `usePersistence` itself.
 *   - This test pins the other half of the invariant: when that reload DOES
 *     fire, the handler clears `hasUnsavedChanges` (not sets it), so the
 *     freshly-reloaded document is never immediately re-queued for another
 *     autosave — even if the store was dirty right before the reload landed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import { CMS_SITE_RELOAD_EVENT } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import type { IPersistenceAdapter } from '@core/persistence/types'
import type { SiteDocument } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'

afterEach(cleanup)

/**
 * `useEditorStore` is a process-wide singleton shared across every test file
 * in this `bun test` run — a prior file's fixture site (or dirty flag) is
 * still sitting in the store when this file's tests start. Reset the fields
 * `usePersistence`'s mount effect reads so this test exercises ITS OWN fresh
 * adapter's `loadSite`, not a leftover site from another file (matches the
 * `resetStore`/`seedStore` pattern in the sibling persistence tests).
 */
function resetStore(): void {
  useEditorStore.setState({
    site: null,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function site(name: string): SiteDocument {
  return makeSite({
    name,
    pages: [makePage({ id: 'page-home', rootNodeId: 'root', nodes: { root: makeNode({ id: 'root' }) } })],
  })
}

function makeCountingAdapter(
  loadedSite: SiteDocument,
): IPersistenceAdapter & { loadCount: () => number; saveCount: () => number } {
  let loads = 0
  let saves = 0
  return {
    async loadSite() {
      loads += 1
      // A real adapter re-parses/re-validates fresh objects on every load
      // (a filesystem re-read or a validated HTTP response) — never hands
      // back the exact same node objects twice. Clone so a second load
      // mutating `parentId` in place doesn't collide with the store's
      // (frozen, in dev) first-load copy.
      return structuredClone(loadedSite)
    },
    async saveSite() {
      saves += 1
    },
    loadCount: () => loads,
    saveCount: () => saves,
  }
}

describe('usePersistence — reload does not re-arm the autosave loop', () => {
  it('clears hasUnsavedChanges on external reload instead of leaving/re-setting it dirty', async () => {
    resetStore()
    const adapter = makeCountingAdapter(site('Reloaded'))
    const { result } = renderHook(() => usePersistence('default', adapter, { enabled: true }))

    await waitFor(() => expect(adapter.loadCount()).toBe(1))
    await waitFor(() => expect(result.current.saveStatus.state).toBe('saved'))

    // Simulate an edit landing right before the external reload fires — the
    // worst case for a write loop: if the reload handler left this `true` (or
    // set it), the very next autosave tick would immediately re-save the
    // document the reload just delivered.
    act(() => {
      useEditorStore.getState().setHasUnsavedChanges(true)
    })
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)

    act(() => {
      window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
    })

    await waitFor(() => expect(adapter.loadCount()).toBe(2))
    // The reload's own effect explicitly clears the flag — it must not stay
    // (or become) dirty as a side effect of loading the fresh document.
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)

    // No save was ever triggered by the reload itself.
    expect(adapter.saveCount()).toBe(0)
  })
})
