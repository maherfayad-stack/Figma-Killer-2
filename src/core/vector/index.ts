/**
 * `@core/vector` — the pure vector engine behind SVG on the canvas.
 *
 * No DOM, no ts-morph, no React: it runs in the parser, the browser, the
 * server and tests alike. Everything outside this folder imports through this
 * barrel (gated by `no-core-barrel-deep-imports.test.ts`).
 *
 *   - `svgAttributeNames` — the ONE markup ⇄ JSX attribute-name mapping.
 *   - `svgReferences` — what an SVG may point at: same-document fragments only.
 *   - `pathData` — token-preserving parse/serialise of `d`.
 *   - `pathModel` — absolute geometry over a parse, edits, minimal re-emit.
 *   - `pathGeometry` — Bézier evaluate, split, bounds, nearest point, flatten.
 *   - `arcToCubic` — elliptical arcs as cubics.
 *   - `simplify` — radial + Douglas-Peucker + Schneider curve fit.
 *   - `precision` — how many decimals a rewritten coordinate gets.
 */
export { jsxToMarkupAttributeName, markupToJsxAttributeName } from './svgAttributeNames'
export { cssValueLoadsExternalResource, isSvgFragmentReference } from './svgReferences'
export {
  parsePathData,
  serializePathData,
  type PathCommand,
  type PathData,
  type PathParseResult,
  type PathSegment,
} from './pathData'
export {
  anchorSegmentIndices,
  createPathModel,
  moveAnchor,
  moveHandle,
  serializePathModel,
  type AbsoluteSegment,
  type PathModel,
  type SegmentKind,
  type SerializedPath,
  type SerializeOptions,
} from './pathModel'
export {
  cubicAt,
  cubicBounds,
  distance,
  flattenCubic,
  lerpPoint,
  nearestOnCubic,
  nearestOnLine,
  quadAt,
  quadBounds,
  quadToCubic,
  splitCubic,
  splitQuad,
  unionRects,
  type Cubic,
  type NearestPoint,
  type Point,
  type Quad,
  type Rect,
} from './pathGeometry'
export { arcToCubics, type ArcParameters } from './arcToCubic'
export { fitCubics, simplifyDouglasPeucker, simplifyRadial } from './simplify'
export { decimalsForScale, formatPathNumber } from './precision'
