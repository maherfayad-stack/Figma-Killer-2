/**
 * imageFillValue — the pure model behind the Fill section's image layers.
 *
 * The fact worth pinning: Fit and the 9-grid are EXACT round-trips of the
 * CSS satellites — a value they cannot express must read as
 * "custom"/no-selection, never be snapped to the nearest preset.
 *
 * WHICH URL gets written is no longer decided here: the server's
 * `assetSiteUrl.ts` owns that rule (`server/handlers/__tests__/
 * assetSiteUrl.test.ts`), and the picker writes the `src` it returns.
 */
import { describe, expect, it } from 'bun:test'
import {
  fitFromSatellites,
  imageFillFileName,
  IMAGE_FILL_FIT_SATELLITES,
  positionCellFor,
} from '../imageFillValue'

describe('imageFillFileName', () => {
  it('takes the last segment and drops the query string', () => {
    expect(imageFillFileName('/img/hero.png')).toBe('hero.png')
    expect(imageFillFileName('https://cdn.example.com/a/b/hero.png?v=2')).toBe('hero.png')
  })
})

describe('fitFromSatellites', () => {
  it('reads each named fit back out of its own satellite pair', () => {
    for (const [fit, pair] of Object.entries(IMAGE_FILL_FIT_SATELLITES)) {
      expect(fitFromSatellites(pair.backgroundSize, pair.backgroundRepeat)).toBe(fit)
    }
  })

  it('reads an UNSET pair as tile — that is what the browser is actually doing', () => {
    expect(fitFromSatellites('', '')).toBe('tile')
  })

  it('reads a pair it cannot express as custom rather than snapping to a preset', () => {
    expect(fitFromSatellites('60% auto', 'no-repeat')).toBe('custom')
    expect(fitFromSatellites('cover', 'repeat-x')).toBe('custom')
  })
})

describe('positionCellFor', () => {
  it('matches the keyword pairs the grid draws', () => {
    expect(positionCellFor('left top')).toBe('left top')
    expect(positionCellFor('right bottom')).toBe('right bottom')
  })

  it('accepts the percentage spellings CSS treats as identical', () => {
    expect(positionCellFor('50% 50%')).toBe('center center')
    expect(positionCellFor('0% 100%')).toBe('left bottom')
  })

  it('defaults a single value to a centred vertical axis, as CSS does', () => {
    expect(positionCellFor('center')).toBe('center center')
    expect(positionCellFor('left')).toBe('left center')
  })

  it('selects NOTHING for a position the grid cannot express', () => {
    expect(positionCellFor('12px 40%')).toBeUndefined()
    expect(positionCellFor('right 12px bottom 4px')).toBeUndefined()
    expect(positionCellFor('')).toBeUndefined()
  })
})
