import { describe, expect, it } from 'bun:test'
import {
  executeMcpBridgeRequest,
  runMcpWorkspaceBridgeConnection,
} from '@admin/ai/useMcpWorkspaceBridge'

describe('executeMcpBridgeRequest', () => {
  it('turns a post-mutation save failure into a tool error', async () => {
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: true, data: { changed: true } }),
      'site_apply_css',
      {},
      async () => {
        throw new Error('Draft save failed')
      },
    )

    expect(result).toEqual({ ok: false, error: 'Draft save failed' })
  })

  it('does not persist a failed tool result', async () => {
    let persisted = false
    const result = await executeMcpBridgeRequest(
      async () => ({ ok: false, error: 'Invalid CSS' }),
      'site_apply_css',
      {},
      async () => {
        persisted = true
      },
    )

    expect(result).toEqual({ ok: false, error: 'Invalid CSS' })
    expect(persisted).toBe(false)
  })
})

describe('runMcpWorkspaceBridgeConnection', () => {
  it('aborts a connection whose result POST fails and starts the next attempt fresh', async () => {
    const realFetch = globalThis.fetch
    const connectionSignals: AbortSignal[] = []
    let requestCount = 0
    globalThis.fetch = (async (_input, init) => {
      requestCount += 1
      if (requestCount === 1) {
        const signal = init?.signal as AbortSignal
        expect(signal.aborted).toBe(false)
        connectionSignals.push(signal)
        return new Response([
          JSON.stringify({ type: 'bridgeReady', bridgeId: 'bridge-stale' }),
          JSON.stringify({
            type: 'toolRequest',
            requestId: 'request-stale',
            toolName: 'site_apply_css',
            input: {},
          }),
          '',
        ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      if (requestCount === 2) {
        return new Response(
          JSON.stringify({ error: 'The editor bridge no longer owns this request.' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const signal = init?.signal as AbortSignal
      expect(signal.aborted).toBe(false)
      connectionSignals.push(signal)
      return new Response(null, { status: 401 })
    }) as typeof fetch

    const lifecycleController = new AbortController()
    try {
      await expect(runMcpWorkspaceBridgeConnection(
        'site',
        async () => ({ ok: true }),
        undefined,
        lifecycleController.signal,
      )).rejects.toThrow('The editor bridge no longer owns this request.')

      expect(lifecycleController.signal.aborted).toBe(false)
      expect(connectionSignals[0]?.aborted).toBe(true)

      await expect(runMcpWorkspaceBridgeConnection(
        'site',
        async () => ({ ok: true }),
        undefined,
        lifecycleController.signal,
      )).resolves.toBe('auth')
      expect(connectionSignals[1]?.aborted).toBe(true)
      expect(requestCount).toBe(3)
    } finally {
      lifecycleController.abort()
      globalThis.fetch = realFetch
    }
  })
})
