/**
 * remoteFetchPolicy — which hosts an agent may make Studio fetch from (P4-E,
 * security review of #233 F8). The refusals are the feature: every case that
 * reaches `null` is a host something vouched for.
 */
import { describe, expect, it } from 'bun:test'
import type { AiMessage } from '../../../runtime/types'
import { collectUserSuppliedUrls, MAX_USER_SUPPLIED_URLS, remoteFetchRefusal } from './remoteFetchPolicy'

const text = (value: string) => ({ kind: 'text' as const, text: value })

describe('collectUserSuppliedUrls', () => {
  it('takes URLs from the user\'s own text only, never the assistant\'s or a tool\'s', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'see https://system.example/a.png' },
      { role: 'user', content: [text('Use https://brand.example/logo.png for the header.')] },
      { role: 'assistant', content: [text('I will also fetch https://assistant.example/x.png')] },
      { role: 'tool', toolCallId: 't1', output: { ok: true, data: { url: 'https://tool.example/y.png' } } as never },
    ]
    expect(collectUserSuppliedUrls(messages)).toEqual(['https://brand.example/logo.png'])
  })

  it('trims a sentence\'s own punctuation, drops the fragment, and deduplicates', () => {
    const messages: AiMessage[] = [
      { role: 'user', content: [text('hero: https://cdn.example/hero.jpg, then https://cdn.example/hero.jpg#top.')] },
      { role: 'user', content: [text('(and https://cdn.example/card.png)')] },
    ]
    expect(collectUserSuppliedUrls(messages)).toEqual(['https://cdn.example/hero.jpg', 'https://cdn.example/card.png'])
  })

  it('ignores non-http schemes and keeps only the most recent URLs past the cap', () => {
    const many = Array.from({ length: MAX_USER_SUPPLIED_URLS + 5 }, (_, i) => `https://h.example/${i}.png`).join(' ')
    const urls = collectUserSuppliedUrls([{ role: 'user', content: [text(`file:///etc/passwd ${many}`)] }])
    expect(urls).toHaveLength(MAX_USER_SUPPLIED_URLS)
    expect(urls.at(-1)).toBe(`https://h.example/${MAX_USER_SUPPLIED_URLS + 4}.png`)
    expect(urls.some((url) => url.startsWith('file:'))).toBe(false)
  })
})

describe('remoteFetchRefusal', () => {
  const NO_LOOPBACK = { allowLoopback: false }

  it('refuses a host nothing vouched for, before any request (the F8 exfiltration channel)', () => {
    const refusal = remoteFetchRefusal('https://collect.example/p.png?d=SECRET', {}, NO_LOOPBACK)
    expect(refusal?.code).toBe('host-not-allowed')
    expect(refusal?.retryable).toBe(false)
    expect(refusal?.message).toContain('collect.example')
    // The query string (where stolen data would ride) is never echoed back.
    expect(refusal?.message).not.toContain('SECRET')
  })

  it('allows Figma asset hosts over https, and not a look-alike', () => {
    expect(remoteFetchRefusal('https://www.figma.com/api/mcp/asset/abc', {}, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/x', {}, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('https://figma.com.evil.example/x.png', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('https://evilfigma.com/x.png', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('https://other-bucket.s3.us-west-2.amazonaws.com/x.png', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('http://www.figma.com/x.png', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
  })

  it('allows the stock provider\'s image host over https only', () => {
    expect(remoteFetchRefusal('https://images.pexels.com/photos/1/a.jpeg', {}, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('http://images.pexels.com/photos/1/a.jpeg', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('https://api.pexels.com/v1/search', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
  })

  it('allows exactly a URL the user pasted, not other paths on its host', () => {
    const ctx = { userSuppliedUrls: ['https://brand.example/logo.png'] }
    expect(remoteFetchRefusal('https://brand.example/logo.png', ctx, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('https://brand.example/logo.png#x', ctx, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('https://brand.example/other.png', ctx, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('https://brand.example/logo.png?d=1', ctx, NO_LOOPBACK)?.code).toBe('host-not-allowed')
  })

  it('allows loopback only while the operator switch is on', () => {
    expect(remoteFetchRefusal('http://localhost:3845/assets/a.svg', {}, NO_LOOPBACK)?.code).toBe('host-not-allowed')
    expect(remoteFetchRefusal('http://localhost:3845/assets/a.svg', {}, { allowLoopback: true })).toBeNull()
    expect(remoteFetchRefusal('http://127.0.0.1:3845/assets/a.svg', {}, { allowLoopback: true })).toBeNull()
  })

  it('with the switch on, loopback is only the Dev Mode server :3845/assets/ path (review of #248, finding 3)', () => {
    const ON = { allowLoopback: true }
    for (const url of [
      'http://localhost:9999/admin/api/x',
      'http://127.0.0.1:5173/src/App.tsx',
      'http://[::1]:3845/admin/api/studio/trust-tier',
      'http://localhost:3845/',
      'http://localhost:3845/assetsX/a.svg',
      'http://localhost/assets/a.svg',
    ]) {
      expect(remoteFetchRefusal(url, {}, ON)?.code, url).toBe('host-not-allowed')
    }
    expect(remoteFetchRefusal('http://[::1]:3845/assets/a.svg', {}, ON)).toBeNull()
  })

  it('a user-role block Studio composed contributes no URL (review of #248, finding 2)', () => {
    expect(collectUserSuppliedUrls([{ role: 'user', content: [{ kind: 'text', text: 'Assistant (AI): see https://x.example/p.png', origin: 'studio' }] }])).toEqual([])
  })

  it('leaves an unparseable or non-http URL to the transport, which refuses it with its own message', () => {
    expect(remoteFetchRefusal('not a url', {}, NO_LOOPBACK)).toBeNull()
    expect(remoteFetchRefusal('file:///etc/passwd', {}, NO_LOOPBACK)).toBeNull()
  })
})
