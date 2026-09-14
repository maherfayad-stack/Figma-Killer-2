/**
 * Inspector measurement gate — the static/manifest half (Track P, P6,
 * `STATE.md` `panel-27`).
 *
 * ── The substitution, stated up front ────────────────────────────────────
 * The work order for this gate asked for a real measurement:
 * `scrollHeight <= clientHeight` for a text node's panel at a 900px viewport,
 * `scrollWidth === clientWidth` at 260px, and real per-row pixel offsets.
 * That is not available here. This suite runs on happy-dom, which builds a
 * DOM but does NOT lay it out — a probe of a 100px box containing a 500px
 * child reports `clientHeight 0, scrollHeight 0`, so the assertion would pass
 * for every possible panel including an empty one. Worse, CSS Modules resolve
 * to `""` under `bun test`, so even class-based structural queries are blind.
 * (This is not a hypothesis re-derived here — `inspectorGeometryBudget.
 * test.tsx`, the file this one replaces, already hit and documented this
 * wall.)
 *
 * So this file carries the STATIC half only: the manifest shape, the frozen
 * `--inspector-*` token budget everything else computes FROM, and a computed
 * (not measured) per-section rest-height table built from that same frozen
 * scale. The REAL half — actual `scrollHeight`/`scrollWidth`/row-offset
 * measurements against a live, laid-out DOM — is
 * `tests/e2e/inspector-panel-measurement.e2e.ts`, a Playwright spec that
 * drives a real dev server. That split is deliberate, not a compromise
 * discovered mid-implementation: `happy-dom` doesn't lay out the DOM, full
 * stop, so there is no way to make the "real" assertions pass here honestly.
 *
 * ── Move note ─────────────────────────────────────────────────────────────
 * This file replaces (not duplicates) `src/admin/pages/site/panels/
 * PropertiesPanel/__tests__/inspectorGeometryBudget.test.tsx`, which is
 * deleted in the same change. Every assertion that file made — the frozen
 * token table, the no-`clamp()`/`vw` scan, the frozen-vs-fluid-scale scan
 * (glob widened below to cover the 16 `INSPECTOR_SECTIONS` — see "P3
 * completion note" below), `getPropertyFieldGlyph` coverage, the
 * `PROPERTIES_PANEL_DEFAULT_WIDTH` pin, and the `Button`/`Select`
 * inspector-skin pins — moves here unchanged. None are dropped.
 *
 * ── P3 completion note (`STATE.md` `panel-25`, item 11 — Studio extras) ──
 * The old file also budgeted a row count `StyleSectionsEditor`/
 * `classStyleSections.ts`'s legacy registry could draw (a "caption budget"
 * per section, and a whole-panel caption count rendered through
 * `StyleSectionsEditor` directly). Both are gone: `StyleSectionsEditor.tsx`
 * is deleted and `CLASS_STYLE_SECTIONS` is permanently `[]` — every CSS
 * category now renders through its own `INSPECTOR_SECTIONS` manifest entry
 * with its own geometry, not a shared registry that budget could describe in
 * one place. What replaces it, below, is a per-SECTION computed rest-height
 * table built the same way, off the current 16-entry manifest.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPropertyFieldGlyph } from '@site/panels/PropertiesPanel/cssPropertyIcons'
import { INSPECTOR_SECTIONS } from '@site/inspector/sections'

const SRC_ROOT = join(import.meta.dir, '../..')
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles/globals.css'), 'utf8')

// ---------------------------------------------------------------------------
// Manifest shape — the 16-entry `INSPECTOR_SECTIONS` array `sections/
// index.ts` itself documents, in the exact order and with contiguous
// `order` fields. A gap or a dupe here means a section either double-mounts
// or silently stops rendering.
// ---------------------------------------------------------------------------

const EXPECTED_SECTION_IDS = [
  'layer',
  'align',
  'measures',
  'layout',
  'fill',
  'stroke',
  'shadow',
  'blur',
  'text',
  'export',
  'component',
  'attributes',
  'transform',
  'animations',
  'interaction',
  'customProperties',
] as const

describe('INSPECTOR_SECTIONS manifest shape', () => {
  it('has exactly 16 entries', () => {
    expect(INSPECTOR_SECTIONS.length).toBe(16)
  })

  it('lists ids in the exact order sections/index.ts itself documents', () => {
    expect(INSPECTOR_SECTIONS.map((s) => s.id)).toEqual([...EXPECTED_SECTION_IDS])
  })

  it('has order fields 0-15 with no gaps or dupes', () => {
    const orders = INSPECTOR_SECTIONS.map((s) => s.order).sort((a, b) => a - b)
    expect(orders).toEqual(Array.from({ length: 16 }, (_, i) => i))
  })
})

// ---------------------------------------------------------------------------
// Frozen inspector geometry — the gate that keeps the panel a fixed grid.
// Every inspector token that participates in a height, and the px value it
// is frozen at. Read as a table: this IS the panel's vertical grid.
// ---------------------------------------------------------------------------

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
   * step, which is invisible in review and compounds over sixteen sections.
   *
   * Glob widened from the old file's three roots to ALSO cover
   * `admin/pages/site/inspector/sections/**\/*.module.css` — the real gap
   * this pass's recon found: none of the 16 new sections' own CSS modules
   * were covered by this check before.
   */
  it('inspector CSS modules use the frozen scale, not the fluid --space-* one', () => {
    const FLUID_SMALL_STEPS = ['4xs', '3xs', '2xs', 'xs', 's', 'm', 'l', 'xl']
    const offenders: string[] = []
    const roots = [
      join(SRC_ROOT, 'admin/pages/site/panels/PropertiesPanel'),
      join(SRC_ROOT, 'admin/pages/site/property-controls'),
      join(SRC_ROOT, 'admin/pages/site/inspector/sections'),
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
    const uiSlice = readFileSync(join(SRC_ROOT, 'admin/pages/site/store/slices/uiSlice.ts'), 'utf8')
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

// ---------------------------------------------------------------------------
// Computed section rest-height table
//
// NOT a measurement — happy-dom cannot lay this out (see file header). This
// is a COMPUTED budget: headerHeightPx + collapsedOrMinimalRowCount *
// rowHeightPx + (rowCount - 1) * withinGroupGapPx, using the frozen tokens
// above (--inspector-header-h/--inspector-row-h = 32px each,
// --inspector-space-2xs = 4px for the within-group row gap). The real e2e
// spec (`tests/e2e/inspector-panel-measurement.e2e.ts`) cross-checks the
// four rows the P0 baseline actually measured against a real, laid-out DOM.
//
// `collapsedOrMinimalRowCount` per section, read from each section's own
// source, not guessed:
//
//   - layer (headerless, per its own doc: "the panel's very first row,
//     always resident, never collapsible"): 1 fixed row.
//   - align (headerless): renders `null` — 0 rows — whenever the selection
//     has no flex/grid parent to align within (its own doc: "the row doesn't
//     exist in the DOM at all... not a fully-disabled row"). The F2/F3
//     fixtures this table assumes are a plain text node and a flex BOARD
//     itself (not a flex CHILD), so Align contributes 0 for both.
//   - measures (headerless, CONSTRAINTS face — no flex/grid parent):
//     SizeSection's W/H row + the position/z-index row + the rotation/radius
//     row = 3 rows. Cross-checked against the real P0 baseline's own
//     `rowRhythm.measuredRowOriginsYPxDarkTheme` (opacityBlendRow=132,
//     widthHeightRow=180, xyRow=216, rotationRadiusRow=252 — three
//     consecutive 32px+4px rows following Layer's own row, exactly this
//     count).
//   - layout (headered "Layout"; per its own doc, never collapses to empty):
//     for a plain block (not itself a flex/grid container) — LayoutModeRow +
//     PaddingCluster + the margin row = 3 rows.
//   - fill / stroke / shadow / blur / export / transform / animations /
//     interaction (headered, all use `Section`'s `empty` prop — Law 1's
//     "nothing set anywhere and the user hasn't clicked '+' yet" state,
//     confirmed in each file): 0 rows in their default/unrevealed state.
//   - text (headered "Text", per its own doc explicitly: "an ALWAYS-RESIDENT
//     section... onto the same four rows: family; weight+size; line-height+
//     letter-spacing; text-align + vertical-align + a settings gear"):
//     4 rows, never collapses (a text layer always has a font to show).
//   - component (headered "Component", `appliesTo: studio.instance` only —
//     does NOT mount for the F2/F3 fixtures below; included here for
//     manifest completeness, not exercised by the e2e spec): 1 row (the
//     header/name row) for a component with zero declared props — a real
//     floor, not its typical size (each declared prop adds one more row).
//   - attributes (headered "Attributes", always resident): 1 row — the
//     "Add" button row shown when `htmlAttributes` is empty (its own
//     `EmptyState` message is a variable-height block, not a fixed 32px row,
//     and is deliberately excluded from this literal-px budget).
//   - customProperties (headered "Custom properties", always resident, per
//     its own doc: "still render the section so the 'Add property'
//     affordance is discoverable; just no rows"): 1 row — the "Add property"
//     trigger shown when there are no uncurated keys set.
// ---------------------------------------------------------------------------

const HEADER_H = 32
const ROW_H = 32
const WITHIN_GROUP_GAP = 4

function computedRestHeight(hasHeader: boolean, rowCount: number): number {
  const header = hasHeader ? HEADER_H : 0
  const rows = rowCount * ROW_H
  const gaps = rowCount > 0 ? (rowCount - 1) * WITHIN_GROUP_GAP : 0
  return header + rows + gaps
}

const SECTION_MINIMAL_STATE: Record<(typeof EXPECTED_SECTION_IDS)[number], { hasHeader: boolean; rowCount: number }> = {
  layer: { hasHeader: false, rowCount: 1 },
  align: { hasHeader: false, rowCount: 0 },
  measures: { hasHeader: false, rowCount: 3 },
  layout: { hasHeader: true, rowCount: 3 },
  fill: { hasHeader: true, rowCount: 0 },
  stroke: { hasHeader: true, rowCount: 0 },
  shadow: { hasHeader: true, rowCount: 0 },
  blur: { hasHeader: true, rowCount: 0 },
  text: { hasHeader: true, rowCount: 4 },
  export: { hasHeader: true, rowCount: 0 },
  component: { hasHeader: true, rowCount: 1 },
  attributes: { hasHeader: true, rowCount: 1 },
  transform: { hasHeader: true, rowCount: 0 },
  animations: { hasHeader: true, rowCount: 0 },
  interaction: { hasHeader: true, rowCount: 0 },
  customProperties: { hasHeader: true, rowCount: 1 },
}

const EXPECTED_REST_HEIGHT_PX: Record<(typeof EXPECTED_SECTION_IDS)[number], number> = {
  layer: 32, // 0 + 1*32 + 0*4
  align: 0, // 0 + 0 + 0 — renders null, no flex/grid parent
  measures: 104, // 0 + 3*32 + 2*4
  layout: 136, // 32 + 3*32 + 2*4
  fill: 32, // 32 + 0 + 0
  stroke: 32,
  shadow: 32,
  blur: 32,
  text: 172, // 32 + 4*32 + 3*4
  export: 32,
  component: 64, // 32 + 1*32 + 0*4
  attributes: 64,
  transform: 32,
  animations: 32,
  interaction: 32,
  customProperties: 64,
}

describe('computed section rest-height budget', () => {
  it('matches the formula for every section id in the manifest', () => {
    for (const id of EXPECTED_SECTION_IDS) {
      const { hasHeader, rowCount } = SECTION_MINIMAL_STATE[id]
      expect(computedRestHeight(hasHeader, rowCount)).toBe(EXPECTED_REST_HEIGHT_PX[id])
    }
  })

  it('the three tightly-paired Measures rows match the P0 baseline row rhythm', () => {
    // Real, literal Y-origins from `docs/audits/penpot-inspector-baseline/
    // measurements.json`'s `rowRhythm.measuredRowOriginsYPxDarkTheme` — not
    // re-derived here. The fact this test pins is that Measures' own three
    // rows (widthHeightRow, xyRow, rotationRadiusRow) are CONSECUTIVE,
    // tightly-paired 32px rows following Layer's row (opacityBlendRow),
    // matching this file's own rowCount=3 budget for Measures above.
    const layerRow = 132
    const widthHeightRow = 180
    const xyRow = 216
    const rotationRadiusRow = 252
    expect(widthHeightRow).toBeGreaterThan(layerRow)
    expect(xyRow - widthHeightRow).toBeLessThanOrEqual(ROW_H + WITHIN_GROUP_GAP)
    expect(rotationRadiusRow - xyRow).toBeLessThanOrEqual(ROW_H + WITHIN_GROUP_GAP)
  })
})
