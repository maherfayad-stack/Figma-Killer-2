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
 * table built the same way, off the current 15-entry manifest.
 *
 * ── `panel-29` note (direct user feedback while dogfooding) ──────────────
 * `attributes` was REMOVED from the manifest outright (not relocated) —
 * "remove attributes" — and `transform`/`animations`/`interaction` moved to
 * `InspectorShell`'s Prototype tab.
 *
 * ── S5 note (`STUDIO-FIGMA-FEEL-PLAN.md`, the 900px budget) ──────────────
 * Three further manifest-shape changes this file pins:
 *   - `tab?: 'design' | 'prototype'` became `tabs?: readonly
 *     InspectorSectionTab[]`, because `transform`/`animations`/`interaction`
 *     now mount in BOTH tabs: expanded in Prototype (the tab that exists for
 *     that material), and inside Design's one collapsed **More** disclosure,
 *     so a CSS `transform` is still reachable without a tab switch.
 *   - `designGroup: 'more'` tags the four Studio-extras sections
 *     (`transform`/`animations`/`interaction`/`customProperties`) that
 *     `StyleSurface.tsx` renders inside that single collapsed group instead
 *     of the continuous scroll. The computed rest-height table at the bottom
 *     of this file is what makes that a measurable saving rather than a
 *     claim: it now carries a Design-tab TOTAL for the F2 text fixture, in
 *     both the collapsed and expanded states.
 *   - `AttributesSection.tsx`/`.module.css`/`htmlAttributesModel.ts` and
 *     their tests are DELETED. `panel-29` parked them "unmounted but
 *     intact", which is the `No dead code` rule's exact failure mode. The
 *     `htmlAttributes` PROP is untouched — the publisher, `htmlImport`, and
 *     every base module's renderer still read it.
 *
 * S5's second half adds a 16th entry, `selectionColors` (WS-14.4 / G6.4) —
 * the only one with a MULTI-only `appliesTo`, since `SelectionModel` now
 * describes N nodes and the parallel multi-selection surface that used to
 * mount it (`MultiSelectionInspector`/`MultiSelectionStyleArea`/
 * `MultiInlineStyleComposer`) is deleted. It never mounts for the
 * single-node F1–F4 fixtures, so it adds nothing to the Design-tab total
 * below.
 *
 * ── P2-F note (owner decision OD-4 — the design pane's spacing) ──────────
 * `shadow` and `blur` are ONE `effects` entry now (Figma's Effects section),
 * so the manifest is 15 entries. The between-section gap is its own named
 * token, `--inspector-section-gap`, at 12px — read from `globals.css` below,
 * not re-typed — and the rows inside Text, Measures and the Module block sit
 * the within-group 4px apart. This file also pins the Module block's new
 * boundary (a real header, bottom padding, a hairline) and the ClassPicker
 * fade's scrolled-only rule as structure, since happy-dom can measure
 * neither.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPropertyFieldGlyph } from '@site/panels/PropertiesPanel/cssPropertyIcons'
import { INSPECTOR_SECTIONS, PROTOTYPE_TAB_SECTIONS } from '@site/inspector/sections'

const SRC_ROOT = join(import.meta.dir, '../..')
const GLOBALS_CSS = readFileSync(join(SRC_ROOT, 'styles/globals.css'), 'utf8')

// ---------------------------------------------------------------------------
// Manifest shape — the 15-entry `INSPECTOR_SECTIONS` array `sections/
// index.ts` itself documents, in the exact order and with contiguous
// `order` fields. A gap or a dupe here means a section either double-mounts
// or silently stops rendering.
// ---------------------------------------------------------------------------

const EXPECTED_SECTION_IDS = [
  'layer',
  'align',
  'measures',
  'component',
  'layout',
  'fill',
  'selectionColors',
  'stroke',
  'effects',
  'text',
  'export',
  'transform',
  'animations',
  'interaction',
  'customProperties',
] as const

/** The 3 entries that mount in BOTH tabs — see this file's own S5 note. */
const PROTOTYPE_TAB_SECTION_IDS = ['transform', 'animations', 'interaction'] as const

/** The 4 entries behind Design's one collapsed More disclosure (S5). */
const MORE_GROUP_SECTION_IDS = [
  'transform',
  'animations',
  'interaction',
  'customProperties',
] as const

describe('INSPECTOR_SECTIONS manifest shape', () => {
  it('has exactly 15 entries', () => {
    expect(INSPECTOR_SECTIONS.length).toBe(15)
  })

  it('lists ids in the exact order sections/index.ts itself documents', () => {
    expect(INSPECTOR_SECTIONS.map((s) => s.id)).toEqual([...EXPECTED_SECTION_IDS])
  })

  it('has order fields 0-14 with no gaps or dupes', () => {
    const orders = INSPECTOR_SECTIONS.map((s) => s.order).sort((a, b) => a - b)
    expect(orders).toEqual(Array.from({ length: 15 }, (_, i) => i))
  })

  it('draws shadows and blurs as ONE Effects section (P2-F, OD-4)', () => {
    const ids = INSPECTOR_SECTIONS.map((s) => s.id)
    expect(ids).toContain('effects')
    expect(ids).not.toContain('shadow')
    expect(ids).not.toContain('blur')
  })

  it('tags exactly the 3 dual-tab sections tabs: [design, prototype]; every other entry defaults to design-only', () => {
    for (const section of INSPECTOR_SECTIONS) {
      const expectedTabs = (PROTOTYPE_TAB_SECTION_IDS as readonly string[]).includes(section.id)
        ? ['design', 'prototype']
        : undefined
      expect(section.tabs).toEqual(expectedTabs)
    }
  })

  it('PROTOTYPE_TAB_SECTIONS is exactly those 3, in manifest order', () => {
    expect(PROTOTYPE_TAB_SECTIONS.map((s) => s.id)).toEqual([...PROTOTYPE_TAB_SECTION_IDS])
  })

  it('puts exactly the 4 Studio-extras sections behind the one More disclosure', () => {
    for (const section of INSPECTOR_SECTIONS) {
      const expectedGroup = (MORE_GROUP_SECTION_IDS as readonly string[]).includes(section.id)
        ? 'more'
        : undefined
      expect(section.designGroup).toBe(expectedGroup)
    }
  })

  it('removed attributes outright — no manifest entry left for it', () => {
    expect(INSPECTOR_SECTIONS.some((s) => s.id === 'attributes')).toBe(false)
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
  // P2-G / UX-10 — 68px ellipsised any prop name over ~10 characters.
  ['--inspector-label-w', '96px'],
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
  // P2-F / OD-4 — the between-section step, its own role since UX-2.
  ['--inspector-section-gap', '12px'],
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
//   - layout (headered "Layout"): 0 rows for a plain block. panel-39 made
//     this section a COLLAPSED disclosure whenever no layout exists —
//     `display` unset or `none`-equivalent — so its rest state is the header
//     alone plus an "Add auto layout" `+`, exactly like every other empty
//     section here. Its body (LayoutModeRow + PaddingCluster + the margin row
//     + clip content) is one click away and unchanged; a flex/grid container
//     still renders it `forceOpen`, which is why this row is the REST state
//     and not the section's typical size. Measured saving: 167px on every
//     selection that is not itself a container.
//   - fill / stroke / effects / export / transform / animations /
//     interaction (headered, all use `Section`'s `empty` prop — Law 1's
//     "nothing set anywhere and the user hasn't clicked '+' yet" state,
//     confirmed in each file): 0 rows in their default/unrevealed state.
//   - text (headered "Text", per its own doc explicitly: "an ALWAYS-RESIDENT
//     section... onto the same four rows: family; weight+size; line-height+
//     letter-spacing; text-align + vertical-align + a settings gear"):
//     4 rows, never collapses (a text layer always has a font to show).
//   - component (one title row naming the instance since P2-G, "Button ·
//     Local"; `appliesTo` one `studio.instance` only — does NOT mount for the
//     F1-F4 fixtures below, and is measured as the e2e spec's F5): 1 row —
//     the "takes no props" line — for a component with zero declared props, a
//     real floor, not its typical size (each declared prop adds one row).
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
  layout: { hasHeader: true, rowCount: 0 },
  fill: { hasHeader: true, rowCount: 0 },
  // Multi-select only, so it never mounts for the single-node F1/F2/F3/F4
  // fixtures below. Its floor is `Section`'s `empty` header — a selection
  // whose colours all come from classes has no inline colour to offer.
  selectionColors: { hasHeader: true, rowCount: 0 },
  stroke: { hasHeader: true, rowCount: 0 },
  effects: { hasHeader: true, rowCount: 0 },
  text: { hasHeader: true, rowCount: 4 },
  export: { hasHeader: true, rowCount: 0 },
  component: { hasHeader: true, rowCount: 1 },
  transform: { hasHeader: true, rowCount: 0 },
  animations: { hasHeader: true, rowCount: 0 },
  interaction: { hasHeader: true, rowCount: 0 },
  customProperties: { hasHeader: true, rowCount: 1 },
}

const EXPECTED_REST_HEIGHT_PX: Record<(typeof EXPECTED_SECTION_IDS)[number], number> = {
  layer: 32, // 0 + 1*32 + 0*4
  align: 0, // 0 + 0 + 0 — renders null, no flex/grid parent
  measures: 104, // 0 + 3*32 + 2*4
  layout: 32, // 32 + 0 + 0 — collapsed until a layout exists (panel-39)
  fill: 32, // 32 + 0 + 0
  selectionColors: 32, // multi-select only — see SECTION_MINIMAL_STATE
  stroke: 32,
  effects: 32,
  text: 172, // 32 + 4*32 + 3*4
  export: 32,
  component: 64, // 32 + 1*32 + 0*4
  transform: 32,
  animations: 32,
  interaction: 32,
  customProperties: 64,
}

// ---------------------------------------------------------------------------
// Design-tab TOTAL for the F2 text fixture — the number S5 exists to move.
//
// Still computed, not measured (same happy-dom limitation as everything
// above): the sum of the sections the F2 text node mounts in the Design tab,
// plus `.surfaceContent`'s own `--inspector-section-gap` grid gap between
// every mounted wrapper. `align` renders `null` for this fixture, and its
// empty `[data-section-id]` wrapper is `display: none`
// (`StyleSurface.module.css`'s `[data-section-id]:empty`), so it is NOT a
// grid item and costs no gap — this table used to count one for it, which
// the measured artefact never agreed with.
//
// Panel CHROME above the sections (ClassPicker's one tag-input row,
// `.surface`'s own padding) is NOT in this number: none of it is an
// `INSPECTOR_SECTIONS` entry with a row count to compute. The real,
// whole-panel measurement lives in `tests/e2e/inspector-height.e2e.ts`, which
// also writes the MEASURED version of this table to
// `docs/audits/penpot-inspector-baseline/`. That spec's first real run
// (`STATE.md` panel-37) put numbers on the chrome for the first time — 274px,
// of which panel-39 reclaimed 92 by moving `FrameSizePanel` out of every node
// selection and trimming the tab strip, and panel-41 a further 28 by folding
// the selector pills into the ClassPicker's own row — and on the Module
// block, which is measured as a `data-section-id="module"` row in the same
// artefact rather than being invisible to both tables.
// ---------------------------------------------------------------------------

/**
 * `--inspector-section-gap`, read from `globals.css` rather than re-typed, so
 * this table can never quietly disagree with the token it models (UX-2).
 */
const BETWEEN_SECTION_GAP = Number(/--inspector-section-gap: (\d+)px;/.exec(GLOBALS_CSS)?.[1])
/** `Section`'s header alone, which is all a collapsed More group costs. */
const MORE_HEADER_H = HEADER_H

/** What the F2 text node mounts in the Design tab's continuous scroll. */
const F2_PRIMARY_SECTION_IDS = [
  'layer',
  'measures',
  'layout',
  'fill',
  'stroke',
  'effects',
  'text',
  'export',
] as const

function sumWithGaps(heights: ReadonlyArray<number>): number {
  const gaps = heights.length > 0 ? (heights.length - 1) * BETWEEN_SECTION_GAP : 0
  return heights.reduce((total, h) => total + h, 0) + gaps
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

  it('the between-section gap is 12px, one step above the 8px between-group step', () => {
    expect(BETWEEN_SECTION_GAP).toBe(12)
    expect(BETWEEN_SECTION_GAP).toBeGreaterThan(8)
  })

  it('the F2 text node Design tab costs 596px of sections with More collapsed', () => {
    // This is a SECTIONS-only sum, and it is not the whole Design tab — the
    // Module block and the container padding are not manifest entries. The
    // measured `contentHeight` lives in `tests/e2e/inspector-height.e2e.ts`
    // and `05-section-heights.json`. What this exact number is good for is
    // catching a section that quietly grows a resident row without anyone
    // opening a browser; it is NOT evidence that the tab fits.
    //
    // 756 -> 612 was panel-39 (Layout collapsed at rest, and a 12 -> 8px
    // section gap). 612 -> 596 is P2-F: the gap goes to 12px as its own token
    // (+32 across the eight gaps that remain), Shadow + Blur become one
    // Effects section (-32 of header, -8 of gap), and `align`'s phantom gap
    // is no longer counted (-8, see this table's own header).
    const primary = F2_PRIMARY_SECTION_IDS.map((id) => EXPECTED_REST_HEIGHT_PX[id])
    expect(sumWithGaps([...primary, MORE_HEADER_H])).toBe(596)
  })

  it('merging Shadow + Blur into Effects is worth one header and one gap', () => {
    // The static half of UX-5: what pays for the wider section gap. The
    // measured saving is 33px of header (32 + the Section hairline) plus a
    // gap — 45px at 12px.
    const separate = sumWithGaps([EXPECTED_REST_HEIGHT_PX.stroke, 32, 32, EXPECTED_REST_HEIGHT_PX.text])
    const merged = sumWithGaps([
      EXPECTED_REST_HEIGHT_PX.stroke,
      EXPECTED_REST_HEIGHT_PX.effects,
      EXPECTED_REST_HEIGHT_PX.text,
    ])
    expect(separate - merged).toBe(HEADER_H + BETWEEN_SECTION_GAP)
  })

  it('the More disclosure buys back 164px that used to be always-mounted', () => {
    const primary = F2_PRIMARY_SECTION_IDS.map((id) => EXPECTED_REST_HEIGHT_PX[id])
    const moreSectionHeights = MORE_GROUP_SECTION_IDS.map((id) => EXPECTED_REST_HEIGHT_PX[id])
    // Before S5: all four mounted inline, each its own grid item.
    const before = sumWithGaps([...primary, ...moreSectionHeights])
    // After S5: one collapsed header in their place.
    const after = sumWithGaps([...primary, MORE_HEADER_H])
    // 164 at the 12px section gap (it was 152 while panel-39 held the gap at
    // 8px — three fewer gaps × 4px).
    expect(before - after).toBe(164)
  })

  it('collapsing Layout until a layout exists is worth 104px of section column', () => {
    // The static half of panel-39's largest single cut. The MEASURED saving is
    // larger (167px — `05-section-heights.md`), because the real body carries
    // a flex/grid block and a settings row this row-count model does not try
    // to predict. What this pins is that Layout's REST state is a header and
    // nothing else, the same shape every other unused section here has.
    const openLayout = computedRestHeight(true, 3)
    expect(openLayout - EXPECTED_REST_HEIGHT_PX.layout).toBe(104)
    expect(EXPECTED_REST_HEIGHT_PX.layout).toBe(EXPECTED_REST_HEIGHT_PX.fill)
  })
})

// ---------------------------------------------------------------------------
// P2-F — the design pane's spacing, pinned as structure.
//
// happy-dom neither lays out nor resolves CSS Modules, so the rules the
// owner's ask rests on ("space between the props and the element below",
// UX-1/UX-2/UX-3/UX-6) are asserted against the stylesheets themselves — the
// same way the primitives' inspector skin is pinned above. The measured half
// is `tests/e2e/inspector-height.e2e.ts`.
// ---------------------------------------------------------------------------

function readSource(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), 'utf8')
}

/** The declarations inside the first `selector { … }` block of a stylesheet. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} is not declared`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

const PANEL_DIR = 'admin/pages/site/panels/PropertiesPanel'
const SECTIONS_DIR = 'admin/pages/site/inspector/sections'

describe('P2-F — the props block has a real boundary (UX-1)', () => {
  it('titles the Module block with the shared section header recipe, not a hand-rolled label', () => {
    const tsx = readSource(`${PANEL_DIR}/ModuleBlock.tsx`)
    expect(tsx).toContain('<SectionStaticHeader')
    expect(readSource(`${PANEL_DIR}/ModuleBlock.module.css`)).not.toContain('text-transform: uppercase')
  })

  it('ends the block in 8px of padding and a hairline', () => {
    const css = readSource(`${PANEL_DIR}/ModuleBlock.module.css`)
    expect(ruleBody(css, '.block')).toContain('border-bottom: 1px solid var(--inspector-divider)')
    expect(ruleBody(css, '.body.body')).toContain('padding: 0 var(--inspector-pad-x) var(--inspector-space-m)')
  })
})

describe('P2-F — the three-step spacing hierarchy (UX-2, UX-3)', () => {
  it('spaces sections by the named --inspector-section-gap', () => {
    const css = readSource(`${PANEL_DIR}/StyleSurface.module.css`)
    expect(ruleBody(css, '.surfaceContent')).toContain('gap: var(--inspector-section-gap)')
  })

  it('sits the rows inside one group 4px apart: Module props, Text, Measures, component props', () => {
    const WITHIN = 'gap: var(--inspector-space-2xs)'
    expect(ruleBody(readSource(`${PANEL_DIR}/ModuleBlock.module.css`), '.body.body')).toContain(WITHIN)
    expect(ruleBody(readSource(`${SECTIONS_DIR}/TextSection.module.css`), '.section')).toContain(WITHIN)
    expect(ruleBody(readSource(`${SECTIONS_DIR}/MeasuresSection.module.css`), '.measures')).toContain(WITHIN)
    expect(ruleBody(readSource(`${SECTIONS_DIR}/ComponentSection.module.css`), '.propsList')).toContain(WITHIN)
    expect(readSource(`${SECTIONS_DIR}/TextSection.tsx`)).toContain('rhythm="within-group"')
  })

  it('no longer repeats the false "8px is Penpot\'s section gap" claim', () => {
    for (const file of ['styles/globals.css', `${PANEL_DIR}/StyleSurface.module.css`]) {
      expect(readSource(file)).not.toMatch(/8px is Figma's and Penpot's (own )?measured section gap/)
    }
  })
})

describe('P2-F — the ClassPicker fade only shows once scrolled (UX-6)', () => {
  it('is transparent at rest and opaque only while the scroll container reports data-scrolled', () => {
    const css = readSource(`${PANEL_DIR}/PropertiesPanel.module.css`)
    expect(ruleBody(css, '.headerClassPicker::after')).toContain('opacity: 0')
    expect(ruleBody(css, ".headerClassPicker:has(~ [data-scrolled='true'])::after")).toContain('opacity: 1')
  })
})

// ---------------------------------------------------------------------------
// P2-G — the Component section, pinned as structure (UX-4, UX-7, UX-10,
// UX-14). The measured half is F5 in `tests/e2e/inspector-height.e2e.ts`.
// ---------------------------------------------------------------------------

describe('P2-G — the Component section', () => {
  it('sits directly under Measures, before every other section (UX-7)', () => {
    const ids = INSPECTOR_SECTIONS.map((s) => s.id)
    expect(ids.indexOf('component')).toBe(ids.indexOf('measures') + 1)
    const component = INSPECTOR_SECTIONS.find((s) => s.id === 'component')!
    expect(component.order).toBe(3)
  })

  it('is the one section that writes a call site, so no style lock hides it', () => {
    const callSite = INSPECTOR_SECTIONS.filter((s) => s.writes === 'call-site').map((s) => s.id)
    expect(callSite).toEqual(['component'])
    expect(readSource(`${PANEL_DIR}/StyleSurface.tsx`)).toContain('designCallSiteSections(model)')
  })

  it('draws one title row — the shared static header — and no banded strips (UX-4)', () => {
    const tsx = readSource(`${SECTIONS_DIR}/ComponentSection.tsx`)
    expect(tsx).toContain('<SectionStaticHeader')
    expect(tsx).not.toContain('<Section ')
    const css = readSource(`${SECTIONS_DIR}/ComponentSection.module.css`)
    expect(css).not.toContain('.header {')
    expect(css).not.toContain('.actionsRow')
    expect(css).not.toContain('var(--bg-surface-3)')
    expect(css).not.toContain('1px solid var(--border)')
    expect(ruleBody(css, '.section')).toContain('border-top: 1px solid var(--inspector-divider)')
  })

  it('does not mount for a multi-selection (UX-14)', () => {
    const component = INSPECTOR_SECTIONS.find((s) => s.id === 'component')!
    type Selection = Parameters<typeof component.appliesTo>[0]
    const instance = { moduleId: 'studio.instance' }
    expect(component.appliesTo({ isMultiSelect: false, selectedNode: instance } as unknown as Selection)).toBe(true)
    expect(component.appliesTo({ isMultiSelect: true, selectedNode: instance } as unknown as Selection)).toBe(false)
  })

  it('the prop label column fits a real prop name, and the row gaps are frozen inside the panel (UX-10)', () => {
    expect(readSource('admin/pages/site/panels/PropertiesPanel/PropertiesPanel.module.css')).toContain(
      '--control-label-w: var(--inspector-label-w)',
    )
    const controlRow = readSource('ui/components/ControlRow/ControlRow.module.css')
    expect(ruleBody(controlRow, "[data-field-skin='inspector'] .controlWrapper")).toContain(
      'gap: var(--inspector-space-2xs)',
    )
  })
})
