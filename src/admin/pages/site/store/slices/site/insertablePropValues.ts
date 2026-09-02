/**
 * insertablePropValues — what of a module's defaults may be written into the
 * user's `.tsx`, and in what shape.
 *
 * Split out of `nodeActions.ts` because it answers a question that module does
 * not otherwise ask. Everything else there mutates the page tree; this is the
 * one place that decides how a canvas-side VALUE is spelled in someone's
 * source, which is the decision the whole "a write must have exactly one
 * honest target" rule turns on.
 */
import { asJsonDataValue } from '@core/utils/jsonData'
import { svgToJsxNode } from '@site/studio/svgToJsxNode'
import type { InsertPropValue } from '@site/studio/studioSaveRequests'

/**
 * The subset of a module's defaults that has an unambiguous JSX spelling, for
 * an insert that is written to the user's source.
 *
 * A design-system module's `propsSchema` is `Unknown` for every prop (see
 * `registerProjectModules.ts`) precisely because the real shapes are unknown,
 * so the defaults bag can hold a handler, a React element, a slot sentinel, or
 * plain data. The first three are dropped: writing a guess into someone's
 * repository is worse than writing nothing, and the component's own default
 * applies to a prop that is simply absent.
 *
 * **Plain data is not a guess and is kept.** This used to drop every array and
 * object alongside the un-spellable ones, and that one line is why "the tab bar
 * renders with nothing in it" survived being fixed twice upstream: `items` was
 * seeded from the package's own documented example, reached here, and was
 * discarded, so the source grew `<TabBar platform="ios" value={0}/>` and the
 * canvas — which reloads from that source, as it must — drew an empty bar. The
 * same silence cost `SegmentedControl.items`, `Dialog`'s action objects,
 * `Navbar`'s `toolbar`/`chips` and every `Footer` column.
 */
export function insertableJsxProps(props: Record<string, unknown>): Record<string, InsertPropValue> {
  const insertable: Record<string, InsertPropValue> = {}
  for (const [key, value] of Object.entries(props)) {
    const writable = writablePropValue(value)
    if (writable !== undefined) insertable[key] = writable
  }
  return insertable
}

/**
 * One prop value as the insert can write it, or `undefined` when part of it has
 * no honest JSX spelling.
 *
 * Plain data passes through {@link asJsonDataValue}. The one shape that needs
 * translating is Studio's own `{ svg: markup }` icon value — the form the parser
 * captures a JSX icon as (`ICON_PROP_SVG_KEY`) and the form a module's defaults
 * carry it in — which must NOT be written back verbatim: `icon={{ svg: "…" }}`
 * hands the component an object where it expects a node, so the user's real app
 * would throw "Objects are not valid as a React child" on a page that renders
 * perfectly on the canvas. It becomes the `<svg>` element it stands for, via the
 * same `svgToJsxNode` the icon picker writes with — sanitised, capped, and
 * intrinsic-only.
 *
 * Recursive, because that is where these live: a tab bar's icons are one level
 * inside `items`, never at the top of a prop.
 */
function writablePropValue(value: unknown): InsertPropValue | undefined {
  const markup = studioSvgMarkup(value)
  if (markup !== undefined) {
    const converted = svgToJsxNode(markup)
    return converted.ok ? { __jsx: converted.node } : undefined
  }
  if (Array.isArray(value)) {
    const items = value.map(writablePropValue)
    return items.some((item) => item === undefined) ? undefined : (items as InsertPropValue[])
  }
  if (typeof value === 'object' && value !== null) {
    const entries: Record<string, InsertPropValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const writable = writablePropValue(item)
      if (writable === undefined) return undefined
      entries[key] = writable
    }
    return entries
  }
  return asJsonDataValue(value)
}

/** The markup inside Studio's `{ svg: markup }` icon value, or `undefined` for anything else. */
function studioSvgMarkup(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length !== 1 || entries[0]![0] !== 'svg') return undefined
  const markup = entries[0]![1]
  return typeof markup === 'string' ? markup : undefined
}
