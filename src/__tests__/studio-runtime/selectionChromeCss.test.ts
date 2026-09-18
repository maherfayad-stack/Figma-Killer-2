import { describe, expect, it } from 'bun:test'
import {
  SELECTION_CHROME_RULES,
  SELECTION_CHROME_TOKENS,
  buildSelectionChromeStylesheet,
  buildSelectionChromeTokenBlock,
} from '@core/studio-runtime'

describe('SELECTION_CHROME_RULES', () => {
  it('keys ring/badge appearance off the stable data-* hooks', () => {
    expect(SELECTION_CHROME_RULES).toContain('[data-canvas-selection-ring]')
    expect(SELECTION_CHROME_RULES).toContain('[data-canvas-hover-ring]')
    expect(SELECTION_CHROME_RULES).toContain('[data-canvas-node-badge]')
    expect(SELECTION_CHROME_RULES).toContain('[data-canvas-resize-handle]')
  })

  it('never declares a default display:none for the ring/badge — the show path clears an inline override', () => {
    expect(SELECTION_CHROME_RULES).not.toMatch(/\[data-canvas-selection-ring\][^}]*display:\s*none/)
  })
})

describe('buildSelectionChromeTokenBlock', () => {
  it('emits a :root block only for tokens that actually resolve to a value', () => {
    document.documentElement.style.setProperty(SELECTION_CHROME_TOKENS[0], '0 0 0 2px red')
    const block = buildSelectionChromeTokenBlock(document)
    expect(block).toContain(':root {')
    expect(block).toContain(SELECTION_CHROME_TOKENS[0])
    document.documentElement.style.removeProperty(SELECTION_CHROME_TOKENS[0])
  })

  it('returns an empty string when no token resolves', () => {
    for (const token of SELECTION_CHROME_TOKENS) document.documentElement.style.removeProperty(token)
    expect(buildSelectionChromeTokenBlock(document)).toBe('')
  })
})

describe('buildSelectionChromeStylesheet', () => {
  it('combines the token block with the appearance rules when tokens resolve', () => {
    document.documentElement.style.setProperty(SELECTION_CHROME_TOKENS[0], '0 0 0 2px red')
    const css = buildSelectionChromeStylesheet(document)
    expect(css).toContain(':root {')
    expect(css).toContain('[data-canvas-selection-ring]')
    document.documentElement.style.removeProperty(SELECTION_CHROME_TOKENS[0])
  })

  it('falls back to the bare rules when nothing resolves', () => {
    for (const token of SELECTION_CHROME_TOKENS) document.documentElement.style.removeProperty(token)
    expect(buildSelectionChromeStylesheet(document)).toBe(SELECTION_CHROME_RULES)
  })
})
