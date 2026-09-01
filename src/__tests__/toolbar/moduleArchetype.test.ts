/**
 * moduleArchetype — the wireframe derived for a module with no hand-drawn
 * entry in `MODULE_WIRES`.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * `MODULE_WIRES` covers 25 `base.*` ids. Every other module fell through to
 * `base.container` — an empty dashed box. On a real design-system project that
 * is 44 of the 46 modules in the picker, so Accolade, Badge, BottomActionBar
 * and Button all drew the SAME rectangle and the thumbnail said nothing the
 * name underneath had not already said. Measured in a browser before and after:
 * 1 distinct shape across 46 cards, then 22 with zero empties.
 *
 * What is gated here is the PRECEDENCE, because that is what silently rots:
 * every rule is a name regex, and a rule added in the wrong position steals
 * matches from a more specific one that used to work.
 */
import { describe, expect, it } from 'bun:test'
import { archetypeWire } from '@site/module-picker/moduleArchetype'
import type { WireNode } from '@site/module-picker/wireNode'

/** Structural fingerprint — what the picker actually renders, ignoring identity. */
function shape(node: WireNode): string {
  const flags = (['dashed', 'solid', 'card', 'big', 'bar', 'caret', 'avatar', 'play', 'logo', 'message', 'tip'] as const)
    .filter((flag) => node[flag])
    .join('+')
  const head = flags ? `${node.kind}[${flags}]` : node.kind
  const kids = node.children?.length ? `(${node.children.map(shape).join(',')})` : ''
  return head + kids
}

const wire = (name: string, schema?: Record<string, { type: string }>) => archetypeWire({ name, schema })

describe('archetypeWire', () => {
  it('never returns an empty container for anything', () => {
    // The whole defect: a component with no name match and no props still has
    // to be a picture of something.
    for (const name of ['Accolade', 'Zzz', 'SomeVendorWidget', '']) {
      const result = wire(name)
      expect(shape(result)).not.toBe('box')
      expect(result.kind).toBeDefined()
    }
  })

  it('matches an *Icon export as a glyph BEFORE the word in front of it', () => {
    // The measured regression: `CheckboxCheckedIcon` matched `/checkbox/` and
    // drew a two-row checkbox list, `RadioButtonIcon` drew a radio group —
    // three identical thumbnails each, for things that render as one glyph.
    const glyph = shape(wire('ChevronDownIcon'))
    expect(shape(wire('CheckboxCheckedIcon'))).toBe(glyph)
    expect(shape(wire('RadioButtonSelectedIcon'))).toBe(glyph)
    // …while the real controls keep their own distinct shapes.
    expect(shape(wire('Checkbox'))).not.toBe(glyph)
    expect(shape(wire('Radio'))).not.toBe(glyph)
    expect(shape(wire('Checkbox'))).not.toBe(shape(wire('Radio')))
  })

  it('separates a slider from a progress bar', () => {
    // Both are "a bar", but only one has a knob to drag.
    expect(shape(wire('Slider'))).not.toBe(shape(wire('LinearProgressIndicator')))
  })

  it('treats an AdBanner as a card, not a text status strip', () => {
    // `/banner/` used to win before the card rule it is explicitly named in.
    expect(shape(wire('AdBanner'))).toBe(shape(wire('VisualCard')))
    expect(shape(wire('AdBanner'))).not.toBe(shape(wire('Banner')))
  })

  it('keeps the specific bar rules ahead of the generic ones', () => {
    expect(shape(wire('BottomActionBar'))).not.toBe(shape(wire('Navbar')))
    expect(shape(wire('TextInput'))).not.toBe(shape(wire('Button')))
  })

  it('matches on the component name, so any design system benefits', () => {
    // Nothing here is keyed to a package id — an imported `Badge` from any
    // vendor gets the same treatment as `@alm-design`'s.
    expect(shape(wire('Badge'))).toBe(shape(wire('Tag')))
    expect(shape(wire('Badge'))).not.toBe(shape(wire('Accordion')))
  })

  describe('prop-shape sketch, when no name rule matches', () => {
    it('draws different shapes for different prop APIs', () => {
      const imageish = wire('Zzz', { hero: { type: 'image' }, caption: { type: 'text' } })
      const toggleish = wire('Qqq', { enabled: { type: 'toggle' }, mode: { type: 'select' } })
      expect(shape(imageish)).not.toBe(shape(toggleish))
    })

    it('reads a title-ish text prop as a heading and other text as body', () => {
      expect(shape(wire('Zzz', { title: { type: 'text' } }))).toContain('big')
      expect(shape(wire('Zzz', { blurb: { type: 'text' } }))).not.toContain('big')
    })

    it('ignores controls that describe no visible content', () => {
      // An identifier or a group heading is not something to draw.
      expect(shape(wire('Zzz', { htmlId: { type: 'identifier' } }))).toBe(shape(wire('Zzz')))
    })

    it('caps how many prop rows a thumbnail carries', () => {
      const many = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`p${i}`, { type: 'text' as const }]),
      )
      expect(wire('Zzz', many).children?.length).toBeLessThanOrEqual(4)
    })

    it('falls back to a glyph when every prop is undrawable', () => {
      expect(shape(wire('Zzz', { a: { type: 'identifier' } }))).toBe(shape(wire('Zzz')))
    })
  })
})
