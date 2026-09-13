/**
 * useLiveOrigin — L8 Phase A (`perf-06`, STATE.md).
 *
 * Proves the external-store contract the CONTRACTS block specified
 * (`getLiveOrigin`/`subscribeLiveOrigin`/`setLiveOrigin`) and the hook's
 * "fetch once, share across every mounted consumer" posture — the real
 * reason it's an external store rather than a plain per-component
 * `useEffect` + `useState`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
  __resetLiveOriginForTests,
  getLiveOrigin,
  setLiveOrigin,
  subscribeLiveOrigin,
  useLiveOrigin,
} from '@site/studio/useLiveOrigin'

// `bun test` runs every matched file in one shared process — without this,
// a DIFFERENT test file that mounted `useLiveOrigin` earlier in the same run
// permanently wins the module's fetch-dedup, and this file's own stub
// `fetch` never gets called. See `__resetLiveOriginForTests`'s own doc.
beforeEach(__resetLiveOriginForTests)
afterEach(() => {
  cleanup()
  __resetLiveOriginForTests()
})

describe('useLiveOrigin — the plain external store', () => {
  it('getLiveOrigin/subscribeLiveOrigin/setLiveOrigin round-trip and notify listeners', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeLiveOrigin(() => seen.push(getLiveOrigin()))

    setLiveOrigin('https://live.studio.test')
    expect(getLiveOrigin()).toBe('https://live.studio.test')
    expect(seen).toEqual(['https://live.studio.test'])

    // Setting the SAME value again is a no-op — no redundant listener fire.
    setLiveOrigin('https://live.studio.test')
    expect(seen).toEqual(['https://live.studio.test'])

    setLiveOrigin(null)
    expect(getLiveOrigin()).toBeNull()
    expect(seen).toEqual(['https://live.studio.test', null])

    unsubscribe()
  })
})

describe('useLiveOrigin — the hook', () => {
  it('fetches the live origin once and shares it across every mounted consumer', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ liveOrigin: 'https://live.shared.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      function Consumer({ id }: { id: string }) {
        const origin = useLiveOrigin()
        return <span data-testid={`origin-${id}`}>{origin ?? 'none'}</span>
      }

      const { getByTestId } = render(
        <>
          <Consumer id="a" />
          <Consumer id="b" />
        </>,
      )

      await waitFor(() => {
        expect(getByTestId('origin-a').textContent).toBe('https://live.shared.test')
        expect(getByTestId('origin-b').textContent).toBe('https://live.shared.test')
      })

      // One fetch feeds every mounted frame — not one per consumer.
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
