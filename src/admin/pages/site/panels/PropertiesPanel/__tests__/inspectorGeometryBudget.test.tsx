/**
 * Inspector geometry budget — the gate that keeps the panel a fixed grid.
 *
 * ── The substitution, stated up front ────────────────────────────────────
 * The work order for this gate asked for a real measurement:
 * `scrollHeight <= clientHeight` for a text node's panel at a 900px viewport.
 * That is not available here. This suite runs on happy-dom, which builds a
 * DOM but does NOT lay it out — a probe of a 100px box containing a 500px
 * child reports `clientHeight 0, scrollHeight 0`, so the assertion would pass
 * for every possible panel including an empty one. Worse, CSS Modules resolve
 * to `""` under `bun test`, so even class-based structural queries are blind.
 *
 * So this is the named substitute the work order allows: a STATIC budget on
 * the two inputs a height is computed FROM.
 *
 *   1. The geometry is frozen. Every `--inspector-*` token is a literal px
 *      value — no `clamp()`, no `vw`. A panel whose gutters grow with the
 *      viewport has no height to budget in the first place, which is why
 *      this half comes first.
 *   2. The row count is budgeted. A caption above a field is the panel's
 *      most expensive row form (~19px of pure label), so the number of them
 *      a resident panel draws is capped, and the number of properties in
 *      each section that COULD draw one is capped per section.
 *
 * Together those two facts are what a height would have been derived from.
 * When a real layout engine is available in CI, the honest upgrade is to keep
 * part 1 and replace part 2 with the measurement.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { CLASS_STYLE_SECTIONS } from '../classStyleSections'
import {
  getIconEnumOptions,
  getPropertyFieldGlyph,
  isSelfDescribingProperty,
} from '../cssPropertyIcons'
import { StyleSectionsEditor } from '../StyleSectionsEditor'

/** Multi-property write channel — see `StyleSectionsEditor`'s `onChangeMany`. */
function noopMany() {}

const SRC_ROOT = join(import.meta.dir, '../../../../../..')
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles/globals.css'), 'utf8')

afterEach(cleanup)

function noop() {}

/**
 * Every inspector token that participates in a height, and the px value it is
 * frozen at. Read as a table: this IS the panel's vertical grid.
 */
const FROZEN_INSPECTOR_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--inspector-row-h', '24px'],
  ['--inspector-header-h', '32px'],
  ['--inspector-pad-x', '8px'],
  ['--inspector-field-gap', '6px'],
  ['--inspector-group-gap', '8px'],
  ['--inspector-caption-gap', '3px'],
  ['--inspector-label-w', '68px'],
  ['--inspector-rail-w', '32px'],
  ['--inspector-field-radius', '5px'],
  ['--inspector-space-4xs', '2px'],
  ['--inspector-space-3xs', '3px'],
  ['--inspector-space-2xs', '4px'],
  ['--inspector-space-xs', '5px'],
  ['--inspector-space-s', '6px'],
  ['--inspector-space-m', '8px'],
  ['--inspector-space-l', '10px'],
  ['--inspector-space-xl', '12px'],
]

describe('inspector geometry is frozen', () => {
  it('declares every inspector token as a literal px value', () => {
    for (const [token, value] of FROZEN_INSPECTOR_TOKENS) {
      expect(GLOBALS_CSS).toContain(`${token}: ${value};`)
    }
  })

  it('no inspector token is fluid — no clamp(), no vw', () => {
    const offenders: string[] = []
    for (const line of GLOBALS_CSS.split('\n')) {
      const declaration = line.trim()
      if (!declaration.startsWith('--inspector-')) continue
      if (/clamp\(|\dvw|\dvh/.test(declaration)) offenders.push(declaration)
    }
    expect(offenders).toEqual([])
  })

  /**
   * The other half of the freeze: the panel's own CSS must not reach back
   * into the admin's fluid `--space-*` scale for the small steps. One
   * `var(--space-xs)` in a section is ~1px of drift per gutter per viewport
   * step, which is invisible in review and compounds over nine sections.
   */
  it('inspector CSS modules use the frozen scale, not the fluid --space-* one', () => {
    const FLUID_SMALL_STEPS = ['4xs', '3xs', '2xs', 'xs', 's', 'm', 'l', 'xl']
    const offenders: string[] = []
    const roots = [
      join(SRC_ROOT, 'admin/pages/site/panels/PropertiesPanel'),
      join(SRC_ROOT, 'admin/pages/site/property-controls'),
      join(SRC_ROOT, 'ui/components/Section'),
    ]
    for (const root of roots) {
      for (const file of new Bun.Glob('**/*.module.css').scanSync({ cwd: root })) {
        const source = readFileSync(join(root, file), 'utf8')
        for (const step of FLUID_SMALL_STEPS) {
          if (source.includes(`var(--space-${step})`)) {
            offenders.push(`${file} -> var(--space-${step})`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * Header chrome is the one part of the panel's height that IS exactly
   * computable without a layout engine: every section header is one
   * `--inspector-header-h` row, and there is one per section. Freezing the
   * section count freezes that whole term.
   */
  it('header chrome costs exactly one --inspector-header-h per section', () => {
    expect(GLOBALS_CSS).toContain('--inspector-header-h: 32px;')
    expect(CLASS_STYLE_SECTIONS.length).toBeLessThanOrEqual(11)
    const headerChromePx = CLASS_STYLE_SECTIONS.length * 32
    expect(headerChromePx).toBeLessThanOrEqual(352)
  })
})

describe('caption budget — the panel\'s most expensive row form', () => {
  /**
   * What a resident panel actually draws. A caption row is the only thing in
   * this tree that renders a `<label>`: `ControlRow` emits one for `inline`,
   * `stacked` and `caption` layouts and NOTHING for `bare`, which is what a
   * property earns by having an icon-enum group, an in-field glyph, or a
   * self-describing value. `<label>` count is therefore an exact, layout-free
   * count of caption rows — the one honest measurement happy-dom can give.
   */
  it('a text node\'s resident panel draws at most two caption rows', () => {
    render(
      <StyleSectionsEditor
        storedStyles={{ fontSize: '16px', color: '#ffffff' }}
        currentStyles={{ fontSize: '16px', color: '#ffffff' }}
        sectionKey="base"
        styleQuery=""
        onChange={noop}
        onChangeMany={noopMany}
        onRemove={noop}
        onClearProperty={noop}
        onClearProperties={noop}
        onPreview={noop}
        onClearPreview={noop}
      />,
    )

    // Today: exactly one ("Clip content", in Size). The budget is 2 so a
    // deliberate addition is possible; anything more is the caption-above-
    // field form creeping back in as the panel's default, which is what this
    // whole work order removed.
    expect(document.querySelectorAll('label').length).toBeLessThanOrEqual(2)
  })

  /**
   * Per-section budgets for the properties that would draw a caption if the
   * generic row drew them — the ceiling a section may not silently cross when
   * someone adds a property to `classStyleSections`. Numbers are today's
   * counts; raising one is a design decision that belongs in a diff, not a
   * side effect.
   */
  const CAPTION_CAPABLE_BUDGET: Readonly<Record<string, number>> = {
    position: 7,
    size: 6,
    layout: 20,
    spacing: 4,
    appearance: 6,
    fill: 11,
    border: 22,
    effects: 6,
    animations: 10,
    typography: 9,
    interaction: 4,
  }

  it('every section stays inside its caption-capable budget', () => {
    const over: string[] = []
    for (const section of CLASS_STYLE_SECTIONS) {
      const budget = CAPTION_CAPABLE_BUDGET[section.id]
      expect(budget).toBeDefined()
      const captionCapable = section.properties.filter(
        (prop) =>
          !getIconEnumOptions(prop) &&
          !getPropertyFieldGlyph(prop) &&
          !isSelfDescribingProperty(prop),
      ).length
      if (captionCapable > (budget ?? 0)) {
        over.push(`${section.id}: ${captionCapable} > ${budget}`)
      }
    }
    expect(over).toEqual([])
  })

  /**
   * The glyph table is what buys the budget above. Regressing an entry back
   * to a caption is exactly the drift this gate exists to catch, so the
   * properties that earned a mark are named here.
   */
  it('keeps the in-field glyphs that replaced captions', () => {
    for (const prop of [
      'fontSize',
      'lineHeight',
      'letterSpacing',
      'aspectRatio',
      'opacity',
      'zIndex',
      'gap',
      'rowGap',
      'columnGap',
      'borderWidth',
      'borderRadius',
    ] as const) {
      expect(getPropertyFieldGlyph(prop)).toBeDefined()
    }
  })
})

describe('panel width', () => {
  it('defaults to 290 — Figma\'s 240 plus the rail and a scrollbar gutter', () => {
    const uiSlice = readFileSync(
      join(SRC_ROOT, 'admin/pages/site/store/slices/uiSlice.ts'),
      'utf8',
    )
    expect(uiSlice).toContain('const PROPERTIES_PANEL_DEFAULT_WIDTH = 290')
  })
})

describe('primitives carry the inspector skin', () => {
  it('Button squares its xs/sm icon buttons onto the 24px row', () => {
    const css = readFileSync(join(SRC_ROOT, 'ui/components/Button/Button.module.css'), 'utf8')
    expect(css).toContain("[data-field-skin='inspector'] .size-xs.iconOnly")
    expect(css).toContain('width: var(--inspector-row-h)')
    expect(css).toContain('border-radius: var(--inspector-field-radius)')
  })

  it('Select matches Input\'s inspector type size', () => {
    const css = readFileSync(join(SRC_ROOT, 'ui/components/Select/Select.module.css'), 'utf8')
    const skinBlock = css.slice(css.indexOf("[data-field-skin='inspector'] .select {"))
    expect(skinBlock.slice(0, skinBlock.indexOf('}'))).toContain('font-size: var(--text-xs)')
  })
})
