/**
 * AuthoredCssInjector (`board-27`) — a project's own CSS lands in the iframe
 * as RAW text, in its own `<style id="mc-authored">`, wrapped in `@layer
 * user-authored` and always preceding `ClassStyleInjector`'s `mc-classes` in
 * DOM source order — the ordering the whole fix depends on (see
 * `AuthoredCssInjector.tsx`'s "Raw vs. overlay" doc: cascade priority inside
 * one `@layer` is source order, so a session-edited overlay rule in
 * `mc-classes` must come AFTER this injector's raw snapshot to win for the
 * same selector).
 *
 * What this file CANNOT prove: whether a real browser actually resolves
 * `@layer` precedence the way the emitted text implies — happy-dom has no
 * layout/style engine. This suite only asserts the STRUCTURE (tag ids, layer
 * wrapper, DOM order) of the emitted stylesheets; see `projectCssInjector.
 * test.tsx` for the sibling suite this one mirrors.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { AuthoredCssInjector } from '@site/canvas/AuthoredCssInjector'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { fsCodemodAdapter, getStudioAuthoredCss } from '@admin/pages/site/studio/fsCodemodAdapter'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from '@site/canvas/canvasCssLayers'
import { useEditorStore } from '@site/store/store'

afterEach(cleanup)

const originalFetch = globalThis.fetch

function stubLoad(authoredCss: string): void {
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
      styleRules: {}, styleRuleSources: {}, conditions: [], vendorCss: '', authoredCss,
      trust: 'static', paletteHiddenModuleIds: [], pageCount: 0,
    })
    return new Response(`${metaLine}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
  }) as typeof fetch
}

async function loadAuthoredCss(authoredCss: string): Promise<void> {
  stubLoad(authoredCss)
  // The store subscribers AuthoredCssInjector attaches via
  // useSyncExternalStore fire synchronously off this call — wrap so React
  // doesn't warn about an update outside act().
  await act(async () => {
    await fsCodemodAdapter.loadSite()
  })
  globalThis.fetch = originalFetch
}

describe('AuthoredCssInjector', () => {
  it('injects a <style id="mc-authored"> wrapped in @layer user-authored, preceded by the explicit layer-order declaration', async () => {
    await loadAuthoredCss('.hero { background: color-mix(in srgb, red 50%, blue 50%); }')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<AuthoredCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-authored')?.textContent ?? ''
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    expect(css).toContain(`@layer ${USER_AUTHORED_LAYER} {`)
    expect(css).toContain('.hero { background: color-mix(in srgb, red 50%, blue 50%); }')
  })

  it('carries the authored bytes through completely unparsed — the exact case happy-dom\'s CSSOM would drop', async () => {
    const raw = '.hero { border-color: Canvas; color: hsl(0 0% 0% / .2); }'
    await loadAuthoredCss(raw)
    expect(getStudioAuthoredCss()).toBe(raw)

    const target = document.implementation.createHTMLDocument('iframe')
    render(<AuthoredCssInjector targetDocument={target} />)
    expect(target.getElementById('mc-authored')?.textContent ?? '').toContain(raw)
  })

  it('still declares the layer order when there is no authored CSS at all', async () => {
    await loadAuthoredCss('')

    const target = document.implementation.createHTMLDocument('iframe')
    render(<AuthoredCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-authored')?.textContent ?? ''
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    expect(css).toContain('/* no authored css */')
  })

  it('reflects a fresh authored CSS value after a reload (reactive, not a stale snapshot)', async () => {
    await loadAuthoredCss('.first { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const { rerender } = render(<AuthoredCssInjector targetDocument={target} />)

    expect(target.getElementById('mc-authored')?.textContent ?? '').toContain('.first { color: red }')

    await loadAuthoredCss('.second { color: blue }')
    rerender(<AuthoredCssInjector targetDocument={target} />)

    const css = target.getElementById('mc-authored')?.textContent ?? ''
    expect(css).toContain('.second { color: blue }')
    expect(css).not.toContain('.first { color: red }')
  })

  it('removes its <style> tag on unmount', async () => {
    await loadAuthoredCss('.gone { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const { unmount } = render(<AuthoredCssInjector targetDocument={target} />)

    expect(target.getElementById('mc-authored')).not.toBeNull()
    unmount()
    expect(target.getElementById('mc-authored')).toBeNull()
  })

  it('precedes ClassStyleInjector\'s mc-classes in DOM source order regardless of mount order', async () => {
    await loadAuthoredCss('.hero { color: red }')
    useEditorStore.setState({ site: null } as Parameters<typeof useEditorStore.setState>[0])

    // Mount ClassStyleInjector FIRST (it appends), AuthoredCssInjector SECOND
    // (it always inserts at head.firstChild) — the ordering invariant must
    // hold regardless of which one happens to mount first.
    const target = document.implementation.createHTMLDocument('iframe')
    render(
      <>
        <ClassStyleInjector targetDocument={target} />
        <AuthoredCssInjector targetDocument={target} />
      </>,
    )

    const children = [...target.head.children].map((el) => el.id).filter(Boolean)
    const authoredIndex = children.indexOf('mc-authored')
    const classesIndex = children.indexOf('mc-classes')
    expect(authoredIndex).toBeGreaterThanOrEqual(0)
    expect(classesIndex).toBeGreaterThanOrEqual(0)
    expect(authoredIndex).toBeLessThan(classesIndex)
  })
})
