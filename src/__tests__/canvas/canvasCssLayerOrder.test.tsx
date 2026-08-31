/**
 * WS-2.3 — every injector that participates in the reset/vendor/user-authored
 * cascade split (`ProjectCssInjector`, `ClassStyleInjector`,
 * `UserStylesheetInjector`) must open its stylesheet with the SAME explicit
 * `@layer reset, vendor, user-authored;` pre-declaration
 * (`CANVAS_CSS_LAYER_ORDER`), regardless of which one happens to mount first —
 * see `canvasCssLayers.ts`'s doc for why layer order can't be left to
 * mount-effect timing.
 *
 * The reset's own layer is the regression gate here. `PUBLISHER_RESET_CSS` used
 * to be bundled into `@layer user-authored`, one layer ABOVE vendor package
 * CSS, where its zero-specificity `:where()` rules beat every design-system
 * component style — buttons rendered as unstyled text. It now sits in the
 * LOWEST layer, so it loses to vendor CSS as well as to the user's own rules.
 *
 * This only proves the STRUCTURE (the declaration text is present, the reset is
 * inside `@layer reset`, and author rule bodies are wrapped in
 * `@layer user-authored`). Whether a real browser actually resolves that
 * declaration to the intended computed cascade is NOT something happy-dom can
 * answer — see the Playwright spec for the real assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { UserStylesheetInjector } from '@site/canvas/UserStylesheetInjector'
import { useEditorStore } from '@site/store/store'
import {
  CANVAS_CSS_LAYER_ORDER,
  RESET_LAYER,
  USER_AUTHORED_LAYER,
  VENDOR_LAYER,
} from '@site/canvas/canvasCssLayers'

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
    // With zero author classes there is no `@layer user-authored` block at all
    // — but the reset is unconditional, and it is in its own layer.
    expect(css).toContain(`@layer ${RESET_LAYER} {`)
    expect(css).toContain(':where(*) { margin: 0; padding: 0; }')
    expect(css).toContain('/* no classes */')
  })

  it('puts the publisher reset in @layer reset, NOT in @layer user-authored', () => {
    // The regression this file exists for: a zero-specificity reset emitted
    // above `@layer vendor` beats every design-system component rule, because
    // layer order outranks specificity. The reset's rules must be inside the
    // `reset` block, and `reset` must be declared before `vendor`.
    render(<ClassStyleInjector targetDocument={document} />)
    const css = document.getElementById('mc-classes')?.textContent ?? ''

    const resetOpen = css.indexOf(`@layer ${RESET_LAYER} {`)
    const resetRule = css.indexOf(':where(*) { margin: 0; padding: 0; }')
    const resetClose = css.indexOf('\n}', resetRule)
    expect(resetOpen).toBeGreaterThanOrEqual(0)
    expect(resetRule).toBeGreaterThan(resetOpen)
    expect(resetClose).toBeGreaterThan(resetRule)

    const userAuthoredOpen = css.indexOf(`@layer ${USER_AUTHORED_LAYER} {`)
    if (userAuthoredOpen >= 0) expect(userAuthoredOpen).toBeGreaterThan(resetClose)

    expect(CANVAS_CSS_LAYER_ORDER.indexOf(RESET_LAYER)).toBeLessThan(
      CANVAS_CSS_LAYER_ORDER.indexOf(VENDOR_LAYER),
    )
    expect(CANVAS_CSS_LAYER_ORDER.indexOf(VENDOR_LAYER)).toBeLessThan(
      CANVAS_CSS_LAYER_ORDER.indexOf(USER_AUTHORED_LAYER),
    )
  })

  it('UserStylesheetInjector opens "mc-user-styles" with it, even when there are no user stylesheets', () => {
    render(<UserStylesheetInjector targetDocument={document} />)
    const css = document.getElementById('mc-user-styles')?.textContent ?? ''
    expect(css.startsWith(CANVAS_CSS_LAYER_ORDER)).toBe(true)
    expect(css).toContain('/* no user stylesheets */')
  })

  describe('publisher reset is CMS-only', () => {
    const originalSearch = window.location.search

    afterEach(() => {
      window.history.replaceState(null, '', `${window.location.pathname}${originalSearch}`)
      window.localStorage.removeItem('studio:studio')
    })

    it('omits the reset block entirely in Studio mode (URL param)', () => {
      window.history.replaceState(null, '', `${window.location.pathname}?studio=1`)
      render(<ClassStyleInjector targetDocument={document} />)
      const css = document.getElementById('mc-classes')?.textContent ?? ''
      // Layer order stays pinned even with no rules in the reset layer.
      expect(css.startsWith(CANVAS_CSS_LAYER_ORDER)).toBe(true)
      expect(css).not.toContain(`@layer ${RESET_LAYER} {`)
      expect(css).not.toContain(':where(*) { margin: 0; padding: 0; }')
    })

    it('omits the reset block entirely in Studio mode (sticky localStorage)', () => {
      window.history.replaceState(null, '', window.location.pathname)
      window.localStorage.setItem('studio:studio', '1')
      render(<ClassStyleInjector targetDocument={document} />)
      const css = document.getElementById('mc-classes')?.textContent ?? ''
      expect(css).not.toContain(`@layer ${RESET_LAYER} {`)
    })

    it('still emits the reset block outside Studio mode', () => {
      window.history.replaceState(null, '', `${window.location.pathname}?studio=0`)
      render(<ClassStyleInjector targetDocument={document} />)
      const css = document.getElementById('mc-classes')?.textContent ?? ''
      expect(css).toContain(`@layer ${RESET_LAYER} {`)
      expect(css).toContain(':where(*) { margin: 0; padding: 0; }')
    })
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
