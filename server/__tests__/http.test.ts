/**
 * ndjsonResponse — server/http.ts's newline-delimited-JSON response builder
 * (WS-5.5, pairs with `@core/http`'s `ndjsonRequest` on the client).
 */
import { describe, expect, it } from 'bun:test'
import { ndjsonResponse } from '../http'

async function readAllLines(res: Response): Promise<string[]> {
  const text = await res.text()
  return text.split('\n').filter((line) => line.length > 0)
}

describe('ndjsonResponse', () => {
  it('emits one JSON-stringified line per item, in order', async () => {
    const res = ndjsonResponse([{ a: 1 }, { a: 2 }, { a: 3 }])
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const lines = await readAllLines(res)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('accepts an async generator and preserves order', async () => {
    async function* gen() {
      yield { n: 1 }
      await Promise.resolve()
      yield { n: 2 }
    }
    const res = ndjsonResponse(gen())
    const lines = await readAllLines(res)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('errors the stream (not the whole request) when the source throws mid-iteration', async () => {
    async function* gen() {
      yield { n: 1 }
      throw new Error('boom')
    }
    const res = ndjsonResponse(gen())
    const err = await res.text().catch((e) => e)
    expect(err).toBeInstanceOf(Error)
  })

  it('produces an empty body for an empty source', async () => {
    const res = ndjsonResponse([])
    expect(await res.text()).toBe('')
  })
})
