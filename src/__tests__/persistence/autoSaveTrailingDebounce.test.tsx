/**
 * Autosave is a TRAILING debounce, not a leading one.
 *
 * `usePersistence`'s autosave timer used to be armed only from the
 * `hasUnsavedChanges` false→true TRANSITION. Because that flag stays true for
 * the whole burst, the timer was never re-armed by later edits: the save fired
 * `delay` ms after the FIRST keystroke — mid-typing — which is the opposite of
 * the "rapid edits collapse into a single save" behaviour the hook's own doc
 * described. In Studio that means a source writeback landing in the middle of
 * a word.
 *
 * This suite drives real edits through the real store against a real (short)
 * delay and asserts on WHEN the adapter is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { usePersistence, AUTOSAVE_MAX_DEFERRAL_MULTIPLE } from '@site/hooks/usePersistence'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { EDITOR_PREFS_KEY } from '@site/preferences/editorPreferences'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const DELAY_MS = 60

function makeRecordingAdapter(): { adapter: IPersistenceAdapter; saveCount: () => number } {
  let saves = 0
  return {
    adapter: {
      loadSite: async () => undefined,
      saveSite: async () => {
        saves++
      },
    },
    saveCount: () => saves,
  }
}

function HookHost({ adapter }: { adapter: IPersistenceAdapter }) {
  usePersistence('default', adapter, { enabled: true, autoSaveDelayMs: DELAY_MS })
  return null
}

function LoadedHost({ adapter, onReady }: { adapter: IPersistenceAdapter; onReady: () => void }) {
  useEffect(onReady, [onReady])
  return <HookHost adapter={adapter} />
}

function seedStore(): void {
  useEditorStore.setState({
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({
          id: 'page-a',
          slug: 'index',
          title: 'Home',
          rootNodeId: 'root',
          nodes: {
            root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }),
            text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: '' } }),
          },
        }),
      ],
    }),
  )
  useEditorStore.setState({ activePageId: 'page-a', hasUnsavedChanges: false } as Parameters<
    typeof useEditorStore.setState
  >[0])
}

/** One keystroke: a real store mutation that mints a new `site` and marks the document dirty. */
function typeCharacter(text: string): void {
  useEditorStore.getState().updateNodeProps('text', { text })
  useEditorStore.getState().setHasUnsavedChanges(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  cleanup()
  globalThis.localStorage?.removeItem(EDITOR_PREFS_KEY)
  seedStore()
})

afterEach(() => {
  cleanup()
  globalThis.localStorage?.removeItem(EDITOR_PREFS_KEY)
})

describe('autosave trailing debounce', () => {
  it('does not fire mid-burst — a keystroke every 0.66 × delay collapses into ONE save after the burst ends', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    render(<LoadedHost adapter={adapter} onReady={() => { ready = true }} />)
    await waitFor(() => expect(ready).toBe(true))

    // Four keystrokes, each well inside the idle delay of the previous one.
    // Total burst: ~3 × 40ms = 120ms, twice the 60ms delay — the OLD leading
    // behaviour would have saved at 60ms, in the middle of "abcd".
    await act(async () => {
      typeCharacter('a')
      await sleep(40)
      typeCharacter('ab')
      await sleep(40)
      typeCharacter('abc')
      await sleep(40)
      typeCharacter('abcd')
    })
    expect(saveCount()).toBe(0)

    // Quiet — now, and only now, the single save lands.
    await waitFor(() => expect(saveCount()).toBe(1), { timeout: 2_000 })
    expect(useEditorStore.getState().site?.pages[0]?.nodes.text?.props.text).toBe('abcd')
  })

  it('still saves a lone edit after one idle delay', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    render(<LoadedHost adapter={adapter} onReady={() => { ready = true }} />)
    await waitFor(() => expect(ready).toBe(true))

    await act(async () => {
      typeCharacter('x')
    })
    await waitFor(() => expect(saveCount()).toBe(1), { timeout: 2_000 })
  })

  it('a continuous burst cannot starve the save forever — the deferral budget forces one through', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    render(<LoadedHost adapter={adapter} onReady={() => { ready = true }} />)
    await waitFor(() => expect(ready).toBe(true))

    // Keep editing faster than the delay for longer than the whole budget.
    const budgetMs = DELAY_MS * AUTOSAVE_MAX_DEFERRAL_MULTIPLE
    const startedAt = Date.now()
    let i = 0
    while (Date.now() - startedAt < budgetMs * 1.5) {
      await act(async () => {
        typeCharacter(`burst-${i++}`)
        await sleep(15)
      })
    }

    // Without the cap this would still be 0: every edit re-armed the timer.
    expect(saveCount()).toBeGreaterThanOrEqual(1)
  })
})
