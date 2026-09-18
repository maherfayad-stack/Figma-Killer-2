/**
 * The eight bespoke sections under a multi-selection that disagrees
 * (W8-3 phase 1's remaining gap, closed).
 *
 * The failure this pins: phase 1 taught the *primitives* to render "Mixed",
 * and routed the `MIXED` sentinel through `ClassPropertyRow`. Every section
 * that reads its raw cells directly — Spacing, Layout, Position, Size,
 * Typography, Appearance, Fill, Stroke — went on reading them through
 * `readString` / a local `pickString`, both of which return `undefined` for a
 * Symbol. So five layers with five different paddings drew an *empty* field,
 * indistinguishable from "nobody set a padding", and one wrong keystroke
 * from silently flattening all five. `String(MIXED)` was the other half of
 * the bug: Position and Size would have printed `Symbol(studio-mixed-value)`
 * into the field, because `hasStyleValue` is true for a Symbol.
 *
 * Each case below hands a section a bag holding `MIXED` and asserts the
 * control says so.
 *
 * `Position` (the old standalone, props-driven `PositionSection`) is no
 * longer part of this file's coverage — it migrated into `MeasuresSection`
 * (`STATE.md` `panel-25`, P3 item 3), which reads storedStyles/currentStyles
 * from the store via `useSelectionModel()`, not from props a test can hand
 * it directly, and which is structurally UNREACHABLE during multi-select in
 * the first place (`PropertiesPanelBody.tsx` renders `MultiSelectionInspector`
 * instead, before `StyleSurface`/`INSPECTOR_SECTIONS` ever mount — the same
 * fact `AlignSection`'s own doc already relies on). There is no longer a
 * multi-select-mixed code path through Measures to pin here. `Appearance`
 * (the old radius-only remainder) is now `RadiusCluster` — same props
 * contract, just renamed and relocated. `Spacing`/`Layout` (the old
 * standalone, props-driven `SpacingSection`/`LayoutSection`) are ALSO no
 * longer part of this file's coverage, for the exact same reason — both
 * folded into `inspector/sections/LayoutSection.tsx` (`STATE.md` `panel-25`,
 * P3 item 4), store-backed and structurally unreachable during multi-select.
 * `Fill` (the old standalone, props-driven `FillSection`) is ALSO no longer
 * part of this file's coverage, for the exact same reason — it migrated into
 * `inspector/sections/FillSection.tsx` (`STATE.md` `panel-25`, P3 item 5).
 * `Stroke` (the old standalone, props-driven `StrokeSection`) is ALSO no
 * longer part of this file's coverage, for the exact same reason — it
 * migrated into `inspector/sections/StrokeSection.tsx` (`STATE.md`
 * `panel-25`, P3 item 6). `Typography` (the old standalone, props-driven
 * `TypographySection`) is ALSO no longer part of this file's coverage, for
 * the exact same reason — it migrated into `inspector/sections/
 * TextSection.tsx` (`STATE.md` `panel-25`, P3 item 9), store-backed and
 * structurally unreachable during multi-select.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MIXED } from '@ui/components/MixedValue'
import { SizeSection } from '../SizeSection'
import { RadiusCluster } from '../../../inspector/sections/RadiusCluster'

/** Multi-property write channel — see `StyleSectionsEditor`'s `onChangeMany`. */
function noopMany() {}

afterEach(cleanup)

function noop() {}

/**
 * Force an `ExpandableFieldCluster` collapsed. Its open/closed state is
 * module-level and sticky per cluster id (by design — see that component's
 * doc), so a test that wants the LINKED field has to say so rather than
 * inherit whatever a sibling test left behind.
 */
function collapseCluster(id: string) {
  const toggle = screen.getByTestId(`expandable-field-cluster-${id}-toggle`)
  if (toggle.getAttribute('aria-expanded') === 'true') fireEvent.click(toggle)
}

describe('Size', () => {
  it('never prints the sentinel into the width field', () => {
    render(
      <SizeSection
        storedStyles={{ width: MIXED }}
        currentStyles={{}}
        activeTab="base"
        onChange={noop}
        onChangeMany={noopMany}
        onRemove={noop}
        onClearProperty={noop}
      />,
    )
    const field = screen.getByLabelText('Width') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})

describe('RadiusCluster (Measures) — corner radius', () => {
  it('reads Mixed on the linked corner field', () => {
    render(
      <RadiusCluster
        storedStyles={{
          borderTopLeftRadius: MIXED,
          borderTopRightRadius: MIXED,
          borderBottomRightRadius: MIXED,
          borderBottomLeftRadius: MIXED,
        }}
        currentStyles={{}}
        onChange={noop}
        onChangeMany={noopMany}
      />,
    )
    collapseCluster('radius')
    // `ScrubInput` puts `data-testid` on the field WRAPPER and `-field` on
    // the `<input>` — same convention `measuresSection.test.tsx` documents.
    const field = screen.getByTestId('measures-radius-all-field') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('placeholder')).toBe('Mixed')
  })
})
