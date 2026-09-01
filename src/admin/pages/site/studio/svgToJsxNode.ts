/**
 * svgToJsxNode — turns SVG markup into the JSX subtree the slot codemod
 * writes into the user's source.
 *
 * ## Why inline JSX, and not an import
 *
 * A design system's icon set is SVG FILES (`@alm-design/design-system` ships
 * 568 of them under `src/icons/`). The obvious write — `import icon from
 * '@alm-design/design-system/src/icons/line-icons/wifi.svg'` — is not one
 * Studio can honestly make: what that import EVALUATES to depends entirely on
 * the user's bundler config (a URL string under Vite's default, a React
 * component only with `vite-plugin-svgr`, a compile error under plain `tsc`).
 * Studio would be writing source whose meaning it cannot verify, into a
 * project whose build it does not own.
 *
 * Inline JSX has no such dependency. `<svg viewBox="0 0 24 24"><path d="…"/></svg>`
 * means the same thing in every React project, needs no import, no plugin and
 * no new dependency — and it round-trips through Studio's own pipeline
 * unchanged: `parsePageFile` captures a literal `<svg>` element via
 * `serializeInlineSvg`, `resolveModuleId` promotes it to `base.svg`, and the
 * canvas renders the markup. The same conversion therefore serves BOTH icon
 * sources — a package's catalogue and a file the user uploads — because after
 * this function neither is distinguishable from the other.
 *
 * ## The shape is deliberately not imported from the codemod
 *
 * `InsertJsxNode` lives in `@core/ast-codemods`, which pulls in ts-morph —
 * that must never reach the browser bundle. This module agrees with the WIRE
 * shape (`SlotJsxNode`, `studioSaveRequests.ts`, itself validated server-side
 * against `SlotJsxNodeSchema`), the same posture `registerProjectModules.ts`
 * takes for `ICON_PROP_SVG_KEY`.
 *
 * ## Sanitised first, always
 *
 * Markup reaching here is either a file out of `node_modules` or a file the
 * user picked off their disk — neither is trusted, and the server could not
 * sanitise it (Bun has no DOM). `sanitizeSvg` runs before a single node is
 * read, so a `<script>` or an `onload=` is gone before parsing, not merely
 * skipped during it.
 */
import { sanitizeSvg } from '@core/sanitize'
import type { SlotJsxNode } from '@site/studio/studioSaveRequests'

/**
 * Caps on what one icon may become. An icon is a glyph, not a scene: the
 * whole point of the 4 KB catalogue ceiling (`iconCatalog.ts`) is that what
 * lands in the user's file stays legible beside their own JSX. These bound
 * the UPLOAD path too, which has no server-side ceiling at all.
 */
const MAX_NODES = 256
const MAX_DEPTH = 12

export type SvgToJsxResult = { ok: true; node: SlotJsxNode } | { ok: false; message: string }

/**
 * Attributes dropped rather than translated. `xmlns` declarations are XML
 * plumbing React neither needs nor accepts on a child element, and an
 * `on*` handler cannot survive as a JSX string attribute even if DOMPurify
 * had left one behind.
 */
function isDroppedAttribute(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:') || /^on/i.test(name)
}

/**
 * An SVG attribute's JSX spelling. `data-*`/`aria-*` keep their hyphens
 * (React passes them through verbatim); every other hyphenated attribute
 * camelCases (`stroke-linecap` -> `strokeLinecap`); the two namespaced
 * attributes React does understand get their documented names; `class` is
 * `className`. Anything else namespaced is dropped by the caller, because a
 * colon cannot appear in a JSX attribute name at all.
 */
function jsxAttributeName(name: string): string | undefined {
  if (name === 'class') return 'className'
  if (name === 'xlink:href') return 'xlinkHref'
  if (name === 'xml:space') return 'xmlSpace'
  if (name.includes(':')) return undefined
  if (name.startsWith('data-') || name.startsWith('aria-')) return name
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

interface ConversionBudget {
  nodes: number
}

function convertElement(element: Element, depth: number, budget: ConversionBudget): SlotJsxNode | undefined {
  if (depth > MAX_DEPTH || budget.nodes >= MAX_NODES) return undefined
  budget.nodes += 1

  const props: Record<string, string> = {}
  for (const attr of Array.from(element.attributes)) {
    if (isDroppedAttribute(attr.name)) continue
    const jsxName = jsxAttributeName(attr.name)
    if (jsxName) props[jsxName] = attr.value
  }

  const childElements = Array.from(element.children)
    .map((child) => convertElement(child, depth + 1, budget))
    .filter((child): child is SlotJsxNode => child !== undefined)

  const node: SlotJsxNode = { name: element.tagName }
  if (Object.keys(props).length > 0) node.props = props

  if (childElements.length > 0) {
    node.children = childElements
  } else {
    // Text-only content (`<title>Close</title>`). `InsertJsxChildren` makes
    // text and elements exclusive on purpose — mixed content has no stable
    // node identity for the parser to hand back — so text is read only when
    // there are no element children to lose.
    const text = element.textContent?.trim()
    if (text) node.children = text
  }
  return node
}

/**
 * Converts SVG markup into a writable JSX subtree, or explains why it cannot.
 * Every refusal message is written to be shown to the user as-is.
 */
export function svgToJsxNode(markup: string): SvgToJsxResult {
  const safe = sanitizeSvg(markup)
  if (!safe.trim()) {
    return { ok: false, message: 'That file has no SVG content Studio can safely use.' }
  }

  const doc = new DOMParser().parseFromString(safe, 'image/svg+xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { ok: false, message: 'That SVG could not be parsed — it is not well-formed XML.' }
  }

  const root = doc.documentElement
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    return { ok: false, message: 'That file does not start with an <svg> element.' }
  }

  const budget: ConversionBudget = { nodes: 0 }
  const node = convertElement(root, 1, budget)
  if (!node) return { ok: false, message: 'That SVG is too deeply nested to write into source.' }
  if (budget.nodes >= MAX_NODES) {
    return {
      ok: false,
      message: `That SVG has more than ${MAX_NODES} elements — too large to inline into your source as an icon.`,
    }
  }
  return { ok: true, node }
}
