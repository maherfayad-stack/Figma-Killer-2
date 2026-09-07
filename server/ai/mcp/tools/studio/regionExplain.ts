/**
 * regionExplain — turns `studio_compare`'s differing rectangles from
 * geometry into a sentence with names in it (W9-3, strict teeth).
 *
 * ## The gap this closes
 *
 * A failing compare already answers "where": a rectangle, its differing-pixel
 * count, and the node ids inside it. What it never answered is "what is wrong
 * there", and the agent's only route to that was to look at the picture and
 * guess — which is the subjective judgement the whole measurement loop exists
 * to replace. Worse, the two most common causes look identical in a region
 * rectangle: a colour that is simply the wrong token, and a layout that has
 * shifted. The first is a one-line fix, the second is not, and guessing wrong
 * costs a whole verification round trip.
 *
 * So for each region this reads the DOMINANT colour on both sides —
 * the design's and the screen's — and names them:
 *
 *   "The design fills this rectangle with #EF4550, which is the design
 *    variable `coral/100`; your screen renders #3B82F6 there, which is
 *    `var(--color-primary)`. In this project `coral/100` is
 *    `var(--color-danger)`."
 *
 * That is the difference between "region 0 is 71% different" and a fix the
 * agent can make without looking at anything.
 *
 * ## Where it deliberately says nothing
 *
 * When both sides' dominant colours are within `COLOR_DIFFERENCE_THRESHOLD`
 * of each other, this returns `undefined` for that region. A region whose
 * fills agree is differing for some other reason — text, spacing, a moved
 * element — and inventing a colour sentence for it would send the agent to
 * recolour something that is already the right colour. Naming nothing is the
 * correct output when there is nothing to name; every field here is omitted
 * rather than guessed.
 *
 * ## Cost
 *
 * Sampling is strided and capped per region (`MAX_SAMPLED_PIXELS_PER_REGION`),
 * so a full-frame region costs the same as a small one. The colour counting
 * itself is `referenceMeasure.ts`'s own `countColors` — the same quantise-then-
 * pick-the-modal-exact-value implementation `studio_measure_reference`
 * reports colours with, not a second one that could disagree with it about
 * what "the dominant colour" means.
 */
import { colorDifference, rgbToHex, type Rgb } from '@core/design-tokens'
import { countColors } from '../../../../handlers/studio/referenceMeasure'
import {
  nearestDesignVariableColor,
  type DesignVariableIndex,
} from '../../../../handlers/studio/designVariableIndex'
import type { ColorTokenEntry, ProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import type { DecodedImage, DiffRegion, Rect } from './frameDiffEngine'

/**
 * ΔE below which the two sides' dominant colours are "the same colour" and
 * this module stays silent. Deliberately the same value the project-token and
 * design-variable matchers already call "close enough"
 * (`DESIGN_VARIABLE_COLOR_MATCH_MAX_DELTA_E`): if a difference is too small
 * to change which token a colour maps to, it is too small to report as a
 * colour defect.
 */
const COLOR_DIFFERENCE_THRESHOLD = 5
/** Per region, per side. A stride keeps a full-frame region as cheap as a small one; a few thousand samples settle the modal colour of a flat UI fill immediately. */
const MAX_SAMPLED_PIXELS_PER_REGION = 20000
/** Explaining every region of a 20-region result is payload the agent will not read. The worst few are the work list. */
const MAX_EXPLAINED_REGIONS = 5

/** What the design has here and what the screen has here, each named as far as the project's own vocabulary allows. */
export interface RegionColorExplanation {
  /** The design's dominant colour in this rectangle. */
  readonly referenceHex: string
  /** The screen's dominant colour in the same rectangle. */
  readonly currentHex: string
  /** The design variable the reference colour IS, when the design's own variable table has one within range. */
  readonly referenceVariable?: { readonly name: string; readonly hex: string }
  /** The project token that carries the reference colour — the one that SHOULD have been written. */
  readonly referenceToken?: { readonly name: string; readonly hex: string }
  /** The project token the screen's colour matches — what was actually written. */
  readonly currentToken?: { readonly name: string; readonly hex: string }
  /** The sentence, assembled from whichever of the above resolved. Always present. */
  readonly message: string
}

export interface ExplainedDiffRegion extends DiffRegion {
  readonly colorExplanation?: RegionColorExplanation
}

/** The vocabulary a region can be explained in. Both halves are optional: with neither, an explanation is still two hex values, which already beats nothing. */
export interface RegionExplainVocabulary {
  readonly designVariables?: DesignVariableIndex
  readonly projectTokens?: ProjectTokenIndex
}

function nearestToken(tokens: readonly ColorTokenEntry[] | undefined, rgb: Rgb): { name: string; hex: string } | undefined {
  if (!tokens || tokens.length === 0) return undefined
  let best: { name: string; hex: string; deltaE: number } | undefined
  for (const token of tokens) {
    const deltaE = colorDifference(rgb, token.rgb)
    if (best === undefined || deltaE < best.deltaE) best = { name: token.name, hex: token.hex, deltaE }
  }
  if (!best || best.deltaE > COLOR_DIFFERENCE_THRESHOLD) return undefined
  return { name: best.name, hex: best.hex }
}

/**
 * The dominant colour inside `rect`, or `undefined` when the rectangle holds
 * no opaque pixels at all (`countColors` skips transparent ones, and a fully
 * transparent region has no colour to name).
 */
function dominantColorIn(image: DecodedImage, rect: Rect): Rgb | undefined {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height))
  const width = x1 - x0
  const height = y1 - y0
  if (width <= 0 || height <= 0) return undefined

  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLED_PIXELS_PER_REGION)))
  const cols = Math.ceil(width / stride)
  const rows = Math.ceil(height / stride)
  const sampled = Buffer.allocUnsafe(cols * rows * 4)

  let out = 0
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * image.width + x) * 4
      sampled[out] = image.data[i]!
      sampled[out + 1] = image.data[i + 1]!
      sampled[out + 2] = image.data[i + 2]!
      sampled[out + 3] = image.data[i + 3]!
      out += 4
    }
  }

  return countColors(sampled.subarray(0, out), 4)[0]?.rgb
}

function buildMessage(explanation: Omit<RegionColorExplanation, 'message'>): string {
  const design = explanation.referenceVariable
    ? `${explanation.referenceHex}, which is the design variable \`${explanation.referenceVariable.name}\``
    : explanation.referenceHex
  const current = explanation.currentToken
    ? `${explanation.currentHex}, which is \`var(${explanation.currentToken.name})\``
    : explanation.currentHex
  const fix = explanation.referenceToken
    ? ` The project token that carries the design's colour is \`var(${explanation.referenceToken.name})\` (${explanation.referenceToken.hex}) — that is what belongs here.`
    : explanation.referenceVariable
      ? ` No project token carries \`${explanation.referenceVariable.name}\` yet, so this colour has no var() to swap to — add the token rather than writing the hex.`
      : ' Neither colour maps to a token this project declares, so this is a raw-value difference.'
  return `The design fills this rectangle with ${design}; your screen renders ${current}.${fix} If this region also moved or resized, fix the colour and re-measure — a wrong fill and a wrong position look identical in a rectangle.`
}

/**
 * Explain each region's colour difference, worst-first, capped.
 *
 * The two images must already be the same size and aligned — the same
 * invariant `computeFrameDiff` requires, since the regions being explained
 * are in exactly that shared pixel space. `regions` is returned unchanged
 * apart from the added `colorExplanation`, so a caller can hand this straight
 * back to the payload it was already building.
 */
export function explainRegionColors(
  baseline: DecodedImage,
  reference: DecodedImage,
  regions: readonly DiffRegion[],
  vocabulary: RegionExplainVocabulary,
): ExplainedDiffRegion[] {
  return regions.map((region, index) => {
    if (index >= MAX_EXPLAINED_REGIONS) return region
    const referenceRgb = dominantColorIn(reference, region)
    const currentRgb = dominantColorIn(baseline, region)
    if (!referenceRgb || !currentRgb) return region
    // The fills agree — whatever is wrong here is not the colour. Saying so
    // wrongly would send the agent to recolour something already correct.
    if (colorDifference(referenceRgb, currentRgb) <= COLOR_DIFFERENCE_THRESHOLD) return region

    const referenceVariable = vocabulary.designVariables
      ? nearestDesignVariableColor(vocabulary.designVariables.colors, referenceRgb)
      : undefined
    // The project token is resolved from the design VARIABLE's own declared
    // value when there is one, and from the measured pixel otherwise — the
    // same preference `referenceMeasure.ts` applies, for the same reason: a
    // declared value is exact where a rasterised pixel is noisy.
    const referenceTokenSource = referenceVariable?.variable.rgb ?? referenceRgb
    const partial: Omit<RegionColorExplanation, 'message'> = {
      referenceHex: rgbToHex(referenceRgb),
      currentHex: rgbToHex(currentRgb),
      ...(referenceVariable ? { referenceVariable: { name: referenceVariable.variable.name, hex: referenceVariable.variable.hex } } : {}),
      ...(nearestToken(vocabulary.projectTokens?.colors, referenceTokenSource)
        ? { referenceToken: nearestToken(vocabulary.projectTokens?.colors, referenceTokenSource)! }
        : {}),
      ...(nearestToken(vocabulary.projectTokens?.colors, currentRgb)
        ? { currentToken: nearestToken(vocabulary.projectTokens?.colors, currentRgb)! }
        : {}),
    }
    return { ...region, colorExplanation: { ...partial, message: buildMessage(partial) } }
  })
}
