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
 * the geometry a height is computed FROM — every `--inspector-*` token is a
 * literal px value, no `clamp()`, no `vw`. A panel whose gutters grow with
 * the viewport has no height to budget in the first place.
 *
 * ── P3 completion note (`STATE.md` `panel-25`, item 11 — Studio extras) ──
 * This file used to ALSO budget the row count `StyleSectionsEditor`/
 * `classStyleSections.ts`'s legacy registry could draw (a "caption budget"
 * per section, and a whole-panel caption count rendered through
 * `StyleSectionsEditor` directly). Both are gone: `StyleSectionsEditor.tsx`
 * is deleted and `CLASS_STYLE_SECTIONS` is permanently `[]` (P3 is complete
 * — every CSS category now renders through its own `INSPECTOR_SECTIONS`
 * manifest entry, each with its own geometry, not a shared registry this
 * file can budget in one place). The token-freeze half below is untouched —
 * it is about the underlying `--inspector-*` scale, not the deleted
 * registry — and `getPropertyFieldGlyph`'s own glyph-table coverage stays,
 * since it is a fact about `cssPropertyIcons.ts` any section's rows still
 * read from, curated-registry or not.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPropertyFieldGlyph } from '../cssPropertyIcons'

const SRC_ROOT = join(import.meta.dir, '../../../../../..')
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles/globals.css'), 'utf8')

/**
 * Every inspector token that participates in a height, and the px value it is
 * frozen at. Read as a table: this IS the panel's vertical grid.
 */
const FROZEN_INSPECTOR_TOKENS: ReadonlyArray<readonly [string, string]> = [
  // Corrected to Penpot's measured values (`STATE.md` `panel-25`, Step 0 —
  // `docs/audits/penpot-inspector-baseline/04-token-gaps.md`).
  ['--inspector-row-h', '32px'],
  ['--inspector-header-h', '32px'],
  ['--inspector-pad-x', '12px'],
  ['--inspector-field-gap', '6px'],
  ['--inspector-group-gap', '8px'],
  ['--inspector-caption-gap', '3px'],
  ['--inspector-label-w', '68px'],
  ['--inspector-rail-w', '32px'],
  ['--inspector-field-radius', '8px'],
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
})

describe('glyph table', () => {
  /**
   * The glyph table is what lets a property's row shed its caption in favour
   * of an in-field mark. Regressing an entry back to a bare caption is real
   * drift, so the properties that earned a mark are named here.
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
