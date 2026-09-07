/**
 * compareGrading — "what bar is this page held to, and did it clear it".
 *
 * Split out of `compare.ts` (W9-2), which owns the other question entirely:
 * capture routing, the verdict cache, batching, and payload assembly. Grading
 * became its own responsibility the moment the bar stopped being two module
 * constants — the mode is resolved PER PAGE (a design reference can declare
 * its own), it carries a third threshold that only strict applies, and it
 * produces the sentence the agent actually reads. None of that is about
 * getting pixels.
 *
 * Everything here is pure: no capture, no filesystem, no cache. `compare.ts`
 * hands in the resolved reference and the finished diff.
 */
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'
import {
  FIDELITY_THRESHOLDS,
  resolveFidelityMode,
  scaledMaxRegionPixels,
  type FidelityMode,
} from '../../../../handlers/studio/fidelityMode'
import type { FrameDiffResult } from './frameDiffEngine'
import type { ResolveReferenceResult } from './referenceResolve'

/**
 * One page's grading bar: the resolved fidelity mode and the numbers it
 * produced, after any explicit `passScore`/`maxRegionCoverage` argument has
 * overridden the mode's own. An explicit number always wins — a caller who
 * names 97 means 97 — but naming a number does NOT change the mode, so
 * strict's absolute area floor still applies to a strict call that also
 * pinned a score.
 */
export interface PageGrading {
  readonly mode: FidelityMode
  readonly requiredScore: number
  readonly coverageLimit: number
  /** At 1x. Scaled to the comparison's own resolution at the point of use — see `gradeFrameDiff`. */
  readonly maxRegionPixelsAt1x: number | null
}

export function resolveGrading(
  mode: FidelityMode,
  passScore: number | undefined,
  maxRegionCoverage: number | undefined,
): PageGrading {
  const t = FIDELITY_THRESHOLDS[mode]
  return {
    mode,
    requiredScore: passScore ?? t.passScore,
    coverageLimit: maxRegionCoverage ?? t.maxRegionCoverage,
    maxRegionPixelsAt1x: t.maxRegionPixels,
  }
}

/**
 * The mode for ONE page, plus strict's refusal of the project-wide fallback.
 *
 * Per page, not per call, because tier 2 of `resolveFidelityMode` is the
 * resolved reference's own `mode`: two screens in one batch can legitimately
 * be graded differently because their designs were registered differently.
 * `referenceArmed: true` is a statement of fact here — the caller is holding
 * the reference.
 *
 * The refusal exists because a reference with no page scope, picked up
 * implicitly, is Studio's GUESS that this design is probably about this
 * screen. That is a good guess for `balanced` and exactly the wrong thing to
 * build a 99%-similarity verdict on. (The ambiguous-page case
 * `resolveDesignReference` already refuses, for every mode.)
 */
export function resolvePageGrading(params: {
  readonly pageTitle: string
  readonly pageId: string
  readonly resolved: Extract<ResolveReferenceResult, { ok: true }>
  readonly toolArg?: FidelityMode
  readonly turn?: FidelityMode
  readonly project?: FidelityMode
  readonly passScore?: number
  readonly maxRegionCoverage?: number
}): { ok: true; grading: PageGrading } | { ok: false; error: string } {
  const { pageTitle, pageId, resolved } = params
  const mode = resolveFidelityMode({
    toolArg: params.toolArg,
    reference: resolved.reference.mode,
    turn: params.turn,
    project: params.project,
    referenceArmed: true,
  }).mode

  if (mode === 'strict' && resolved.implicit && resolved.reference.pageId === undefined) {
    return { ok: false, error: strictStandInRefusal(pageTitle, pageId, resolved.reference) }
  }
  return { ok: true, grading: resolveGrading(mode, params.passScore, params.maxRegionCoverage) }
}

function strictStandInRefusal(pageTitle: string, pageId: string, reference: DesignReference): string {
  const label = reference.label ? ` "${reference.label}"` : ''
  return `Strict fidelity will not grade "${pageTitle}" against a reference that was not registered for it. ${reference.id} (${reference.width}x${reference.height}${label}) has no page scope, so it is standing in for this screen rather than being its design — and a 99%-similarity verdict against a stand-in is a confident wrong number. Register this screen's own design (studio_register_design_reference with pageId:"${pageId}"), or pass referenceId to say that this one really is its design. Lowering fidelityMode to get past this is not the fix.`
}

export interface GradedDiff {
  readonly pass: boolean
  readonly verdict: string
  readonly structuralRegions: FrameDiffResult['regions']
  /** The area floor in THIS diff's pixels, or `null` when the mode has none (or the scale was unknown). Reported back so the agent sees the bar it was actually held to. */
  readonly regionPixelLimit: number | null
}

/**
 * The verdict, from a finished diff and this page's bar.
 *
 * `authoredFrameWidth` is the board frame's CSS width and the diff ran at the
 * reference's resolution, so `diff.width / authoredWidth` is px-per-CSS-px for
 * this comparison — which is what the 1x area floor has to be scaled by. An
 * unknown frame width passes `NaN` and `scaledMaxRegionPixels` drops the floor
 * rather than guessing 1x, which would fail every region on a retina diff.
 */
export function gradeFrameDiff(
  diff: FrameDiffResult,
  grading: PageGrading,
  authoredWidth: number | null,
): GradedDiff {
  const { mode, requiredScore, coverageLimit } = grading
  const diffScale = authoredWidth && authoredWidth > 0 ? diff.width / authoredWidth : Number.NaN
  const regionPixelLimit = scaledMaxRegionPixels(FIDELITY_THRESHOLDS[mode], diffScale)

  const overCoverage = diff.regions.filter((r) => r.frameCoveragePercent > coverageLimit)
  // Small, entirely-wrong elements: a 24x24 icon is 0.02% of a tall frame and
  // sails past the coverage test. This is the test that catches it, and it
  // exists only in strict.
  const overArea = regionPixelLimit === null
    ? []
    : diff.regions.filter((r) => r.width * r.height > regionPixelLimit && r.frameCoveragePercent <= coverageLimit)
  const structuralRegions = [...overCoverage, ...overArea]
  const pass = diff.similarityScore >= requiredScore && structuralRegions.length === 0

  const areaNote = overArea.length > 0
    ? ` ${overArea.length} of them are small but entirely wrong — under the ${coverageLimit}%-of-frame ceiling yet over strict's ~${FIDELITY_THRESHOLDS[mode].maxRegionPixels}px² (at 1x) area floor, which is what an icon or a label rendered wrong looks like.`
    : ''
  const score = diff.similarityScore.toFixed(2)
  const verdict = pass
    ? `Matches the reference at ${mode} fidelity: ${score}% similar (needs ${requiredScore}%), no structural differences. Remaining differences are below the ${coverageLimit}%-of-frame floor${regionPixelLimit === null ? '' : ' and the area floor'} — that is text rasterisation, not design.`
    : diff.similarityScore < requiredScore && structuralRegions.length > 0
      ? `Does NOT match at ${mode} fidelity: ${score}% similar (needs ${requiredScore}%), and ${structuralRegions.length} region(s) are large enough to be structural.${areaNote} Fix the largest region first — it is listed first in regions[] with the node ids it covers — then measure again.`
      : structuralRegions.length > 0
        ? `Does NOT match at ${mode} fidelity: overall similarity is fine (${score}%) but ${structuralRegions.length} region(s) differ structurally — something in a specific place is wrong, not the whole screen.${areaNote} Start with regions[0].`
        : `Does NOT match at ${mode} fidelity: ${score}% similar (needs ${requiredScore}%), spread thinly rather than concentrated in one region. Usually a colour, a font, or a global spacing value that is slightly off everywhere.`

  return { pass, verdict, structuralRegions, regionPixelLimit }
}
