/**
 * TreeRow's three row states — hover, selected, keyboard focus — are three
 * DIFFERENT tones (P2-H, UX-20 / UX-21).
 *
 * Static, because happy-dom neither applies `:hover` nor `:focus-visible`
 * from a stylesheet. The computed half — a real keyboard focus drawing a
 * real ring, a real hovered row painting a different fill from the selected
 * one — is `tests/e2e/inspector-panel-polish.e2e.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(import.meta.dir, '..', 'TreeRow.module.css'), 'utf8')

/** Every rule whose selector list names `selector` exactly. */
function rulesFor(selector: string): string[] {
  const blocks = CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) ?? []
  return blocks.filter((block) =>
    block
      .slice(0, block.indexOf('{'))
      .split(',')
      .map((item) => item.trim())
      .includes(selector),
  )
}

function backgroundOf(selector: string): string | null {
  for (const rule of rulesFor(selector)) {
    const match = /background:\s*([^;]+);/.exec(rule)
    if (match) return match[1].trim()
  }
  return null
}

describe('TreeRow states', () => {
  it('draws a visible ring on keyboard focus, and only on keyboard focus (UX-20)', () => {
    const [focusRule] = rulesFor('.row:focus-visible')
    expect(focusRule).toBeDefined()
    expect(focusRule).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--overlay-50\);/)
    // A mouse click focuses the row as well: a `.rowFocused` class driven by
    // onFocus would ring every clicked row.
    expect(CSS).not.toContain('.rowFocused')
  })

  it('does not declare custom properties no rule reads', () => {
    // `--tree-row-focus` / `--tree-row-accent` were the "focus ring" and
    // "selected accent" — set, and never consumed, so neither drew anything.
    expect(CSS).not.toMatch(/--tree-row-(?:focus|accent)\b/)
  })

  it('paints the selected row a tone the hovered row never reaches (UX-21)', () => {
    const hover = backgroundOf('.row:hover')
    const selected = backgroundOf('.rowSelected')
    expect(hover).toBe('var(--overlay-10)')
    expect(selected).toBe('var(--overlay-20)')
  })

  it('keeps a selected row at its own tone under the pointer', () => {
    // `.row:hover` (0,2,0) out-specifies `.rowSelected` (0,1,0), so without
    // its own `:hover` rule a hovered selected row fell back to the hover tone.
    expect(backgroundOf('.rowSelected:hover')).toBe(backgroundOf('.rowSelected'))
  })
})
