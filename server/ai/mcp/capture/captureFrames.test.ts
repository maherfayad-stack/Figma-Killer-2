/**
 * Capture routing — which renderer answers, and what a failure says.
 *
 * The two renderers are stubbed here on purpose: this file is about the
 * DECISION, not about either path's own behaviour (`headlessCapture.test.ts`
 * exercises the headless path for real, and the live path is the unchanged
 * browser handler the bridge relays to). What must hold:
 *
 *   - headless is tried first and, when it works, the tab is never consulted;
 *   - a headless failure falls back to the tab rather than failing the tool;
 *   - `source: 'live'` goes straight to the tab (the state only it knows);
 *   - `source: 'headless'` refuses to quietly take over someone's tab;
 *   - when BOTH fail, the error names BOTH reasons — the specific regression
 *     this feature was built to end, where every failure read "no board
 *     connected" regardless of cause.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AiToolOutput } from '@core/ai'
import type { AiBrowserBridge } from '../../runtime/types'

let headlessImpl: () => Promise<unknown> = async () => ({
  ok: false,
  code: 'headless-browser-unavailable',
  error: 'no browser',
})

mock.module('./headlessCapture', () => ({
  captureFramesHeadless: async () => headlessImpl(),
}))

const { captureFrames } = await import('./captureFrames')
const { clearLaunchFailureMemo } = await import('./browserPool')

let bridgeCalls: Array<{ toolName: string; input: unknown }> = []

function bridge(output: AiToolOutput = { ok: true, data: { frames: [] }, images: [] }): AiBrowserBridge {
  return {
    callBrowser: async (toolName: string, input: unknown) => {
      bridgeCalls.push({ toolName, input })
      return output
    },
  } as AiBrowserBridge
}

const headlessOk: AiToolOutput = {
  ok: true,
  data: { frames: [{ pageId: 'p1', ok: true }], source: 'headless' },
  images: [{ mimeType: 'image/png', data: 'AAA' }],
}

function request(source?: 'auto' | 'headless' | 'live') {
  return {
    userId: 'u1',
    dir: '/workspace/p',
    pageIds: ['p1'],
    ...(source ? { source } : {}),
  }
}

beforeEach(() => {
  bridgeCalls = []
  clearLaunchFailureMemo()
  headlessImpl = async () => ({ ok: false, code: 'headless-browser-unavailable', error: 'no browser' })
})

describe('captureFrames routing', () => {
  it('prefers headless and never touches the editor tab when it succeeds', async () => {
    headlessImpl = async () => ({ ok: true, output: headlessOk })

    const result = await captureFrames(request(), {
      awaitBridge: async () => {
        throw new Error('the bridge must not be consulted when headless works')
      },
    })

    expect(result.source).toBe('headless')
    expect(result.output.ok).toBe(true)
    expect(bridgeCalls).toHaveLength(0)
  })

  it('falls back to the live tab when headless cannot run, and says why it fell back', async () => {
    const result = await captureFrames(request(), { awaitBridge: async () => bridge() })

    expect(result.source).toBe('live')
    expect(result.output.ok).toBe(true)
    expect(result.headlessFailure?.code).toBe('headless-browser-unavailable')
    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.toolName).toBe('studio_export_frames')
  })

  it('forwards dpr, purpose and axes to the live path unchanged', async () => {
    await captureFrames(
      { ...request(), dpr: 2, purpose: 'measurement', axes: { colorScheme: 'dark' } },
      { awaitBridge: async () => bridge() },
    )

    expect(bridgeCalls[0]!.input).toEqual({
      pageIds: ['p1'],
      dpr: 2,
      purpose: 'measurement',
      axes: { colorScheme: 'dark' },
    })
  })

  it('goes straight to the live tab for source:"live" — the only path that sees unsaved state', async () => {
    headlessImpl = async () => {
      throw new Error('headless must not run for source:"live"')
    }

    const result = await captureFrames(request('live'), { awaitBridge: async () => bridge() })

    expect(result.source).toBe('live')
    expect(bridgeCalls).toHaveLength(1)
  })

  it('reports a missing tab for source:"live" without pretending headless could have helped', async () => {
    const result = await captureFrames(request('live'), { awaitBridge: async () => null })

    expect(result.source).toBe('none')
    expect(result.output.ok).toBe(false)
    expect(result.output.error).toContain('source: "live"')
    expect(result.output.error).toContain('no Studio board is connected')
  })

  it('refuses to fall back to a tab when source:"headless" ruled it out', async () => {
    const result = await captureFrames(request('headless'), {
      awaitBridge: async () => {
        throw new Error('the bridge must not be consulted for source:"headless"')
      },
    })

    expect(result.source).toBe('none')
    expect(result.output.ok).toBe(false)
    expect(result.output.error).toContain('no browser')
  })

  it('names BOTH reasons when neither path can produce an image', async () => {
    headlessImpl = async () => ({
      ok: false,
      code: 'headless-not-ready',
      error: 'The capture page did not report every frame settled within 30000ms.',
    })

    const result = await captureFrames(request(), { awaitBridge: async () => null })

    expect(result.source).toBe('none')
    expect(result.output.ok).toBe(false)
    const message = result.output.error!
    // The distinct, named error — not the old "no board connected" for
    // everything.
    expect(message).toContain('capture-unavailable')
    expect(message).toContain('did not report every frame settled')
    expect(message).toContain('no Studio board is connected')
    expect(result.headlessFailure?.code).toBe('headless-not-ready')
  })
})
