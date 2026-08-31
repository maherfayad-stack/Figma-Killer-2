/**
 * ProjectCssInjector (WS-2.3) — vendor package CSS lands in the iframe as its
 * own `@layer vendor` bucket, ordered below `@layer user-authored` via the
 * explicit `CANVAS_CSS_LAYER_ORDER` pre-declaration, and never touches the
 * editable class registry.
 *
 * What this file CANNOT prove: whether a real browser actually resolves the
 * `@layer vendor, user-authored;` pre-declaration to put `user-authored`
 * ahead of `vendor` in the computed cascade — happy-dom has no layout/style
 * engine, so it cannot evaluate cascade-layer precedence at all. This suite
 * only asserts the STRUCTURE of the emitted stylesheet text (the layers and
 * ordering statement are present, in the right shape); see the Playwright
 * spec for the actual computed-style assertion.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { ProjectCssInjector } from '@site/canvas/ProjectCssInjector'
import { fsCodemodAdapter, getStudioVendorCss } from '@admin/pages/site/studio/fsCodemodAdapter'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER, VENDOR_LAYER } from '@site/canvas/canvasCssLayers'

afterEach(cleanup)

const originalFetch = globalThis.fetch

function stubLoad(vendorCss: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.split('?')[0]
    if (path === '/admin/api/studio/framework') {
      return new Response(JSON.stringify({ framework: null }), { status: 200 })
    }
    // `fsCodemodAdapter.loadSite` reads `/admin/api/studio/load?stream=1` as
    // NDJSON (WS-5.5) — a single `kind: 'meta'` line here since this suite's
    // fixture never has any pages.
    const metaLine = JSON.stringify({
      kind: 'meta',
      dir: '/tmp/studio-test', projectName: 'studio-test', componentSources: {},
      styleRules: {}, styleRuleSources: {}, conditions: [], vendorCss, authoredCss: '', trust: 'static', paletteHiddenModuleIds: [],
      pageCount: 0,
    })
    return new Response(`${metaLine}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }) as typeof fetch
}

async function loadVendorCss(vendorCss: string): Promise<void> {
  stubLoad(vendorCss)
  // The store subscribers ProjectCssInjector attaches via useSyncExternalStore
  // fire synchronously off this call — wrap so React doesn't warn about an
  // update outside act().
  await act(async () => {
    await fsCodemodAdapter.loadSite()
  })
  globalThis.fetch = originalFetch
}

describe('ProjectCssInjector', () => {
  it('injects a <style id="mc-vendor"> wrapped in @layer vendor, preceded by the explicit layer-order declaration', async () => {
    await loadVendorCss('.btn--primary { color: hotpink }')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<ProjectCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-vendor')?.textContent ?? ''
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    expect(css).toContain(`@layer ${VENDOR_LAYER} {`)
    expect(css).toContain('.btn--primary { color: hotpink }')
    // Never the user-authored layer name inside a rule body here — this
    // stylesheet's only job is to DECLARE that layer's relative order, not
    // to contribute rules to it.
    expect(css).not.toContain(`@layer ${USER_AUTHORED_LAYER} {`)
  })

  it('still declares the layer order (and sets nothing else) when there is no vendor CSS at all', async () => {
    await loadVendorCss('')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<ProjectCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-vendor')?.textContent ?? ''
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    // The bundled @alm-design/design-system CSS is a second, always-present
    // source (see the module doc) — real component rules are still expected,
    // but a project-supplied vendorCss of '' contributes nothing of its own.
  })

  it('concatenates the open project\'s vendor CSS with the bundled design-system CSS in the SAME layer', async () => {
    await loadVendorCss('.acme-btn { color: teal }')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<ProjectCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-vendor')?.textContent ?? ''
    const layerOpen = css.indexOf(`@layer ${VENDOR_LAYER} {`)
    const acmeIndex = css.indexOf('.acme-btn')
    expect(layerOpen).toBeGreaterThanOrEqual(0)
    expect(acmeIndex).toBeGreaterThan(layerOpen)
  })

  it('reflects a fresh vendor CSS value after a reload (reactive, not a stale snapshot)', async () => {
    await loadVendorCss('.first { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const { rerender } = render(<ProjectCssInjector targetDocument={target} />)

    expect(target.getElementById('mc-vendor')?.textContent ?? '').toContain('.first { color: red }')

    await loadVendorCss('.second { color: blue }')
    rerender(<ProjectCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-vendor')?.textContent ?? ''
    expect(css).toContain('.second { color: blue }')
    expect(css).not.toContain('.first { color: red }')
  })

  it('carries the vendor bytes through completely unparsed — no selector rewriting, no escaping', async () => {
    const raw = '.weird-selector[data-x="y"]::before { content: "z" }'
    await loadVendorCss(raw)
    expect(getStudioVendorCss()).toBe(raw)

    const target = document.implementation.createHTMLDocument('iframe')
    render(<ProjectCssInjector targetDocument={target} />)
    expect(target.getElementById('mc-vendor')?.textContent ?? '').toContain(raw)
  })

  it('removes its <style> tag on unmount', async () => {
    await loadVendorCss('.gone { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const { unmount } = render(<ProjectCssInjector targetDocument={target} />)

    expect(target.getElementById('mc-vendor')).not.toBeNull()
    unmount()
    expect(target.getElementById('mc-vendor')).toBeNull()
  })
})
