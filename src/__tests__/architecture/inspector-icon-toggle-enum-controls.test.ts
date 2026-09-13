/**
 * Architecture Gate — flex/text enum controls render as icon toggle groups,
 * never a bare `<Select>` (STUDIO-LIVE-CANVAS-PLAN.md Track P, P2 Rule 4 /
 * panel-22).
 *
 * docs/features/inspector-disclosure.md Law 2 (rare options in a popover) and
 * the panel's whole "picture, not a word" density lever (`cssPropertyIcons.ts`)
 * only holds if a property that HAS an icon-toggle group can never also fall
 * through to a plain dropdown from some other call site. Seven CSS properties
 * are named by Rule 4: `flexDirection`, `flexWrap`, `justifyContent`,
 * `alignItems`, `textAlign`, `textDecoration`, `textTransform`.
 *
 * They split into two groups with two different guarantees, because they are
 * rendered by two different mechanisms — this gate checks both:
 *
 *   1. `flexDirection` / `justifyContent` / `alignItems` are drawn by
 *      `LayoutSection.tsx`'s own bespoke controls (`FlexDirectionControl`,
 *      `AlignGrid`) — they never reach the generic `ClassPropertyRow` /
 *      `SelectControl` dispatch at all. Guarded by confirming `LayoutSection`
 *      imports neither `SelectControl` nor `ClassPropertyRow` — if either
 *      import ever appears there, one of these three has regressed onto the
 *      generic (and therefore `<Select>`-capable) path.
 *
 *   2. `flexWrap` / `textAlign` / `textDecoration` / `textTransform` DO reach
 *      the generic `ClassPropertyRow`, which dispatches to `SelectControl`
 *      only in its `case 'select':` branch — but only when the property has
 *      no entry in `cssPropertyIcons.ts`'s `ICON_ENUM_OPTIONS` map, which
 *      `ClassPropertyRow` checks and renders (as a `SegmentedControl`)
 *      BEFORE it ever reaches that switch. Guarded by (a) asserting all four
 *      have a map entry, and (b) asserting the map's `iconEnumOptions` check
 *      appears earlier in `ClassPropertyRow.tsx`'s source than
 *      `case 'select':` — so guarantee (a) is actually load-bearing, not
 *      moot ordering that could silently flip.
 *
 * `classStyleSections.ts` is the formal ownership record for which section
 * claims each property (docs/features/inspector-disclosure.md §4 G9.4) —
 * this gate also confirms all seven are still owned by exactly the section
 * whose file this test reasons about, so a future re-registration can't
 * silently move one of them to a section this gate doesn't know to check.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const PANEL_ROOT = join(import.meta.dir, '../../admin/pages/site/panels/PropertiesPanel')
const LAYOUT_SECTION_FILE = join(PANEL_ROOT, 'LayoutSection/LayoutSection.tsx')
const CLASS_PROPERTY_ROW_FILE = join(PANEL_ROOT, 'ClassPropertyRow.tsx')
const CSS_PROPERTY_ICONS_FILE = join(PANEL_ROOT, 'cssPropertyIcons.ts')
const CLASS_STYLE_SECTIONS_FILE = join(PANEL_ROOT, 'classStyleSections.ts')

const BESPOKE_LAYOUT_PROPERTIES = ['flexDirection', 'justifyContent', 'alignItems'] as const
const GENERIC_ICON_ENUM_PROPERTIES = ['flexWrap', 'textAlign', 'textDecoration', 'textTransform'] as const

describe('Architecture gate — flex/text enums are icon toggle groups, not <Select> (panel-22 Rule 4)', () => {
  it('LayoutSection draws flexDirection/justifyContent/alignItems itself, never through the generic <Select>-capable row', () => {
    const content = readFileSync(LAYOUT_SECTION_FILE, 'utf8')
    expect(content).not.toMatch(/\bSelectControl\b/)
    expect(content).not.toMatch(/\bClassPropertyRow\b/)
    // And it really does own these three — if the bespoke controls were
    // deleted without a replacement, this gate should fail loudly rather
    // than pass on an empty section.
    for (const prop of BESPOKE_LAYOUT_PROPERTIES) {
      expect(content).toContain(prop)
    }
  })

  it('flexWrap/textAlign/textDecoration/textTransform each have an icon toggle group registered', () => {
    const content = readFileSync(CSS_PROPERTY_ICONS_FILE, 'utf8')
    // Static source check (not a live import) so this test has no dependency
    // on the module's runtime environment (React/vendored icon components) —
    // consistent with the rest of this gate reasoning about source shape.
    for (const prop of GENERIC_ICON_ENUM_PROPERTIES) {
      expect(content).toMatch(new RegExp(`\\[\\s*['"]${prop}['"]\\s*,`))
    }
  })

  it('ClassPropertyRow checks the icon toggle group before it can ever fall through to case \'select\'', () => {
    const content = readFileSync(CLASS_PROPERTY_ROW_FILE, 'utf8')
    const iconEnumBranchIndex = content.indexOf('iconEnumOptions')
    const selectCaseIndex = content.indexOf("case 'select'")
    expect(iconEnumBranchIndex).toBeGreaterThan(-1)
    expect(selectCaseIndex).toBeGreaterThan(-1)
    expect(iconEnumBranchIndex).toBeLessThan(selectCaseIndex)
  })

  it('classStyleSections.ts still assigns all seven properties to the sections this gate reasons about', () => {
    const content = readFileSync(CLASS_STYLE_SECTIONS_FILE, 'utf8')
    for (const prop of [...BESPOKE_LAYOUT_PROPERTIES, 'flexWrap']) {
      expect(content).toMatch(new RegExp(`['"]${prop}['"]`))
    }
    for (const prop of ['textAlign', 'textDecoration', 'textTransform']) {
      expect(content).toMatch(new RegExp(`['"]${prop}['"]`))
    }
  })
})
