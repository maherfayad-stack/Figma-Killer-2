/**
 * imageFillValue — the pure model behind the Fill section's image layers.
 *
 * The two facts worth pinning:
 *   1. WHICH URL gets written, and whether it survives a production build.
 *      Getting this wrong writes a background that works on the user's dev
 *      server and 404s after they deploy.
 *   2. That Fit and the 9-grid are EXACT round-trips of the CSS satellites —
 *      a value they cannot express must read as "custom"/no-selection, never
 *      be snapped to the nearest preset.
 */
import { describe, expect, it } from 'bun:test'
import {
  assetPathForCssUrl,
  cssUrlForAssetPath,
  fitFromSatellites,
  imageFillFileName,
  IMAGE_FILL_FIT_SATELLITES,
  positionCellFor,
} from '../imageFillValue'

describe('cssUrlForAssetPath', () => {
  it('serves a public-root file from the site root and marks it build-safe', () => {
    expect(cssUrlForAssetPath('public/hero.png')).toEqual({ url: '/hero.png', buildSafe: true })
    expect(cssUrlForAssetPath('public/img/nested/hero.png')).toEqual({
      url: '/img/nested/hero.png',
      buildSafe: true,
    })
  })

  it('recognises the `static/` public-root spelling too', () => {
    expect(cssUrlForAssetPath('static/hero.png')).toEqual({ url: '/hero.png', buildSafe: true })
  })

  it('still produces a URL for a bundled asset, but flags it as not build-safe', () => {
    // `src/assets/EN-2.png` is reached through an `import` in the user's code
    // (studio-workspace/test4). A dev server serves it at this path; a
    // production build does not, and the picker must SAY that.
    expect(cssUrlForAssetPath('src/assets/EN-2.png')).toEqual({
      url: '/src/assets/EN-2.png',
      buildSafe: false,
    })
  })

  it('never emits a doubled leading slash', () => {
    expect(cssUrlForAssetPath('/public/hero.png').url).toBe('/hero.png')
  })
})

describe('assetPathForCssUrl', () => {
  const assets = ['public/hero.png', 'src/assets/EN-2.png']

  it('resolves a written URL back through the KNOWN asset list, not a guess', () => {
    expect(assetPathForCssUrl('/hero.png', assets)).toBe('public/hero.png')
    expect(assetPathForCssUrl('/src/assets/EN-2.png', assets)).toBe('src/assets/EN-2.png')
  })

  it('returns undefined for a URL no file in the project backs', () => {
    expect(assetPathForCssUrl('/missing.png', assets)).toBeUndefined()
    expect(assetPathForCssUrl('https://cdn.example.com/a.png', assets)).toBeUndefined()
  })
})

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
