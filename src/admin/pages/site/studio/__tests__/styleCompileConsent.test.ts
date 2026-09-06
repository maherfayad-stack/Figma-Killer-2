/**
 * `styleCompileConsent` — the show/dismiss/persist rule behind the board's
 * first-run "run this project's compiler" banner.
 *
 * THE GATE this file exists for: `shouldOfferStyleCompile` is the ONLY place
 * that decides whether a user is asked to authorise running code from their
 * repository. Both directions of that decision are a real defect if they
 * drift — offering a promote to a project whose styles already render is
 * noise that teaches people to dismiss the prompt reflexively, and staying
 * quiet for a Tier 0 Tailwind project is the exact silence the banner exists
 * to break.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  dismissStyleCompileConsent,
  fetchStyleCompileConsent,
  shouldOfferStyleCompile,
  styleToolchainLabel,
  type StyleCompileConsentStatus,
} from '../styleCompileConsent'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function status(overrides: Partial<StyleCompileConsentStatus> = {}): StyleCompileConsentStatus {
  return {
    trust: 'static',
    toolchains: ['tailwind'],
    dependenciesInstalled: true,
    dismissed: false,
    ...overrides,
  }
}

describe('shouldOfferStyleCompile', () => {
  it('offers a Tier 0 project with a compilable toolchain', () => {
    expect(shouldOfferStyleCompile(status())).toBe(true)
  })

  it('stays quiet for a project with nothing that needs compiling', () => {
    expect(shouldOfferStyleCompile(status({ toolchains: [] }))).toBe(false)
  })

  it('stays quiet once the project is already promoted', () => {
    expect(shouldOfferStyleCompile(status({ trust: 'render-packages' }))).toBe(false)
    expect(shouldOfferStyleCompile(status({ trust: 'run-project' }))).toBe(false)
  })

  it('stays quiet once dismissed — the persisted "not now" is what stops the asking', () => {
    expect(shouldOfferStyleCompile(status({ dismissed: true }))).toBe(false)
  })

  it('still offers when dependencies are missing — the banner explains that, it does not hide', () => {
    expect(shouldOfferStyleCompile(status({ dependenciesInstalled: false }))).toBe(true)
  })
})

describe('styleToolchainLabel', () => {
  it('names one toolchain', () => {
    expect(styleToolchainLabel(['sass'])).toBe('Sass')
  })

  it('joins two with "and"', () => {
    expect(styleToolchainLabel(['tailwind', 'sass'])).toBe('Tailwind and Sass')
  })

  it('joins three with commas and a final "and"', () => {
    expect(styleToolchainLabel(['tailwind', 'sass', 'postcss'])).toBe('Tailwind, Sass and PostCSS')
  })

  it('is empty for no toolchain (the banner never renders in that case)', () => {
    expect(styleToolchainLabel([])).toBe('')
  })
})

describe('fetchStyleCompileConsent', () => {
  it('validates the response against the schema and carries the dir through', async () => {
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(
        JSON.stringify({ trust: 'static', toolchains: ['sass'], dependenciesInstalled: false, dismissed: false }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    const result = await fetchStyleCompileConsent('/tmp/studio-workspace/demo')
    expect(result.toolchains).toEqual(['sass'])
    expect(result.dependenciesInstalled).toBe(false)
    expect(requestedUrl).toContain('/admin/api/studio/style-compile-consent')
    expect(requestedUrl).toContain(encodeURIComponent('/tmp/studio-workspace/demo'))
  })

  it('rejects a response carrying an unknown trust tier rather than trusting it', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ trust: 'run-everything', toolchains: [], dependenciesInstalled: true, dismissed: false }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof globalThis.fetch

    await expect(fetchStyleCompileConsent('/tmp/studio-workspace/demo')).rejects.toThrow()
  })
})

describe('dismissStyleCompileConsent', () => {
  it('POSTs the dir and nothing else — it can never promote', async () => {
    let method = ''
    let body: unknown = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method ?? 'GET'
      body = JSON.parse(String(init?.body ?? 'null'))
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch

    await dismissStyleCompileConsent('/tmp/studio-workspace/demo')
    expect(method).toBe('POST')
    expect(body).toEqual({ dir: '/tmp/studio-workspace/demo' })
  })
})
