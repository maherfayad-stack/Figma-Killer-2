/**
 * `loadSite` — which page stays open across a reload.
 *
 * `loadSite` is used for two different things: OPENING a document (a project
 * switch, first load) and RE-SYNCING the document already open. Studio does the
 * second one on a timer: after a writeback that moved line numbers or rewrote a
 * shared component, the whole workspace is re-parsed from disk so the in-memory
 * `relFile:line:col` node ids match the files again.
 *
 * Resetting the active page to the home page is right for the first case and
 * wrong for the second — it threw the designer back to the home page seconds
 * after an unrelated keystroke, which read as the canvas jumping on its own. The
 * discriminator is whether the incoming site still contains the page that was
 * open: same id means same page, so keep it; a genuine project switch has no
 * matching id and falls through to home.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function freshStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

/** A site whose pages carry explicit ids/slugs, with `index` as the home page. */
function siteWithPages(ids: readonly string[]) {
  return makeSite({
    pages: ids.map((id) =>
      makePage({ id, slug: id === 'home' ? 'index' : id, title: id }),
    ),
  })
}

describe('loadSite — active page across a reload', () => {
  it('keeps the open page when the reloaded site still contains it', () => {
    const store = useEditorStore.getState()
    store.loadSite(siteWithPages(['home', 'checkout', 'confirmation']))

    // The designer navigates away from home.
    useEditorStore.getState().openPageInCanvas('checkout')
    expect(useEditorStore.getState().activePageId).toBe('checkout')

    // A studio writeback re-parses the workspace: same project, same page ids.
    useEditorStore.getState().loadSite(siteWithPages(['home', 'checkout', 'confirmation']))

    expect(useEditorStore.getState().activePageId).toBe('checkout')
  })

  it('falls back to the home page when the reloaded site no longer has it', () => {
    const store = useEditorStore.getState()
    store.loadSite(siteWithPages(['home', 'checkout']))
    useEditorStore.getState().openPageInCanvas('checkout')

    // A different project — none of the previous ids exist here.
    useEditorStore.getState().loadSite(siteWithPages(['home', 'pricing']))

    expect(useEditorStore.getState().activePageId).toBe('home')
  })

  it('opens on the home page on a first load, not whatever is first in the array', () => {
    // `home` is deliberately last so array order and home-page order disagree.
    useEditorStore.getState().loadSite(siteWithPages(['checkout', 'pricing', 'home']))

    expect(useEditorStore.getState().activePageId).toBe('home')
  })
})
