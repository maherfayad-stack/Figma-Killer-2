/**
 * nodeExportModel — every decision the Export section makes that is not a
 * network call or a DOM event (W8-4, `STUDIO-WAVE7-PLAN.md` § "Honest
 * mappings").
 *
 * The section itself is a thin shell over this file: a `+` menu built from
 * `NODE_EXPORT_MENU`, a list of `NodeExportRow`s, and four verbs. Everything
 * that could be wrong — whether this node has an honest vector form, what its
 * effective CSS actually is, what the downloaded file is called — is a pure
 * function here so it can be tested without a canvas, a server, or a browser.
 *
 * ## Why SVG is decided on the CLIENT and PNG on the server
 *
 * They are different questions.
 *
 * A PNG of a node is a photograph: it only exists once something has RENDERED
 * the page, so it needs the headless capture pipeline and a crop against that
 * capture's own `nodeRects` — server work by construction
 * (`server/handlers/studio/nodeExportCapture.ts`).
 *
 * Whether a node HAS an honest vector form is not a rendering question at all.
 * It is a fact about the parse — `base.svg` carries the serialised markup on
 * `props.svg`, an `<img>` carries a `src`, and both reached this store
 * straight out of the server's own page parse. Re-deriving that on the server
 * would mean re-parsing the whole workspace to arrive at the identical answer
 * one round trip later. So `resolveNodeSvgExport` reads the node the panel is
 * already holding, and the two SVG shapes that ARE honest resolve locally: the
 * inline markup becomes a blob, and an `.svg` asset is fetched from the
 * ordinary `/admin/api/studio/asset` route the canvas already uses for it.
 *
 * ## The refusal
 *
 * Everything else is refused BY NAME. A `<div>` with a gradient and a border
 * radius is rasterised HTML; there is no vector description of it, and
 * wrapping the PNG in an `<svg><image href="data:…">` shell — which is what
 * "export anything as SVG" tools do — would hand the user a file that claims
 * to be vector and is not. That is precisely the class of lie
 * `PROJECT-BRIEF.md`'s second invariant exists to prevent, applied to a read
 * instead of a write. `NodeSvgRefusal.message` is written to be shown to the
 * user verbatim, and every one of them names the remedy (export PNG).
 */
import type { CSSPropertyBag, PageNode } from '@core/page-tree'
import { camelToKebabCssProperty } from '@core/css-codemods'
import type { PropertyProvenance } from './stylePropertyProvenance'

// ---------------------------------------------------------------------------
// Export rows — what the `+` menu can add
// ---------------------------------------------------------------------------

/** The image formats an export row can produce. Copy CSS / Copy JSX are menu ACTIONS, not rows — see `NODE_EXPORT_MENU`. */
export type NodeExportFormat = 'png' | 'svg'

export interface NodeExportRow {
  /** Stable identity for the `PropertyList` row and its React key. */
  id: string
  format: NodeExportFormat
  /**
   * Pixel density for a `png` row (Figma's @1×/@2×/@3×). Always `1` for
   * `svg`, which has no raster density — the row renders "Vector" instead of
   * a multiplier rather than showing a number that means nothing.
   */
  scale: 1 | 2 | 3
}

/** One entry in the section header's typed `+` menu. */
export interface NodeExportMenuEntry {
  id: string
  label: string
  /** `add-row` appends a `NodeExportRow`; `copy-*` run immediately and write to the clipboard. */
  action:
    | { kind: 'add-row'; format: NodeExportFormat; scale: 1 | 2 | 3 }
    | { kind: 'copy-png'; scale: 1 | 2 | 3 }
    | { kind: 'copy-css' }
    | { kind: 'copy-jsx' }
  /**
   * Keyboard hint rendered after the label — the discoverability half of a
   * global shortcut. Resolved from the keybindings registry at the call site,
   * never spelled out here.
   */
  commandId?: string
}

/**
 * The typed `+` menu, in Figma's order: the raster densities, the vector
 * format, then the two code copies.
 *
 * Copy CSS and Copy JSX are menu actions rather than rows on purpose. A row
 * exists so its settings (format, density) can be kept and re-run; a copy has
 * no settings, and parking one in the list would mean "add the row, then press
 * its button" for something that is a single verb.
 */
export const NODE_EXPORT_MENU: ReadonlyArray<NodeExportMenuEntry> = [
  { id: 'png-1x', label: 'PNG @1×', action: { kind: 'add-row', format: 'png', scale: 1 } },
  { id: 'png-2x', label: 'PNG @2×', action: { kind: 'add-row', format: 'png', scale: 2 } },
  { id: 'png-3x', label: 'PNG @3×', action: { kind: 'add-row', format: 'png', scale: 3 } },
  { id: 'svg', label: 'SVG', action: { kind: 'add-row', format: 'svg', scale: 1 } },
  // Copy as PNG is a menu ACTION, not a row, for the reason Copy CSS is: a row
  // exists so its settings can be kept and re-run, and a copy has no settings.
  // It carries the ⌘⇧C hint because a global shortcut nobody can see is a
  // shortcut nobody uses — the density here matches the shortcut's own.
  { id: 'copy-png', label: 'Copy as PNG', action: { kind: 'copy-png', scale: 2 }, commandId: 'export.copySelectionPng' },
  { id: 'copy-css', label: 'Copy CSS', action: { kind: 'copy-css' } },
  { id: 'copy-jsx', label: 'Copy JSX', action: { kind: 'copy-jsx' } },
]

/** `PNG` / `SVG` — the row's format chip. */
export function exportFormatLabel(format: NodeExportFormat): string {
  return format === 'png' ? 'PNG' : 'SVG'
}

/** `2×` for a raster row; `Vector` for SVG, which has no density. */
export function exportScaleLabel(row: NodeExportRow): string {
  return row.format === 'svg' ? 'Vector' : `${row.scale}×`
}

/** The row's accessible name — `PropertyList` uses it for "Remove <name>". */
export function exportRowLabel(row: NodeExportRow): string {
  return `${exportFormatLabel(row.format)} ${exportScaleLabel(row)}`
}

/**
 * A filesystem-safe download name for one export.
 *
 * The stem is the node's own label, reduced to the characters a download name
 * can carry on every platform. An empty or entirely-stripped label falls back
 * to a fixed stem rather than producing a file called `.png`.
 */
export function exportFileName(nodeLabel: string, row: NodeExportRow): string {
  const stem = nodeLabel
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96)
  const suffix = row.format === 'png' && row.scale > 1 ? `@${row.scale}x` : ''
  return `${stem || 'export'}${suffix}.${row.format}`
}

// ---------------------------------------------------------------------------
// SVG — the honest-vector decision
// ---------------------------------------------------------------------------

/** Why a node has no honest vector form. Each maps to one `message` written for the user. */
export type NodeSvgRefusalReason = 'rasterized-html' | 'raster-image' | 'dynamic-svg'

export interface NodeSvgRefusal {
  ok: false
  reason: NodeSvgRefusalReason
  /** Shown verbatim in the failure toast. Always names the remedy. */
  message: string
}

export type NodeSvgExport =
  /** `base.svg` — the parser already serialised the JSX subtree to real markup. */
  | { ok: true; source: 'inline'; markup: string }
  /** An `<img>` whose `src` resolves to an `.svg` file (or an `image/svg+xml` data URL). */
  | { ok: true; source: 'asset'; url: string }
  | NodeSvgRefusal

const SVG_REFUSALS: Record<NodeSvgRefusalReason, string> = {
  'rasterized-html':
    'This node is rasterized HTML, not a vector graphic — there is no honest SVG for it. Export PNG instead.',
  'raster-image':
    'This node is a raster image (PNG/JPEG/WebP). Wrapping those pixels in an SVG would not make them vector — export PNG instead.',
  'dynamic-svg':
    'This graphic’s markup is built at runtime, so the parse has no SVG source to hand you. Export PNG instead.',
}

function refuseSvg(reason: NodeSvgRefusalReason): NodeSvgRefusal {
  return { ok: false, reason, message: SVG_REFUSALS[reason] }
}

/**
 * Whether `src` names an SVG.
 *
 * Local project assets do not reach the browser as `./logo.svg`: the parse
 * rewrites them to `/admin/api/studio/asset?dir=…&path=media/logo.svg`
 * (`studioPageLoad.ts`), so the extension lives in the `path` QUERY PARAMETER,
 * not in the URL's path. Both shapes are checked, plus the `data:` form.
 */
function isSvgSource(src: string): boolean {
  if (/^data:image\/svg\+xml[;,]/i.test(src)) return true
  const beforeHash = src.split('#')[0] ?? ''
  const questionMark = beforeHash.indexOf('?')
  const path = questionMark === -1 ? beforeHash : beforeHash.slice(0, questionMark)
  if (/\.svg$/i.test(path)) return true
  if (questionMark === -1) return false
  const assetPath = new URLSearchParams(beforeHash.slice(questionMark + 1)).get('path')
  return assetPath !== null && /\.svg$/i.test(assetPath)
}

/**
 * Resolve the node's honest SVG form, or refuse by name. See this module's
 * doc for why this is a client-side read of the parse rather than a route.
 */
export function resolveNodeSvgExport(node: Pick<PageNode, 'moduleId' | 'props'>): NodeSvgExport {
  const rawMarkup = node.props.svg
  const markup = typeof rawMarkup === 'string' ? rawMarkup.trim() : ''
  if (markup.startsWith('<svg')) return { ok: true, source: 'inline', markup }

  // A `base.svg` node with no usable markup is the parser's own refusal
  // (a spread-driven or oversized graphic — see `inlineSvg.ts`), surfaced
  // here as its own reason rather than as the generic HTML one.
  if (node.moduleId === 'base.svg') return refuseSvg('dynamic-svg')

  const src = typeof node.props.src === 'string' ? node.props.src.trim() : ''
  if (src) return isSvgSource(src) ? { ok: true, source: 'asset', url: src } : refuseSvg('raster-image')

  return refuseSvg('rasterized-html')
}

// ---------------------------------------------------------------------------
// Copy CSS
// ---------------------------------------------------------------------------

/** One `[kebab-property, value]` pair destined for the copied rule. */
export type NodeCssDeclaration = readonly [property: string, value: string]

/**
 * The node's EFFECTIVE declarations, read off the provenance map
 * `StyleSurface` already computes for every curated property.
 *
 * Only properties something actually DECLARES are copied. Everything else in
 * a computed style bag is the UA's opinion, not this element's design, and
 * pasting three hundred inherited defaults into someone's stylesheet would
 * make the copy useless.
 *
 * For a property with a known winner, the winner's value is copied — that is
 * the declaration in effect. For an `ambiguous` one (several classes declare
 * it and the panel refuses to guess which rule order wins), the frame's real
 * computed value is copied instead: it is the ground truth for what renders,
 * and copying one of the candidate declarations at random would be the guess
 * `stylePropertyProvenance` exists to avoid. A property with neither is
 * skipped rather than invented.
 */
export function collectNodeCssDeclarations(
  properties: ReadonlyArray<keyof CSSPropertyBag | string>,
  provenanceByProperty: ReadonlyMap<string, PropertyProvenance>,
): NodeCssDeclaration[] {
  const declarations: NodeCssDeclaration[] = []
  for (const property of properties) {
    const key = String(property)
    const provenance = provenanceByProperty.get(key)
    if (!provenance || provenance.sources.length === 0) continue
    const winner = provenance.sources.find((source) => source.winner)
    const value = winner ? String(winner.value) : provenance.computedValue
    if (value === undefined || value === '') continue
    declarations.push([camelToKebabCssProperty(key), value])
  }
  return declarations
}

export interface NodeCssRule {
  /** A comment header naming the element the rule came from. */
  title: string
  /** The selector to wrap the declarations in, or `undefined` when the node carries no class. */
  selector?: string
  declarations: ReadonlyArray<NodeCssDeclaration>
}

/**
 * Format a copied rule.
 *
 * With a selector the output is an ordinary CSS rule. WITHOUT one — a node
 * styled only inline, or not styled at all — the declarations are emitted
 * bare, under the same comment header. Inventing a class name for an element
 * that has none would produce a rule that matches nothing and a name that
 * exists in no file.
 */
export function formatNodeCss(rule: NodeCssRule): string {
  const header = `/* ${rule.title} */`
  if (rule.declarations.length === 0) return `${header}\n/* Nothing is set on this element. */\n`
  const body = rule.declarations.map(([property, value]) => `${property}: ${value};`)
  if (!rule.selector) return `${header}\n${body.join('\n')}\n`
  return `${header}\n${rule.selector} {\n${body.map((line) => `  ${line}`).join('\n')}\n}\n`
}
