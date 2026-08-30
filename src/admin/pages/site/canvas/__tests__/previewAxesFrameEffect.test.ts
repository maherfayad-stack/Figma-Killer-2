import { describe, expect, it } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { applyPreviewAxesToFrameDocument, parseClassSchemeSelector, VENDOR_THEME_ATTR } from '../previewAxesFrameEffect'
import { DARK_SCHEME_ATTR } from '../darkSchemeCssTransform'

function freshHtmlElement(): HTMLElement {
  const window = new GlobalWindow()
  return window.document.documentElement as unknown as HTMLElement
}

describe('parseClassSchemeSelector', () => {
  it('parses a class selector', () => {
    expect(parseClassSchemeSelector('.dark')).toEqual({ kind: 'class', name: 'dark' })
  })

  it('parses an attribute selector with a value', () => {
    expect(parseClassSchemeSelector('[data-theme="dark"]')).toEqual({ kind: 'attribute', name: 'data-theme', value: 'dark' })
  })

  it('parses a bare attribute selector with no value', () => {
    expect(parseClassSchemeSelector('[data-dark-mode]')).toEqual({ kind: 'attribute', name: 'data-dark-mode', value: null })
  })

  it('returns null for anything it does not recognize', () => {
    expect(parseClassSchemeSelector('.dark .nested')).toBeNull()
    expect(parseClassSchemeSelector('body.dark')).toBeNull()
  })
})

describe('applyPreviewAxesToFrameDocument', () => {
  it('always sets dir/lang/scheme attributes regardless of capability', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'rtl', colorScheme: 'dark' }, null)
    expect(html.getAttribute('dir')).toBe('rtl')
    expect(html.getAttribute('lang')).toBe('ar')
    expect(html.getAttribute(DARK_SCHEME_ATTR)).toBe('dark')
    expect(html.getAttribute(VENDOR_THEME_ATTR)).toBe('dark')
    expect(html.style.colorScheme).toBe('dark')
  })

  // The vendor stylesheet Studio injects into EVERY frame declares its light
  // tokens under `:root:not([data-theme=light])`, so an unset attribute means
  // DARK. Light must therefore be written, never merely un-written.
  it('writes an explicit light theme rather than removing the attribute', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'light' }, null)
    expect(html.getAttribute(VENDOR_THEME_ATTR)).toBe('light')
    expect(html.getAttribute(DARK_SCHEME_ATTR)).toBe('light')
    expect(html.style.colorScheme).toBe('light')
  })

  it('clears lang on ltr', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'rtl', colorScheme: 'light' }, null)
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'light' }, null)
    expect(html.hasAttribute('lang')).toBe(false)
  })

  it('toggles the project\'s own class-mechanism selector when capability says class', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'dark' }, { mechanism: 'class', selector: '.dark' })
    expect(html.classList.contains('dark')).toBe(true)

    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'light' }, { mechanism: 'class', selector: '.dark' })
    expect(html.classList.contains('dark')).toBe(false)
  })

  it('toggles an attribute-mechanism selector', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(
      html,
      { direction: 'ltr', colorScheme: 'dark' },
      { mechanism: 'class', selector: '[data-theme="dark"]' },
    )
    expect(html.getAttribute('data-theme')).toBe('dark')

    applyPreviewAxesToFrameDocument(
      html,
      { direction: 'ltr', colorScheme: 'light' },
      { mechanism: 'class', selector: '[data-theme="dark"]' },
    )
    expect(html.getAttribute('data-theme')).toBe('light')
  })

  // A `.dark` class gate has no light counterpart to add, so the class comes
  // off — but the generic vendor attribute is still written in both schemes.
  it('leaves a class-mechanism project on an explicit vendor theme attribute too', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'light' }, { mechanism: 'class', selector: '.dark' })
    expect(html.classList.contains('dark')).toBe(false)
    expect(html.getAttribute(VENDOR_THEME_ATTR)).toBe('light')
  })

  it('does nothing extra for a media-mechanism or none-mechanism capability', () => {
    const html = freshHtmlElement()
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'dark' }, { mechanism: 'media' })
    expect(html.classList.length).toBe(0)
    expect(html.attributes.length).toBeGreaterThan(0) // dir/scheme still set
    applyPreviewAxesToFrameDocument(html, { direction: 'ltr', colorScheme: 'dark' }, { mechanism: 'none' })
    expect(html.classList.length).toBe(0)
  })
})
