/**
 * AlmDesignSystemCssInjector — injects @alm-design/design-system's stylesheet
 * (tokens + component CSS) into a canvas iframe's <head>, so design-system
 * component modules (see `src/modules/alm/`) render styled inside the canvas
 * exactly as they do in the app.
 *
 * Mirrors `UserStylesheetInjector`'s per-iframe injection pattern. The CSS is
 * imported once as a string via Vite's `?inline`.
 *
 * IMPORTANT — injected UNLAYERED (not inside an `@layer`): Instatic's CSS reset
 * lives in `@layer user-authored`, and cascade layers trump specificity, so a
 * layered design-system rule would LOSE to the reset's element selectors
 * (`button {…}`), leaving components unstyled. Unlayered, the design system's
 * class rules (`.btn--primary`) beat the element reset by normal specificity,
 * and unlayered always beats layered. Author-class overrides are a later
 * concern (they'd need their own precedence handling then).
 */
import { useEffect } from 'react'
// Vite `?inline` yields the processed CSS as a default string export.
import dsCss from '@alm-design/design-system/dist/index.css?inline'

const STYLE_TAG_ID = 'alm-design-system-css'

export function AlmDesignSystemCssInjector({ targetDocument }: { targetDocument?: Document } = {}) {
  useEffect(() => {
    const doc = targetDocument ?? document
    let styleEl = doc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = doc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'AlmDesignSystemCssInjector')
      // Prepend so `@layer design-system` is declared first (lowest priority).
      doc.head.insertBefore(styleEl, doc.head.firstChild)
    }
    styleEl.textContent = dsCss as string

    // The design system's tokens default to DARK (`:root:not([data-theme=light])`).
    // The canvas page surface is light, so opt the iframe root into the light
    // token set explicitly; otherwise every component renders dark-mode colors
    // on a white canvas. (Theme toggling can be wired to a canvas control later.)
    if (!doc.documentElement.getAttribute('data-theme')) {
      doc.documentElement.setAttribute('data-theme', 'light')
    }

    return () => {
      doc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
