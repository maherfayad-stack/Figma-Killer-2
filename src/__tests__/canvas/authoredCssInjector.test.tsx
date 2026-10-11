/**
 * AuthoredCssInjector (`board-27`) — a project's own CSS lands in the iframe
 * as RAW text, in its own `applyOverlay('mc-authored', …)` overlay, wrapped
 * in `@layer user-authored` and always preceding `ClassStyleInjector`'s
 * `mc-classes` in DOM source order — the ordering the whole fix depends on
 * (see `AuthoredCssInjector.tsx`'s "Raw vs. overlay" doc: cascade priority
 * inside one `@layer` is source order, so a session-edited overlay rule in
 * `mc-classes` must come AFTER this injector's raw snapshot to win for the
 * same selector).
 *
 * Since `live-05` (STATE.md), both injectors route through
 * `adapter.applyOverlay`, whose managed `<style>` elements carry a PREFIXED
 * physical DOM `id` and the real logical id in a `data-studio-overlay-id`
 * attribute instead (see `overlayStyleAttr.ts`) — assertions below query by
 * that attribute, not `getElementById`.
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
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { fsCodemodAdapter, getStudioAuthoredCss } from '@admin/pages/site/studio/fsCodemodAdapter'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from '@site/canvas/canvasCssLayers'
import { useEditorStore } from '@site/store/store'

let adapters: PortalFrameAdapter[] = []

afterEach(() => {
  cleanup()
  for (const adapter of adapters) adapter.dispose()
  adapters = []
})

const originalFetch = globalThis.fetch

function overlayCss(target: Document, logicalId: string): string {
  return target.querySelector(`[data-studio-overlay-id="${logicalId}"]`)?.textContent ?? ''
}

function makeAdapter(target: Document): PortalFrameAdapter {
  const adapter = new PortalFrameAdapter(target)
  adapters.push(adapter)
  return adapter
}

function stubLoad(authoredCss: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.split('?')[0]
    if (path === '/admin/api/studio/framework') {
      return new Response(JSON.stringify({ framework: null, fonts: null }), { status: 200 })
    }
    // `fsCodemodAdapter.loadSite` reads `/admin/api/studio/load?stream=1` as
    // NDJSON (WS-5.5) — a single `kind: 'meta'` line here since this suite's
    // fixture never has any pages.
    const metaLine = JSON.stringify({
      kind: 'meta',
      dir: '/tmp/studio-test', projectName: 'studio-test', componentSources: {},
      styleRules: {}, styleRuleSources: {}, styledStyleRuleSources: {}, conditions: [], vendorCss: '', authoredCss,
      trust: 'static', paletteHiddenModuleIds: [], pageList: [],
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
  it('injects an mc-authored overlay wrapped in @layer user-authored, preceded by the explicit layer-order declaration', async () => {
    await loadAuthoredCss('.hero { background: color-mix(in srgb, red 50%, blue 50%); }')

    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    const css = overlayCss(target, 'mc-authored')
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    expect(css).toContain(`@layer ${USER_AUTHORED_LAYER} {`)
    expect(css).toContain('.hero { background: color-mix(in srgb, red 50%, blue 50%); }')
  })

  it('carries the authored bytes through completely unparsed — the exact case happy-dom\'s CSSOM would drop', async () => {
    const raw = '.hero { border-color: Canvas; color: hsl(0 0% 0% / .2); }'
    await loadAuthoredCss(raw)
    expect(getStudioAuthoredCss()).toBe(raw)

    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )
    expect(overlayCss(target, 'mc-authored')).toContain(raw)
  })

  it('still declares the layer order when there is no authored CSS at all', async () => {
    await loadAuthoredCss('')

    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    const css = overlayCss(target, 'mc-authored')
    expect(css).toContain(CANVAS_CSS_LAYER_ORDER)
    expect(css).toContain('/* no authored css */')
  })

  it('reflects a fresh authored CSS value after a reload (reactive, not a stale snapshot)', async () => {
    await loadAuthoredCss('.first { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    const { rerender } = render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    expect(overlayCss(target, 'mc-authored')).toContain('.first { color: red }')

    await loadAuthoredCss('.second { color: blue }')
    rerender(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    const css = overlayCss(target, 'mc-authored')
    expect(css).toContain('.second { color: blue }')
    expect(css).not.toContain('.first { color: red }')
  })

  it('removes its overlay on unmount', async () => {
    await loadAuthoredCss('.gone { color: red }')
    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    const { unmount } = render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    expect(target.querySelector('[data-studio-overlay-id="mc-authored"]')).not.toBeNull()
    unmount()
    expect(target.querySelector('[data-studio-overlay-id="mc-authored"]')).toBeNull()
  })

  it('precedes ClassStyleInjector\'s mc-classes in DOM source order, matching production JSX order', async () => {
    await loadAuthoredCss('.hero { color: red }')
    useEditorStore.setState({ site: null } as Parameters<typeof useEditorStore.setState>[0])

    // Since `live-05`, both go through `adapter.applyOverlay`, whose managed
    // style elements are appended in first-call order — cascade order within
    // `@layer user-authored` is therefore fixed by CALL order, not by any
    // per-injector prepend/append trick. `IframeFrameSurface.tsx` renders
    // `AuthoredCssInjector` before `ClassStyleInjector` (see its own comment
    // at that call site) specifically to guarantee this ordering — mirror
    // that same order here rather than asserting independence from it.
    const target = document.implementation.createHTMLDocument('iframe')
    const adapter = makeAdapter(target)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <AuthoredCssInjector />
        <ClassStyleInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    const children = [...target.head.children].map((el) => el.getAttribute('data-studio-overlay-id')).filter(Boolean)
    const authoredIndex = children.indexOf('mc-authored')
    const classesIndex = children.indexOf('mc-classes')
    expect(authoredIndex).toBeGreaterThanOrEqual(0)
    expect(classesIndex).toBeGreaterThanOrEqual(0)
    expect(authoredIndex).toBeLessThan(classesIndex)
  })
})
