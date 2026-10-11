/**
 * r3 audit P2 - every board load logged a 404 for `...&amp;path=...`: the
 * poster capture read an <img src> out of SERIALIZED markup, where `&` is
 * written `&amp;`, and fetched it without decoding. The request carried
 * `amp;path` and the asset handler never saw `path`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearPosterInlineCache, decodeMarkupUrl, inlineAll } from './posterRasterizer'

const realFetch = globalThis.fetch
let requested: string[]

beforeEach(() => {
  requested = []
  clearPosterInlineCache()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input))
    return new Response(new Blob(['x'], { type: 'image/png' }))
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('poster capture decodes entity-escaped URLs before fetching them', () => {
  it('decodeMarkupUrl turns &amp; into & once (and &amp;lt; into &lt;, not <)', () => {
    expect(decodeMarkupUrl('/a?dir=D&amp;path=src%2Fx.png')).toBe('/a?dir=D&path=src%2Fx.png')
    expect(decodeMarkupUrl('&amp;lt;')).toBe('&lt;')
  })

  it('fetches the <img src> with a real & in the query, never "amp;"', async () => {
    const body = '<img src="/admin/api/studio/asset?dir=C%3A%5Cshop&amp;path=src%2Fassets%2Fhero.png">'
    const result = await inlineAll('', body, 'http://127.0.0.1:6131/admin/site')
    expect(requested).toEqual(['http://127.0.0.1:6131/admin/api/studio/asset?dir=C%3A%5Cshop&path=src%2Fassets%2Fhero.png'])
    expect(requested.join('')).not.toContain('amp;')
    expect(result.body).toContain('src="data:')
  })

  it('does the same for a url() in an inline style attribute', async () => {
    const body = '<div style="background-image: url(/admin/api/studio/asset?dir=D&amp;path=a.png)"></div>'
    await inlineAll('', body, 'http://127.0.0.1:6131/admin/site')
    expect(requested).toEqual(['http://127.0.0.1:6131/admin/api/studio/asset?dir=D&path=a.png'])
  })
})
