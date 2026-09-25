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
 * ## Markup is not JSX: what has to change on the way
 *
 * The output must RENDER in the user's real app, not merely parse. Three
 * things in ordinary exported SVG make React throw or draw the wrong thing,
 * and each is rewritten here rather than copied:
 *
 * 1. **`style="fill:#fff"` strings.** React throws on a string `style`. Each
 *    declaration becomes a presentation attribute where SVG has one, else an
 *    entry in a `style={{…}}` object (`svgImportStyles.ts`).
 * 2. **`<style>` blocks** (every Illustrator export: `.cls-1{fill:#f00}`).
 *    Single-class rules are resolved onto the elements they match and the
 *    block is dropped; anything else refuses with a sentence saying so.
 * 3. **`id`s.** Inline SVG ids are page-global, and two inserts of one icon
 *    (or two icons that both call their gradient `a`) collide: the second
 *    paints with the first one's gradient, or with nothing once the first is
 *    deleted. Every id gets a per-insert suffix and every reference to it —
 *    `url(#…)`, `href="#…"`, `aria-labelledby` — is rewritten to match (Penpot
 *    does the same on import: `svg.cljc` `generate-id-mapping` /
 *    `replace-attrs-ids`).
 *
 * ## References stay inside the graphic
 *
 * Everything an imported SVG points at must be a fragment of itself
 * (`@core/vector`'s `svgReferences`):
 *
 * - `href` / `xlink:href` survive only as `#name` (the sanitiser's fragment
 *   hook already guarantees it; this re-checks rather than trusts), and
 *   `xlink:href` is written as plain `href`, which every browser Studio
 *   supports reads and React needs no alias for.
 * - A `url(…)` pointing anywhere else — `fill="url(https://…)"`,
 *   `style="background:url(//…)"`, a `<style>` rule's `mask: url(…)` — REFUSES
 *   the import with a sentence. DOMPurify does not vet CSS, so such a value
 *   used to be written into the user's `.tsx`, where it makes their app fetch
 *   from a third-party host on every render: a tracking beacon that arrived
 *   inside an icon. Refusing (rather than silently dropping the value) keeps
 *   the rule that an import either writes what the file drew or says why not.
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
 * skipped during it. Every rewrite above runs on the sanitised document.
 */
import { sanitizeSvg } from '@core/sanitize'
import {
  cssValueLoadsExternalResource,
  isSvgAttributeNeverWritten,
  isSvgFragmentReference,
  isSvgTextAttribute,
  markupToJsxAttributeName,
} from '@core/vector'
import type { JsonDataValue } from '@core/utils/jsonData'
import type { SlotJsxNode } from './studioSaveRequests'
import {
  cascadeDeclarations,
  declarationsToJsx,
  parseClassStylesheet,
  parseDeclarations,
  type ClassRule,
  type CssDeclaration,
} from './svgImportStyles'

/**
 * Caps on what one icon may become. An icon is a glyph, not a scene: the
 * whole point of the 4 KB catalogue ceiling (`iconCatalog.ts`) is that what
 * lands in the user's file stays legible beside their own JSX. These bound
 * the UPLOAD path too, which has no server-side ceiling at all.
 */
const MAX_NODES = 256
const MAX_DEPTH = 12

export type SvgToJsxResult = { ok: true; node: SlotJsxNode } | { ok: false; message: string }

/** Attributes whose value is a whitespace-separated list of element ids, with no `#`. */
const ID_LIST_ATTRIBUTES: ReadonlySet<string> = new Set(['aria-labelledby', 'aria-describedby'])

/** Attributes whose whole value is one `#id` fragment reference. */
const FRAGMENT_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'xlink:href'])

/** `url(#id)` / `url("#id")` — the reference form paint, clip, mask, filter and marker use. */
const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g

/**
 * A short random tag shared by every id of ONE conversion. Random rather than
 * derived from the markup on purpose: two inserts of the very same icon are
 * exactly the case that must not collide.
 */
function newIdSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('')
}

/**
 * Old id → new id for every element carrying one, the new id readable as the
 * old one plus this conversion's suffix (`paint0_linear` →
 * `paint0_linear-k3f9a1`). A document that repeats an id maps both copies to
 * the same new id — it was already ambiguous inside the file, and inventing an
 * answer for which reference meant which is not this function's to do.
 */
function buildIdMapping(root: Element): Map<string, string> {
  const suffix = newIdSuffix()
  const mapping = new Map<string, string>()
  const withIds = [root, ...Array.from(root.getElementsByTagName('*'))].filter((el) => el.getAttribute('id'))
  for (const element of withIds) {
    const id = element.getAttribute('id')!
    if (!mapping.has(id)) mapping.set(id, `${id}-${suffix}`)
  }
  return mapping
}

/**
 * `value` with every `url(#id)` pointing at a remapped id rewritten. Only the
 * reference FORM is touched — never a bare `#abc`, which is as likely to be a
 * colour as an id — and an id the file does not define (a reference to
 * something outside it) is left exactly as written.
 */
function rewriteUrlReferences(value: string, ids: ReadonlyMap<string, string>): string {
  return value.replace(URL_REFERENCE, (whole, quote: string, id: string) => {
    const mapped = ids.get(id)
    return mapped === undefined ? whole : `url(${quote}#${mapped}${quote})`
  })
}

/** One attribute's value with its id references rewritten, per the attribute's own reference syntax. */
function rewriteAttributeReferences(name: string, value: string, ids: ReadonlyMap<string, string>): string {
  if (name === 'id') return ids.get(value) ?? value
  if (FRAGMENT_ATTRIBUTES.has(name)) {
    const target = /^\s*#(.+?)\s*$/.exec(value)?.[1]
    const mapped = target === undefined ? undefined : ids.get(target)
    return mapped === undefined ? value : `#${mapped}`
  }
  if (ID_LIST_ATTRIBUTES.has(name)) {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => ids.get(id) ?? id)
      .join(' ')
  }
  return rewriteUrlReferences(value, ids)
}

/**
 * Reads every `<style>` block, removes it, and returns its rules — or the
 * refusal sentence for a rule that cannot be inlined. An emptied `<defs>`
 * (Illustrator wraps its `<style>` in one) goes with it rather than landing in
 * the user's source as `<defs />`.
 */
function extractStylesheet(root: Element): { ok: true; rules: ClassRule[] } | { ok: false; message: string } {
  const styleElements = Array.from(root.getElementsByTagName('style'))
  const parsed = parseClassStylesheet(styleElements.map((el) => el.textContent ?? '').join('\n'))
  if (!parsed.ok) return parsed
  for (const element of styleElements) {
    const parent = element.parentElement
    element.remove()
    if (parent && parent.tagName === 'defs' && parent.children.length === 0 && !parent.textContent?.trim()) {
      parent.remove()
    }
  }
  return parsed
}

interface ConversionContext {
  nodes: number
  /** The first reason this SVG cannot be written, set by whichever element found it. */
  refusal?: string
  /** Stylesheet rules, in source order — the tiebreak between two matching rules. */
  rules: readonly ClassRule[]
  /** Class names the stylesheet defined; they are resolved away, so they are not written. */
  inlinedClasses: ReadonlySet<string>
  ids: ReadonlyMap<string, string>
}

/** The declarations of every rule matching one of `classNames`, in stylesheet order. */
function matchingRuleDeclarations(classNames: readonly string[], rules: readonly ClassRule[]): CssDeclaration[] {
  if (classNames.length === 0) return []
  return rules.filter((rule) => classNames.includes(rule.className)).flatMap((rule) => rule.declarations)
}

/** The refusal sentence for a value that loads something from outside the SVG. */
function remoteReferenceRefusal(where: string, value: string): string {
  const shown = value.length > 60 ? `${value.slice(0, 57)}…` : value
  return `That SVG loads something from outside itself (${where}: ${shown}), and Studio will not write a remote reference into your source. Remove it from the file and try again.`
}


function convertElement(element: Element, depth: number, context: ConversionContext): SlotJsxNode | undefined {
  if (depth > MAX_DEPTH || context.nodes >= MAX_NODES) return undefined
  context.nodes += 1

  const classNames = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  const props: Record<string, JsonDataValue> = {}
  for (const attr of Array.from(element.attributes)) {
    if (isSvgAttributeNeverWritten(attr.name) || attr.name === 'style') continue
    if (FRAGMENT_ATTRIBUTES.has(attr.name)) {
      // Fragment-only, and always spelled `href`: `xlink:href` gives way to a
      // plain `href` on the same element rather than writing both.
      if (!isSvgFragmentReference(attr.value)) continue
      if (attr.name === 'xlink:href' && element.hasAttribute('href')) continue
      props.href = rewriteAttributeReferences(attr.name, attr.value, context.ids)
      continue
    }
    const jsxName = markupToJsxAttributeName(attr.name)
    if (!jsxName) continue
    if (attr.name === 'class') {
      const kept = classNames.filter((name) => !context.inlinedClasses.has(name))
      if (kept.length > 0) props[jsxName] = kept.join(' ')
      continue
    }
    if (!isSvgTextAttribute(attr.name) && cssValueLoadsExternalResource(attr.value)) {
      context.refusal ??= remoteReferenceRefusal(attr.name, attr.value)
      continue
    }
    props[jsxName] = rewriteAttributeReferences(attr.name, attr.value, context.ids)
  }

  // Paint from the SVG's own CSS: the element's matching `<style>` rules, then
  // its `style` attribute. Both beat a presentation attribute in the cascade,
  // so a resolved declaration overwrites one the element already had.
  const winners = cascadeDeclarations(
    matchingRuleDeclarations(classNames, context.rules),
    parseDeclarations(element.getAttribute('style') ?? ''),
  )
  for (const [property, value] of winners) {
    if (cssValueLoadsExternalResource(value)) context.refusal ??= remoteReferenceRefusal(property, value)
  }
  const { attributes, style } = declarationsToJsx(
    new Map(Array.from(winners, ([property, value]) => [property, rewriteUrlReferences(value, context.ids)])),
  )
  Object.assign(props, attributes)
  if (Object.keys(style).length > 0) props.style = style

  const childElements = Array.from(element.children)
    .map((child) => convertElement(child, depth + 1, context))
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
 * Converts an ALREADY-SANITISED `<svg>` element into a writable JSX subtree,
 * or explains why it cannot. The root is modified in place (its `<style>`
 * blocks are removed), so hand it a document parsed for this call.
 *
 * {@link svgToJsxNode} is the entry every writer uses; this is its second
 * half, exported because the unit suite needs to reach it past
 * `sanitizeSvg`: happy-dom's HTML parser mis-reads a `<style>` inside
 * `<svg>`, so DOMPurify under happy-dom drops the block and everything after
 * it, where a browser keeps it (DOMPurify's svg profile allows `style`).
 */
export function convertSanitizedSvg(root: Element): SvgToJsxResult {
  const stylesheet = extractStylesheet(root)
  if (!stylesheet.ok) return stylesheet

  const context: ConversionContext = {
    nodes: 0,
    rules: stylesheet.rules,
    inlinedClasses: new Set(stylesheet.rules.map((rule) => rule.className)),
    ids: buildIdMapping(root),
  }
  const node = convertElement(root, 1, context)
  if (context.refusal) return { ok: false, message: context.refusal }
  if (!node) return { ok: false, message: 'That SVG is too deeply nested to write into source.' }
  if (context.nodes >= MAX_NODES) {
    return {
      ok: false,
      message: `That SVG has more than ${MAX_NODES} elements — too large to inline into your source as an icon.`,
    }
  }
  return { ok: true, node }
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
  return convertSanitizedSvg(root)
}
