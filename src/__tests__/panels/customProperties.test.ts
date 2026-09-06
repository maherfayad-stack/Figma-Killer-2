/**
 * Custom properties — uncurated CSS property surfacing (CSS fidelity Phase 1b).
 *
 * Unit-level tests for the `getCustomProperties` / `isCuratedProperty`
 * helpers that drive the CustomPropertiesSection. The component itself is
 * exercised by the browser smoke; here we lock the curated/uncurated split.
 */

import { describe, it, expect } from 'bun:test'
import {
  getCustomProperties,
  isCuratedProperty,
} from '@site/panels/PropertiesPanel/cssControlTypes'

describe('isCuratedProperty', () => {
  it('curated props (have a bespoke widget) return true', () => {
    expect(isCuratedProperty('fontSize')).toBe(true)
    expect(isCuratedProperty('paddingTop')).toBe(true)
    expect(isCuratedProperty('borderTopWidth')).toBe(true)
    expect(isCuratedProperty('backgroundColor')).toBe(true)
  })

  it('uncurated but valid props return false', () => {
    expect(isCuratedProperty('gridAutoFlow')).toBe(false)
    // `fontFeatureSettings` used to stand here. It is CURATED now — the
    // typography settings popover (G9 / Figma F26 "Details") owns it, so it
    // must not fall through to the custom-properties editor. `willChange` is
    // the replacement: still genuinely uncurated, still a valid CSS property.
    expect(isCuratedProperty('willChange')).toBe(false)
    expect(isCuratedProperty('listStyleType')).toBe(false)
    expect(isCuratedProperty('--brand')).toBe(false)
  })
})

describe('getCustomProperties', () => {
  it('returns only set, uncurated properties, sorted', () => {
    const styles = {
      fontSize: '16px',          // curated → excluded
      gridAutoFlow: 'dense',     // uncurated → included
      fontFeatureSettings: '"liga"', // CURATED now (typography ⚙ Details) → excluded
      willChange: 'transform',   // uncurated → included
      '--brand': '#2563eb',      // custom prop → included
      color: '',                 // empty → excluded even though curated
      listStyleType: '',         // empty → excluded
    }
    expect(getCustomProperties(styles)).toEqual([
      '--brand',
      'gridAutoFlow',
      'willChange',
    ])
  })

  it('returns [] when every set property is curated', () => {
    expect(getCustomProperties({ fontSize: '16px', color: 'red' })).toEqual([])
  })

  it('a curated property never leaks into custom even if also set elsewhere', () => {
    // borderTopWidth is owned by the Border control; must not appear in custom.
    const styles = { borderTopWidth: '2px', gridAutoFlow: 'dense' }
    expect(getCustomProperties(styles)).toEqual(['gridAutoFlow'])
  })
})
