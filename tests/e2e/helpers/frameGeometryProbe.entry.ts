/**
 * Browser-side probe for `frame-geometry-index.e2e.ts` (SB-3). Bundled to one
 * IIFE by the spec (`bun build`) and injected into a document, so the REAL
 * `collectNodeGeometry` and the REAL `FrameGeometryIndex` run against REAL
 * Chromium layout, next to the browser's own `elementsFromPoint`.
 *
 * It imports the two modules by relative path (no `@core` alias) because this
 * file is type-checked by `tests/e2e/tsconfig.json`, which has none; the two
 * are alias-free on purpose.
 */
import { FrameGeometryIndex } from '../../../src/admin/pages/site/canvas/frameGeometry/frameGeometryIndex'
import { collectNodeGeometry } from '../../../src/core/studio-runtime/nodeGeometry'

export interface ProbeOptions {
  /** Distance between grid sample points, in px. */
  step: number
}

export interface ProbeResult {
  nodeCount: number
  points: number
  /** Points where the browser found a stamped node. */
  nativeHits: number
  /** Index top hit equals the browser's top stamped node. */
  topMatches: number
  /** Whole chain (topmost first) equals the browser's chain of stamped nodes. */
  chainMatches: number
  /** Top hits that differ AND the index did not flag as approximate: these are bugs. */
  hardMismatchCount: number
  /** The first few of them. */
  hardMismatches: Array<{ x: number; y: number; native: string | null; index: string | null; elements: string[]; indexRect: unknown; docWidth: number }>
  /** Top hits that differ but the index said it could not vouch for (transformed / truncated). */
  approximateMismatches: number
  /** Top hits that differ because the point is in the rounded corner of the index's hit (a box is hit as its rectangle): a documented approximation. */
  roundedCornerMismatches: number
  measureMsMedian: number
  buildMsMedian: number
  indexQueryUs: number
  nativeQueryUs: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function nativeChain(x: number, y: number): string[] {
  const ids: string[] = []
  for (const element of document.elementsFromPoint(x, y)) {
    const id = element.closest('[data-node-id]')?.getAttribute('data-node-id')
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Whether (x, y) lies in a corner square of the hit box whose radius the browser would not hit-test. */
function inRoundedCorner(hit: { nodeId: string; rect: { x: number; y: number; width: number; height: number } } | undefined, x: number, y: number): boolean {
  if (!hit) return false
  const element = Array.from(document.querySelectorAll('[data-node-id]')).find((el) => el.getAttribute('data-node-id') === hit.nodeId)
  if (!element) return false
  const style = getComputedStyle(element)
  const radius = Math.max(...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => Number.parseFloat(value) || 0))
  if (radius === 0) return false
  const nearX = x - hit.rect.x < radius || hit.rect.x + hit.rect.width - x <= radius
  const nearY = y - hit.rect.y < radius || hit.rect.y + hit.rect.height - y <= radius
  return nearX && nearY
}

function run(options: ProbeOptions): ProbeResult {
  const measureTimes: number[] = []
  const buildTimes: number[] = []
  let snapshot = collectNodeGeometry(document, window)
  let index = FrameGeometryIndex.fromSnapshot(snapshot, { x: 0, y: 0 })
  for (let i = 0; i < 9; i += 1) {
    const t0 = performance.now()
    snapshot = collectNodeGeometry(document, window)
    const t1 = performance.now()
    index = FrameGeometryIndex.fromSnapshot(snapshot, { x: 0, y: 0 })
    const t2 = performance.now()
    measureTimes.push(t1 - t0)
    buildTimes.push(t2 - t1)
  }

  const width = document.documentElement.clientWidth
  const height = Math.min(window.innerHeight, document.documentElement.scrollHeight)
  const result: ProbeResult = {
    nodeCount: snapshot.nodes.length,
    points: 0,
    nativeHits: 0,
    topMatches: 0,
    chainMatches: 0,
    hardMismatchCount: 0,
    hardMismatches: [],
    approximateMismatches: 0,
    roundedCornerMismatches: 0,
    measureMsMedian: median(measureTimes),
    buildMsMedian: median(buildTimes),
    indexQueryUs: 0,
    nativeQueryUs: 0,
  }

  const points: Array<{ x: number; y: number }> = []
  for (let y = options.step / 2; y < height; y += options.step) {
    for (let x = options.step / 2; x < width; x += options.step) points.push({ x, y })
  }
  result.points = points.length

  for (const { x, y } of points) {
    const chain = nativeChain(x, y)
    const hits = index.nodesAt({ x, y })
    const native = chain[0] ?? null
    const top = hits[0]?.nodeId ?? null
    if (native !== null) result.nativeHits += 1
    if (native === top) result.topMatches += 1
    else if (hits[0]?.approximate || hits.some((hit) => hit.approximate)) result.approximateMismatches += 1
    else if (inRoundedCorner(hits[0], x, y)) result.roundedCornerMismatches += 1
    else {
      result.hardMismatchCount += 1
      if (result.hardMismatches.length < 12) {
        const elements = document.elementsFromPoint(x, y).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className}` : ''}`)
        result.hardMismatches.push({ x, y, native, index: top, elements, indexRect: hits[0]?.rect ?? null, docWidth: document.documentElement.clientWidth })
      }
    }
    if (chain.length === hits.length && chain.every((id, i) => id === hits[i]?.nodeId)) result.chainMatches += 1
  }

  const indexStart = performance.now()
  let sink = 0
  for (const { x, y } of points) sink += index.nodesAt({ x, y }).length
  result.indexQueryUs = ((performance.now() - indexStart) / points.length) * 1000
  const nativeStart = performance.now()
  for (const { x, y } of points) sink += nativeChain(x, y).length
  result.nativeQueryUs = ((performance.now() - nativeStart) / points.length) * 1000
  if (sink < 0) throw new Error('unreachable: keeps the loops observable')
  return result
}

;(window as unknown as { __frameGeometryProbe: { run: typeof run } }).__frameGeometryProbe = { run }
