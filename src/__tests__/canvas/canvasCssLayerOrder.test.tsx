/**
 * WS-2.3 — every injector that participates in the vendor/user-authored
 * cascade split (`ProjectCssInjector`, `ClassStyleInjector`,
 * `UserStylesheetInjector`) must open its stylesheet with the SAME explicit
 * `@layer vendor, user-authored;` pre-declaration (`CANVAS_CSS_LAYER_ORDER`),
 * regardless of which one happens to mount first — see `canvasCssLayers.ts`'s
 * doc for why layer order can't be left to mount-effect timing.
 *
 * This only proves the STRUCTURE (the declaration text is present, and
 * `@layer user-authored` rule bodies are wrapped correctly). Whether a real
 * browser actually resolves that declaration to rank `user-authored` above
 * `vendor` in the computed cascade is NOT something happy-dom can answer —
 * see the Playwright spec for the real assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { UserStylesheetInjector } from '@site/canvas/UserStylesheetInjector'
import { useEditorStore } from '@site/store/store'
import { CANVAS_CSS_LAYER_ORDER, USER_AUTHORED_LAYER } from '@site/canvas/canvasCssLayers'

function resetEditorStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    previewClassStyles: null,
    activeClassId: null,
    selectedNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  document.head.replaceChildren()
  resetEditorStore()
})

afterEach(() => {
  cleanup()
  document.head.replaceChildren()
  resetEditorStore()
})

describe('CANVAS_CSS_LAYER_ORDER pre-declaration', () => {
  it('ClassStyleInjector opens "mc-classes" with it, even with an empty class registry', () => {
    render(<ClassStyleInjector targetDocument={document} />)
    const css = document.getElementById('mc-classes')?.textContent ?? ''
    expect(css.startsWith(CANVAS_CSS_LAYER_ORDER)).toBe(true)
    // Even with zero author classes, the publisher reset still generates
    // content, so this is inside @layer user-authored, not the empty-comment
    // branch (that's exercised implicitly — either way the declaration must
    // lead).
    expect(css).toContain(`@layer ${USER_AUTHORED_LAYER} {`)
  })

  it('UserStylesheetInjector opens "mc-user-styles" with it, even when there are no user stylesheets', () => {
    render(<UserStylesheetInjector targetDocument={document} />)
    const css = document.getElementById('mc-user-styles')?.textContent ?? ''
    expect(css.startsWith(CANVAS_CSS_LAYER_ORDER)).toBe(true)
    expect(css).toContain('/* no user stylesheets */')
  })

  it('wraps real class-registry CSS in @layer user-authored, after the pre-declaration', () => {
    useEditorStore.setState({
      site: {
        pages: [],
        breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1280 }],
        conditions: [],
        styleRules: {
          'btn-1': {
            id: 'btn-1',
            name: 'btn',
            kind: 'class',
            selector: '.btn',
            order: 0,
            styles: { color: 'red' },
            contextStyles: {},
            createdAt: 0,
            updatedAt: 0,
          },
        },
        settings: { framework: {} },
      },
    } as unknown as Parameters<typeof useEditorStore.setState>[0])

    render(<ClassStyleInjector targetDocument={document} />)
    const css = document.getElementById('mc-classes')?.textContent ?? ''
    const declarationIndex = css.indexOf(CANVAS_CSS_LAYER_ORDER)
    const layerOpenIndex = css.indexOf(`@layer ${USER_AUTHORED_LAYER} {`)
    expect(declarationIndex).toBe(0)
    expect(layerOpenIndex).toBeGreaterThan(declarationIndex)
  })
})
