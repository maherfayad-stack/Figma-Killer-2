/**
 * `speed-02` — the autosave FLUSH half, and the production cadence it flushes
 * ahead of.
 *
 * `flushAutosave()` (`autosaveSchedule.ts`, split out of `usePersistence.ts`
 * by `speed-02`'s own module-size-budget fix) is what the properties panel's
 * blur / Enter / scrub-release handlers call (`PropertiesPanel.tsx`'s
 * `onBlur` / `onKeyDown` / `onPointerUp`) so a field the user visibly
 * finished editing writes to disk without waiting out the trailing debounce.
 * This suite pins three things:
 *
 *   1. `flushAutosave()` is a no-op with nothing dirty (a stray blur/pointerup
 *      elsewhere in the panel must not produce an empty save request);
 *   2. calling it with something dirty triggers the SAME immediate-save path
 *      `EDITOR_SAVE_REQUEST_EVENT` already provides, ahead of the trailing
 *      debounce timer;
 *   3. driven through the REAL `STUDIO_AUTOSAVE_DELAY_MS` (not a synthetic
 *      short delay, unlike `autoSaveTrailingDebounce.test.tsx`), a burst of
 *      edits still collapses into ONE save at the end of the burst, and a
 *      continuous burst is still forced to save at least once a second.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import { flushAutosave } from '@site/hooks/autosaveSchedule'
import { STUDIO_AUTOSAVE_DELAY_MS } from '@site/studio/fsCodemodAdapter'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { EDITOR_PREFS_KEY } from '@site/preferences/editorPreferences'
import { EDITOR_SAVE_REQUEST_EVENT } from '@admin/state/adminEvents'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

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

function HookHost({ adapter, delayMs }: { adapter: IPersistenceAdapter; delayMs: number }) {
  usePersistence('default', adapter, { enabled: true, autoSaveDelayMs: delayMs })
  return null
}

function LoadedHost({
  adapter,
  delayMs,
  onReady,
}: {
  adapter: IPersistenceAdapter
  delayMs: number
  onReady: () => void
}) {
  useEffect(onReady, [onReady])
  return <HookHost adapter={adapter} delayMs={delayMs} />
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

/** A field commit — a real store mutation, the same shape a panel field's blur/Enter/scrub-release produces. */
function commitField(text: string): void {
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

describe('flushAutosave', () => {
  it('is a no-op with nothing dirty — no EDITOR_SAVE_REQUEST_EVENT is dispatched', () => {
    useEditorStore.setState({ hasUnsavedChanges: false })
    let fired = false
    const listener = () => { fired = true }
    window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, listener)
    try {
      flushAutosave()
      expect(fired).toBe(false)
    } finally {
      window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, listener)
    }
  })

  it('dispatches EDITOR_SAVE_REQUEST_EVENT when something is dirty', () => {
    useEditorStore.setState({ hasUnsavedChanges: true })
    let fired = false
    const listener = () => { fired = true }
    window.addEventListener(EDITOR_SAVE_REQUEST_EVENT, listener)
    try {
      flushAutosave()
      expect(fired).toBe(true)
    } finally {
      window.removeEventListener(EDITOR_SAVE_REQUEST_EVENT, listener)
    }
  })

  it('saves immediately, well ahead of a long trailing debounce', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    // A delay long enough that the debounce timer alone would not have
    // fired by the time this test's assertions run.
    render(<LoadedHost adapter={adapter} delayMs={5_000} onReady={() => { ready = true }} />)
    await waitFor(() => expect(ready).toBe(true))

    await act(async () => {
      commitField('flushed')
    })
    expect(saveCount()).toBe(0)

    await act(async () => {
      flushAutosave()
    })
    await waitFor(() => expect(saveCount()).toBe(1))
  })
})

describe('Studio production cadence (STUDIO_AUTOSAVE_DELAY_MS)', () => {
  it('a burst of edits collapses into ONE save, ~250ms after the burst ends', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    render(
      <LoadedHost
        adapter={adapter}
        delayMs={STUDIO_AUTOSAVE_DELAY_MS}
        onReady={() => { ready = true }}
      />,
    )
    await waitFor(() => expect(ready).toBe(true))

    // Three keystrokes, each well inside the 250ms idle delay of the last.
    await act(async () => {
      commitField('a')
      await sleep(80)
      commitField('ab')
      await sleep(80)
      commitField('abc')
    })
    expect(saveCount()).toBe(0)

    await waitFor(() => expect(saveCount()).toBe(1), { timeout: 2_000 })
    expect(useEditorStore.getState().site?.pages[0]?.nodes.text?.props.text).toBe('abc')
  })

  it('a continuous burst still saves at least once a second (the 4x deferral cap)', async () => {
    const { adapter, saveCount } = makeRecordingAdapter()
    let ready = false
    render(
      <LoadedHost
        adapter={adapter}
        delayMs={STUDIO_AUTOSAVE_DELAY_MS}
        onReady={() => { ready = true }}
      />,
    )
    await waitFor(() => expect(ready).toBe(true))

    const startedAt = Date.now()
    let i = 0
    // Keep editing faster than the 250ms idle delay for 1.5s — well past
    // the 1s deferral budget (STUDIO_AUTOSAVE_DELAY_MS × 4).
    while (Date.now() - startedAt < 1_500) {
      await act(async () => {
        commitField(`burst-${i++}`)
        await sleep(60)
      })
    }

    expect(saveCount()).toBeGreaterThanOrEqual(1)
  })
})
