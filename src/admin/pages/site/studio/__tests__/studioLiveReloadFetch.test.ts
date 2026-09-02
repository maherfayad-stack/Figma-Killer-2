/**
 * `fetchStudioPagesById` — the targeted `?pageIds=` reload both the MCP
 * live-reload bridge and the user's own structural commits go through.
 *
 * THE GATE this file exists for: the stream's `meta` line must be APPLIED,
 * not just mined for `missingPageIds`. The server recomputes it in full on
 * every load precisely because `styleRules`/`conditions`/`authoredCss` are
 * project-wide and the edit that triggered the reload can change any of them
 * (`server/handlers/studio/studioLoadResponse.ts`). Dropping it applied fresh
 * page trees against the previous stylesheet: nodes whose `classIds` name a
 * rule the stale registry never saw resolve to no class at all, so the page
 * renders unstyled and collapsed until a manual refresh.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { fetchStudioPagesById } from '../studioLiveReloadFetch'
import { getStudioAuthoredCss, getStudioVendorCss, setStudioAuthoredCss, setStudioVendorCss } from '../studioRawCssStores'
import { getStudioTrustTier, setStudioTrustTier } from '../studioProjectTrust'
import { getStudioStyleRuleSources } from '../styleRuleWriteback'
import { makePage } from '../../../../../__tests__/fixtures'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

interface MetaOverrides {
  styleRules?: Record<string, unknown>
  styleRuleSources?: Record<string, unknown>
  conditions?: unknown[]
  vendorCss?: string
  authoredCss?: string
  trust?: string
  missingPageIds?: string[]
}

/** A real `StyleRuleSchema` shape — the stream line is TypeBox-validated, so a shorthand would be rejected before the code under test ever runs. */
function styleRule(name: string): Record<string, unknown> {
  return { id: name, name, kind: 'class', selector: `.${name}`, order: 0, styles: {}, contextStyles: {}, createdAt: 0, updatedAt: 0 }
}

function stubLoadStream(pages: unknown[], meta: MetaOverrides = {}): void {
  const line = {
    kind: 'meta',
    dir: '/tmp/studio-test',
    projectName: 'studio-test',
    componentSources: {},
    styleRules: {},
    styleRuleSources: {},
    conditions: [],
    vendorCss: '',
    authoredCss: '',
    trust: 'static',
    paletteHiddenModuleIds: [],
    pageCount: pages.length,
    ...meta,
  }
  const body = [line, ...pages.map((page) => ({ kind: 'page', page }))]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch
}

describe('fetchStudioPagesById — the meta line is applied, not discarded', () => {
  it('returns the reload’s own styleRules and conditions for the caller to patch in', async () => {
    stubLoadStream([makePage({ id: 'home', slug: 'index', title: 'Home' })], {
      styleRules: { fresh: styleRule('fresh') },
      conditions: [{ id: 'dark', label: 'Dark', condition: { kind: 'media', query: '(prefers-color-scheme: dark)' } }],
    })

    const result = await fetchStudioPagesById(['home'])

    expect(Object.keys(result.styleRules)).toEqual(['fresh'])
    expect(result.conditions).toHaveLength(1)
    expect(result.pages.map((p) => p.id)).toEqual(['home'])
  })

  it('applies the raw CSS stores, so an agent’s new stylesheet reaches the canvas without a refresh', async () => {
    setStudioVendorCss('/* old vendor */')
    setStudioAuthoredCss('/* old authored */')

    stubLoadStream([], { vendorCss: '/* new vendor */', authoredCss: '.hero { color: red }' })
    await fetchStudioPagesById(['home'])

    expect(getStudioVendorCss()).toBe('/* new vendor */')
    expect(getStudioAuthoredCss()).toBe('.hero { color: red }')
  })

  it('applies the write-back map, so a rule the edit just introduced is editable rather than in-memory-only', async () => {
    stubLoadStream([], {
      styleRules: { hero: styleRule('hero') },
      styleRuleSources: { hero: { file: 'src/app.css', selector: '.hero' } },
    })

    await fetchStudioPagesById(['home'])

    expect(getStudioStyleRuleSources().hero).toBeDefined()
  })

  it('applies the trust tier', async () => {
    setStudioTrustTier('static')
    stubLoadStream([], { trust: 'run-project' })

    await fetchStudioPagesById(['home'])

    expect(getStudioTrustTier()).toBe('run-project')
  })

  it('reads missingPageIds off the same line, as it always did', async () => {
    stubLoadStream([], { missingPageIds: ['deleted-page'] })
    expect((await fetchStudioPagesById(['deleted-page'])).missingPageIds).toEqual(['deleted-page'])
  })
})
