/**
 * Regression guard: the editor-chrome injector must NOT overwrite the site's
 * own Framework tokens on the iframe `:root`.
 *
 * The injector is unlayered, so anything it sets on `:root` beats the site's
 * Framework tokens (which live in `@layer user-authored`). It used to copy
 * admin tokens straight onto the iframe root, silently rendering canvas
 * content with editor token values instead of the site's configured ones.
 * Editor chrome must ride chrome-namespaced variables instead.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import { EditorChromeInjector } from '@site/canvas/EditorChromeInjector'
import { CanvasFrameAdapterContext } from '@site/canvas/CanvasContexts'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'

let adapter: PortalFrameAdapter | null = null

const ADMIN_TOKEN_PROPS = ['--font-sans', '--text-xs', '--text-s', '--space-s', '--space-xl']

afterEach(() => {
  cleanup()
  adapter?.dispose()
  adapter = null
  for (const prop of ADMIN_TOKEN_PROPS) document.documentElement.style.removeProperty(prop)
})

/**
 * `EditorChromeInjector` always reads the ADMIN's own top-level `document`
 * (never a `parentDocument` prop — see that component's own doc) for its
 * token forwarding, so this sets the tokens directly on the real global
 * `document.documentElement` rather than a detached stand-in.
 */
function setAdminTokens(): void {
  document.documentElement.style.setProperty('--font-sans', '"Inter Variable", system-ui, sans-serif')
  document.documentElement.style.setProperty('--text-xs', 'clamp(10px, calc(9.629px + 0.095vw), 11px)')
  document.documentElement.style.setProperty('--text-s', 'clamp(11px, calc(10.629px + 0.095vw), 12px)')
  document.documentElement.style.setProperty('--space-s', 'clamp(6px, calc(5.257px + 0.19vw), 8px)')
  document.documentElement.style.setProperty('--space-xl', 'clamp(12px, calc(11.257px + 0.19vw), 14px)')
}

describe('EditorChromeInjector font isolation', () => {
  it('forwards editor chrome tokens under chrome-namespaced variables, never site Framework tokens', () => {
    setAdminTokens()
    const target = document.implementation.createHTMLDocument('iframe')
    adapter = new PortalFrameAdapter(target)
    render(
      <CanvasFrameAdapterContext.Provider value={adapter}>
        <EditorChromeInjector />
      </CanvasFrameAdapterContext.Provider>,
    )

    const css = target.querySelector('[data-studio-overlay-id="studio-editor-chrome"]')?.textContent ?? ''
    expect(css).not.toBe('')

    // The chrome font is exposed as a namespaced var carrying the editor font…
    expect(css).toContain('--chrome-font-sans: "Inter Variable", system-ui, sans-serif;')
    // …and chrome rules reference it.
    expect(css).toContain('font-family: var(--chrome-font-sans);')
    expect(css).toContain('--chrome-text-xs: clamp(10px, calc(9.629px + 0.095vw), 11px);')
    expect(css).toContain('--chrome-text-s: clamp(11px, calc(10.629px + 0.095vw), 12px);')
    expect(css).toContain('font-size: var(--chrome-text-s);')
    expect(css).toContain('font-size: var(--chrome-text-xs);')
    expect(css).toContain('--chrome-space-s: clamp(6px, calc(5.257px + 0.19vw), 8px);')
    expect(css).toContain('--chrome-space-xl: clamp(12px, calc(11.257px + 0.19vw), 14px);')
    expect(css).toContain('gap: var(--chrome-space-s);')
    expect(css).toContain('padding: var(--chrome-space-xl);')

    // It must NEVER set the site's own Framework tokens on :root, nor
    // reference them — doing so clobbers token values for all canvas content.
    expect(css).not.toMatch(/^\s*--font-sans:/m)
    expect(css).not.toContain('var(--font-sans)')
    expect(css).not.toMatch(/^\s*--text-s:/m)
    expect(css).not.toMatch(/^\s*--text-xs:/m)
    expect(css).not.toContain('var(--text-s)')
    expect(css).not.toContain('var(--text-xs)')
    expect(css).not.toMatch(/^\s*--space-s:/m)
    expect(css).not.toMatch(/^\s*--space-xl:/m)
    expect(css).not.toContain('var(--space-s)')
    expect(css).not.toContain('var(--space-xl)')
  })
})
