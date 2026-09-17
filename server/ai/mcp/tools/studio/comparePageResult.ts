/**
 * comparePageResult — the shape of ONE page's entry in a `studio_compare`
 * batch, success or failure.
 *
 * Split out of `compare.ts` (A14), which already owns capture routing, the
 * verdict cache, batching and payload assembly, and had grown past the
 * 700-line module ceiling. "What one entry in `results[]` looks like" is a
 * coherent slice of its own: it is what an external MCP client actually
 * programs against, and it is read by both the tool and its tests.
 *
 * ## Why a failure here is not a `ToolRefusal`
 *
 * The top-level call SUCCEEDED — `ok` at the envelope is `true` and only this
 * one page failed, which is the point of batching: one unmeasurable screen
 * never costs the other nineteen their verdicts. So an entry carries the same
 * `code` / `remedy` / `retryable` triple a refusal does, without the refusal
 * envelope. Sharing the fields without sharing the envelope is the honest
 * shape; before A14 an entry just carried a sentence, which was the one place
 * the coded vocabulary stopped at the boundary.
 */
import { TOOL_REFUSAL_CODES, type ToolRefusalCode } from '@core/ai'
import { compareRegionLabel } from '../../../../handlers/studio/pageVerificationStore'
import type { FidelityMode } from '../../../../handlers/studio/fidelityMode'
import type { CachedCompareVerdict } from './compareVerdictCache'

/**
 * One differing region as the model sees it — the diff engine's rectangle plus
 * the quotable label the balanced Stop gate reads back (A9).
 */
export type LabelledDiffRegion = CachedCompareVerdict['regions'][number] & { label: string }

/**
 * Attach `compareRegionLabel` to each region, worst first. Pure and
 * one-liner-sized, but named because BOTH the cached and the freshly-computed
 * path have to do exactly this — two inline maps would be two chances to
 * number them differently.
 */
export function labelRegions(regions: CachedCompareVerdict['regions']): LabelledDiffRegion[] {
  return regions.map((region, index) => ({ ...region, label: compareRegionLabel(index, region.y) }))
}

export interface ComparePageRef {
  id: string
  title: string
}

export interface PageCompareSuccess {
  ok: true
  page: ComparePageRef
  fromCache: boolean
  pass: boolean
  verdict: string
  reference: { id: string; label?: string; width: number; height: number; autoSelected: boolean }
  similarityScore: number
  diffPercent: number
  thresholds: { fidelityMode: FidelityMode; passScore: number; maxRegionCoverage: number; maxRegionPixels: number | null }
  capture: CachedCompareVerdict['capture']
  structuralRegionCount: number
  /**
   * Each differing region, worst first, carrying the stable `label`
   * (`R1@y412`, `compareRegionLabel`) the balanced Stop gate looks for in the
   * reply. The label is added here rather than stored on the cached verdict
   * because it is derived from the region's own index and geometry — a cached
   * verdict and a fresh one therefore produce identical labels, which is the
   * property the gate depends on.
   */
  regions: LabelledDiffRegion[]
  regionsTruncated: boolean
  worstRegionNodeIds?: string[]
  images?: { screen: number; reference: number; diff: number }
}

export interface PageCompareFailure {
  ok: false
  page: ComparePageRef
  /** Same stable vocabulary a top-level refusal uses — see `@core/ai`'s `TOOL_REFUSAL_CODES`. */
  code: ToolRefusalCode
  error: string
  remedy?: string
  retryable: boolean
}

export type PageCompareResult = PageCompareSuccess | PageCompareFailure

/** Build one — `retryable` comes from the code table, never hand-passed, the same rule `toolRefusal` follows. */
export function pageFailure(
  page: ComparePageRef,
  code: ToolRefusalCode,
  error: string,
  remedy?: string,
): PageCompareFailure {
  return {
    ok: false,
    page,
    code,
    error,
    ...(remedy === undefined ? {} : { remedy }),
    retryable: TOOL_REFUSAL_CODES[code].retryable,
  }
}
