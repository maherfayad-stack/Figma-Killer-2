/**
 * backgroundLayers — the `background-image` layer stack
 * (docs/features/inspector-disclosure.md §4 G6.5).
 *
 * The contract under test is the one that makes the Fill section honest:
 * a value is only restructured into rows when parse → serialise reproduces it
 * BYTE-FOR-BYTE; everything else keeps its raw text and a named reason. These
 * cases are real-world shapes — multiple gradients, `url()` beside a gradient,
 * `none`, a colour with no image at all, and satellite lists whose length does
 * not match the layer count (CSS's repetition rules).
 */
import { describe, expect, it } from 'bun:test'
import {
  BACKGROUND_SATELLITE_PROPS,
  backgroundLayerSatellite,
  backgroundModelPatch,
  insertBackgroundLayer,
  isBackgroundModelEmpty,
  moveBackgroundLayer,
  parseBackgroundLayers,
  removeBackgroundLayer,
  setBackgroundLayerImage,
  setBackgroundLayerSatellite,
} from '../backgroundLayers'

const GRADIENT_A = 'linear-gradient(180deg, #000000 0%, #ffffff 100%)'
const GRADIENT_B = 'radial-gradient(circle, #ff0000 0%, #0000ff 100%)'
const URL_LAYER = "url('/images/hero.png')"

function layersOf(styles: Record<string, unknown>): readonly string[] {
  const model = parseBackgroundLayers(styles)
  return model.spine.kind === 'layers' ? model.spine.layers : []
}

// ---------------------------------------------------------------------------
// Parsing the spine
// ---------------------------------------------------------------------------

describe('parseBackgroundLayers — the layer list', () => {
  it('treats an absent background-image as empty', () => {
    const model = parseBackgroundLayers({})
    expect(model.spine.kind).toBe('none')
    expect(isBackgroundModelEmpty(model)).toBe(true)
  })

  it('treats `none` as empty, not as a one-layer list', () => {
    const model = parseBackgroundLayers({ backgroundImage: 'none' })
    expect(model.spine.kind).toBe('none')
    expect(isBackgroundModelEmpty(model)).toBe(true)
  })

  it('a colour-only background is empty as far as LAYERS go', () => {
    const model = parseBackgroundLayers({ backgroundColor: '#ff0000' })
    expect(model.spine.kind).toBe('none')
    expect(isBackgroundModelEmpty(model)).toBe(true)
  })

  it('splits two gradients into two layers, first = topmost', () => {
    expect(layersOf({ backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}` })).toEqual([GRADIENT_A, GRADIENT_B])
  })

  it('splits a url() beside a gradient without tripping on the url quoting', () => {
    expect(layersOf({ backgroundImage: `${URL_LAYER}, ${GRADIENT_A}` })).toEqual([URL_LAYER, GRADIENT_A])
  })

  it('does not split on a comma inside a quoted url()', () => {
    const value = 'url("/img/a,b.png")'
    expect(layersOf({ backgroundImage: value })).toEqual([value])
  })

  it('keeps a per-layer `none` — it is a real, empty layer', () => {
    expect(layersOf({ backgroundImage: `${URL_LAYER}, none` })).toEqual([URL_LAYER, 'none'])
  })
})

describe('parseBackgroundLayers — refusals', () => {
  function refusal(value: string) {
    const model = parseBackgroundLayers({ backgroundImage: value })
    expect(model.spine.kind).toBe('raw')
    return model.spine.kind === 'raw' ? model.spine : null
  }

  it('refuses a top-level var(): it could expand to any number of layers', () => {
    const spine = refusal('var(--page-background)')
    expect(spine?.raw).toBe('var(--page-background)')
    expect(spine?.reason).toContain('var()')
  })

  it('accepts a var() NESTED inside a gradient — it cannot add layers', () => {
    const value = 'linear-gradient(var(--from), var(--to))'
    expect(layersOf({ backgroundImage: value })).toEqual([value])
  })

  it('refuses unbalanced parentheses', () => {
    expect(refusal('linear-gradient(red, blue')).not.toBeNull()
  })

  it('refuses an empty comma segment', () => {
    expect(refusal(`${GRADIENT_A}, , ${GRADIENT_B}`)).not.toBeNull()
  })

  it('refuses a value it could not re-join byte-for-byte', () => {
    const spine = refusal(`${GRADIENT_A},${GRADIENT_B}`)
    expect(spine?.reason).toContain('reformatted')
  })
})

// ---------------------------------------------------------------------------
// Serialisation — the byte-identical round trip
// ---------------------------------------------------------------------------

describe('backgroundModelPatch — round trip', () => {
  it('reproduces a multi-layer value with its satellites exactly', () => {
    const styles = {
      backgroundImage: `${URL_LAYER}, ${GRADIENT_A}`,
      backgroundSize: 'cover, 100% 50%',
      backgroundRepeat: 'no-repeat',
      backgroundBlendMode: 'multiply, normal',
    }
    const patch = backgroundModelPatch(parseBackgroundLayers(styles))
    expect(patch.backgroundImage).toBe(styles.backgroundImage)
    expect(patch.backgroundSize).toBe(styles.backgroundSize)
    expect(patch.backgroundRepeat).toBe(styles.backgroundRepeat)
    expect(patch.backgroundBlendMode).toBe(styles.backgroundBlendMode)
  })

  it('hands a refused value straight back, unchanged', () => {
    const raw = 'var(--layers)'
    expect(backgroundModelPatch(parseBackgroundLayers({ backgroundImage: raw })).backgroundImage).toBe(raw)
  })

  it('clears every property it owns when nothing is set', () => {
    const patch = backgroundModelPatch(parseBackgroundLayers({}))
    expect(patch.backgroundImage).toBeUndefined()
    for (const prop of BACKGROUND_SATELLITE_PROPS) expect(patch[prop]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Satellites — CSS's repetition rules
// ---------------------------------------------------------------------------

describe('backgroundLayerSatellite — repetition rules', () => {
  const threeLayers = { backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}, ${URL_LAYER}` }

  it('repeats a shorter list cyclically and flags it as shared', () => {
    const model = parseBackgroundLayers({ ...threeLayers, backgroundSize: 'cover, contain' })
    expect(backgroundLayerSatellite(model, 'backgroundSize', 0)).toEqual({ kind: 'value', value: 'cover', shared: true })
    expect(backgroundLayerSatellite(model, 'backgroundSize', 1)).toEqual({ kind: 'value', value: 'contain', shared: true })
    // layer 3 wraps back to the first value, exactly as the browser does
    expect(backgroundLayerSatellite(model, 'backgroundSize', 2)).toEqual({ kind: 'value', value: 'cover', shared: true })
  })

  it('is not shared when the list already has one value per layer', () => {
    const model = parseBackgroundLayers({ ...threeLayers, backgroundSize: 'cover, contain, auto' })
    expect(backgroundLayerSatellite(model, 'backgroundSize', 1)).toEqual({
      kind: 'value',
      value: 'contain',
      shared: false,
    })
  })

  it('refuses per-layer editing when a satellite has MORE values than layers', () => {
    const model = parseBackgroundLayers({ backgroundImage: GRADIENT_A, backgroundSize: 'cover, contain' })
    const view = backgroundLayerSatellite(model, 'backgroundSize', 0)
    expect(view.kind).toBe('raw')
    expect(view.kind === 'raw' && view.reason).toContain('more values than there are background layers')
    // …and the refused value still serialises back untouched.
    expect(backgroundModelPatch(model).backgroundSize).toBe('cover, contain')
  })

  it('reports an unset satellite as unset, not as its initial', () => {
    const model = parseBackgroundLayers(threeLayers)
    expect(backgroundLayerSatellite(model, 'backgroundRepeat', 0)).toEqual({ kind: 'unset' })
  })
})

describe('setBackgroundLayerSatellite', () => {
  const twoLayers = { backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}` }

  it('expands to one value per layer when writing the first time', () => {
    const next = setBackgroundLayerSatellite(parseBackgroundLayers(twoLayers), 'backgroundSize', 1, 'cover')
    // layer 1 keeps the CSS initial so its rendering does not change
    expect(backgroundModelPatch(next).backgroundSize).toBe('auto, cover')
  })

  it('collapses to a single value when every layer agrees', () => {
    const model = parseBackgroundLayers({ ...twoLayers, backgroundSize: 'cover, contain' })
    const next = setBackgroundLayerSatellite(model, 'backgroundSize', 1, 'cover')
    expect(backgroundModelPatch(next).backgroundSize).toBe('cover')
  })

  it('clears the declaration once every layer is back at the CSS initial', () => {
    const model = parseBackgroundLayers({ ...twoLayers, backgroundSize: 'cover, auto' })
    const next = setBackgroundLayerSatellite(model, 'backgroundSize', 0, undefined)
    expect(backgroundModelPatch(next).backgroundSize).toBeUndefined()
  })

  it('never writes per layer into a refused satellite', () => {
    const model = parseBackgroundLayers({ backgroundImage: GRADIENT_A, backgroundSize: 'cover, contain' })
    const next = setBackgroundLayerSatellite(model, 'backgroundSize', 0, 'auto')
    expect(backgroundModelPatch(next).backgroundSize).toBe('cover, contain')
  })
})

// ---------------------------------------------------------------------------
// Structural edits
// ---------------------------------------------------------------------------

describe('insertBackgroundLayer', () => {
  it('adds the first layer to an element that had none', () => {
    const next = insertBackgroundLayer(parseBackgroundLayers({}), 0, GRADIENT_A)
    expect(backgroundModelPatch(next).backgroundImage).toBe(GRADIENT_A)
  })

  it('prepends at index 0 — a new fill lands on TOP, as in Figma', () => {
    const next = insertBackgroundLayer(parseBackgroundLayers({ backgroundImage: GRADIENT_B }), 0, GRADIENT_A)
    expect(backgroundModelPatch(next).backgroundImage).toBe(`${GRADIENT_A}, ${GRADIENT_B}`)
  })

  it('gives the new layer the CSS initial of each per-layer satellite', () => {
    const model = parseBackgroundLayers({
      backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}`,
      backgroundSize: 'cover, contain',
    })
    const patch = backgroundModelPatch(insertBackgroundLayer(model, 0, URL_LAYER))
    expect(patch.backgroundImage).toBe(`${URL_LAYER}, ${GRADIENT_A}, ${GRADIENT_B}`)
    expect(patch.backgroundSize).toBe('auto, cover, contain')
  })

  it('leaves a one-value satellite alone — it already applies to every layer', () => {
    const model = parseBackgroundLayers({ backgroundImage: GRADIENT_A, backgroundSize: 'cover' })
    expect(backgroundModelPatch(insertBackgroundLayer(model, 0, URL_LAYER)).backgroundSize).toBe('cover')
  })

  it('refuses to insert into a layer list it could not parse', () => {
    const model = parseBackgroundLayers({ backgroundImage: 'var(--layers)' })
    expect(backgroundModelPatch(insertBackgroundLayer(model, 0, GRADIENT_A)).backgroundImage).toBe('var(--layers)')
  })
})

describe('removeBackgroundLayer', () => {
  it('drops the layer and its satellite value together', () => {
    const model = parseBackgroundLayers({
      backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}`,
      backgroundSize: 'cover, contain',
    })
    const patch = backgroundModelPatch(removeBackgroundLayer(model, 0))
    expect(patch.backgroundImage).toBe(GRADIENT_B)
    expect(patch.backgroundSize).toBe('contain')
  })

  it('clears every satellite when the last layer goes', () => {
    const model = parseBackgroundLayers({
      backgroundImage: GRADIENT_A,
      backgroundSize: 'cover',
      backgroundBlendMode: 'multiply',
    })
    const patch = backgroundModelPatch(removeBackgroundLayer(model, 0))
    expect(patch.backgroundImage).toBeUndefined()
    for (const prop of BACKGROUND_SATELLITE_PROPS) expect(patch[prop]).toBeUndefined()
  })

  it('is a no-op for an out-of-range index', () => {
    const model = parseBackgroundLayers({ backgroundImage: GRADIENT_A })
    expect(backgroundModelPatch(removeBackgroundLayer(model, 4)).backgroundImage).toBe(GRADIENT_A)
  })
})

describe('moveBackgroundLayer', () => {
  it('reorders the layers and carries their satellites along', () => {
    const model = parseBackgroundLayers({
      backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}, ${URL_LAYER}`,
      backgroundSize: 'cover, contain, auto',
    })
    const patch = backgroundModelPatch(moveBackgroundLayer(model, 2, 0))
    expect(patch.backgroundImage).toBe(`${URL_LAYER}, ${GRADIENT_A}, ${GRADIENT_B}`)
    expect(patch.backgroundSize).toBe('auto, cover, contain')
  })

  it('is a no-op when the endpoints are the same', () => {
    const model = parseBackgroundLayers({ backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}` })
    expect(backgroundModelPatch(moveBackgroundLayer(model, 1, 1)).backgroundImage).toBe(
      `${GRADIENT_A}, ${GRADIENT_B}`,
    )
  })
})

describe('setBackgroundLayerImage', () => {
  it('replaces one layer, leaving the rest byte-identical', () => {
    const model = parseBackgroundLayers({ backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}` })
    expect(backgroundModelPatch(setBackgroundLayerImage(model, 1, URL_LAYER)).backgroundImage).toBe(
      `${GRADIENT_A}, ${URL_LAYER}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Satellites with no layer to apply to
// ---------------------------------------------------------------------------

describe('orphan satellites', () => {
  it('are kept, not dropped, when there is no background-image', () => {
    const model = parseBackgroundLayers({ backgroundSize: 'cover' })
    expect(model.spine.kind).toBe('none')
    expect(isBackgroundModelEmpty(model)).toBe(false)
    expect(backgroundModelPatch(model).backgroundSize).toBe('cover')
  })

  it('survive untouched when the first layer is added', () => {
    const model = parseBackgroundLayers({ backgroundSize: 'cover, contain' })
    expect(backgroundModelPatch(insertBackgroundLayer(model, 0, GRADIENT_A)).backgroundSize).toBe('cover, contain')
  })
})

// ---------------------------------------------------------------------------
// The image-fill shape: a `url()` layer carrying size / position / repeat
// ---------------------------------------------------------------------------

describe('a url() image layer with its own size, position and repeat', () => {
  const stored = {
    backgroundImage: `${URL_LAYER}, ${GRADIENT_A}`,
    backgroundSize: 'cover, auto',
    backgroundPosition: 'center center, 0% 0%',
    backgroundRepeat: 'no-repeat, repeat',
  }

  it('parses into two layers whose satellites stay aligned to their own layer', () => {
    const model = parseBackgroundLayers(stored)
    expect(layersOf(stored)).toEqual([URL_LAYER, GRADIENT_A])
    expect(backgroundLayerSatellite(model, 'backgroundSize', 0)).toEqual({
      kind: 'value',
      value: 'cover',
      shared: false,
    })
    expect(backgroundLayerSatellite(model, 'backgroundPosition', 0)).toEqual({
      kind: 'value',
      value: 'center center',
      shared: false,
    })
    expect(backgroundLayerSatellite(model, 'backgroundRepeat', 1)).toEqual({
      kind: 'value',
      value: 'repeat',
      shared: false,
    })
  })

  it('serialises back byte-for-byte', () => {
    const patch = backgroundModelPatch(parseBackgroundLayers(stored))
    expect(patch.backgroundImage).toBe(stored.backgroundImage)
    expect(patch.backgroundSize).toBe(stored.backgroundSize)
    expect(patch.backgroundPosition).toBe(stored.backgroundPosition)
    expect(patch.backgroundRepeat).toBe(stored.backgroundRepeat)
  })

  it('writes a fit change to ONLY the image layer, leaving the gradient at its own values', () => {
    let model = parseBackgroundLayers(stored)
    model = setBackgroundLayerSatellite(model, 'backgroundSize', 0, 'contain')
    model = setBackgroundLayerSatellite(model, 'backgroundRepeat', 0, 'no-repeat')
    const patch = backgroundModelPatch(model)
    expect(patch.backgroundSize).toBe('contain, auto')
    expect(patch.backgroundRepeat).toBe('no-repeat, repeat')
    expect(patch.backgroundImage).toBe(stored.backgroundImage)
  })

  it('writes a 9-grid position to ONLY the image layer', () => {
    const model = setBackgroundLayerSatellite(
      parseBackgroundLayers(stored),
      'backgroundPosition',
      0,
      'right bottom',
    )
    expect(backgroundModelPatch(model).backgroundPosition).toBe('right bottom, 0% 0%')
  })

  it('drops the whole declaration when every layer is back at the CSS initial', () => {
    let model = parseBackgroundLayers({
      backgroundImage: URL_LAYER,
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
    })
    // Picking "Tile" writes the initial pair, which collapses to no declaration
    // at all rather than leaving `auto` / `repeat` behind in the user's file.
    model = setBackgroundLayerSatellite(model, 'backgroundSize', 0, 'auto')
    model = setBackgroundLayerSatellite(model, 'backgroundRepeat', 0, 'repeat')
    const patch = backgroundModelPatch(model)
    expect(patch.backgroundSize).toBeUndefined()
    expect(patch.backgroundRepeat).toBeUndefined()
    expect(patch.backgroundImage).toBe(URL_LAYER)
  })

  it('inserts an image layer at the top of an existing stack, satellites shifting with it', () => {
    const model = parseBackgroundLayers({
      backgroundImage: `${GRADIENT_A}, ${GRADIENT_B}`,
      backgroundSize: 'cover, contain',
    })
    const patch = backgroundModelPatch(insertBackgroundLayer(model, 0, URL_LAYER))
    expect(patch.backgroundImage).toBe(`${URL_LAYER}, ${GRADIENT_A}, ${GRADIENT_B}`)
    expect(patch.backgroundSize).toBe('auto, cover, contain')
  })
})
