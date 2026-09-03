/**
 * The unload flush has to reach the server.
 *
 * `beforeunload` cannot await, so the save is fire-and-forget — and an
 * ordinary `fetch` issued as the document is torn down is CANCELLED by the
 * browser. That made every edit inside the autosave debounce window a coin
 * flip on refresh: sometimes saved, sometimes silently back to what the file
 * said. `keepalive` is the platform's promise to deliver it anyway, and this
 * pins that the option actually reaches the request.
 */
import { describe, it, expect } from 'bun:test'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'

const OkSchema = Type.Object({ ok: Type.Boolean() })

function recordingFetch(seen: RequestInit[]) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    seen.push(init ?? {})
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

describe('apiRequest keepalive', () => {
  it('sets keepalive on the request when asked', async () => {
    const seen: RequestInit[] = []
    await apiRequest('/admin/api/studio/save', {
      method: 'POST',
      body: { edits: [] },
      schema: OkSchema,
      keepalive: true,
      fetchImpl: recordingFetch(seen),
    })
    expect(seen[0]?.keepalive).toBe(true)
  })

  it('leaves it unset for an ordinary save, so a normal request is not capped', () => {
    // `keepalive` carries a 64KB body limit across in-flight requests. An
    // ordinary autosave has no teardown to survive and must not pay it.
    const seen: RequestInit[] = []
    return apiRequest('/admin/api/studio/save', {
      method: 'POST',
      body: { edits: [] },
      schema: OkSchema,
      fetchImpl: recordingFetch(seen),
    }).then(() => {
      expect(seen[0]?.keepalive).toBeUndefined()
    })
  })
})
