/**
 * setSvgPartAttributes — the `svg-attr` edit (P5-D, SVG-4): set and remove
 * literal attributes on ONE element inside an inline `<svg>`, in one write.
 *
 * An inline SVG's `<path>`/`<circle>`/`<g>` are not page-tree nodes (see
 * `inlineSvg.ts`); the parser stamps each with its own `line:col` instead
 * (`data-studio-svg-part`, SVG-3). A vector edit names the HOST `<svg>` (a
 * real node id) and that PART location, and this codemod writes there.
 *
 * ## Why not `setJsxProp`
 *
 * `setJsxProp` writes any attribute on any element at a location the client
 * names. That is fine for a node the board read, and too much for this: the
 * part location arrives from the client, and nothing would stop it naming an
 * element anywhere in the file. So this codemod holds its own guards, on the
 * server, whoever the caller is (the editor, a plugin, an agent):
 *
 *   - **Containment.** The part must be the host itself or an element nested
 *     directly inside it as JSX — never one behind an expression container
 *     (`{items.map(…)}`, `{cond && …}`), which the canvas never stamped and
 *     whose write would land on every row.
 *   - **Identity.** The part's tag must be the one the client read
 *     (`partTag`), or the file changed under it: `element-moved`.
 *   - **What it may write.** The host must be a literal `<svg>`, the part an
 *     SVG content element (`SVG_WRITABLE_PART_TAGS`), and every name and value
 *     passes `@core/vector`'s `svgAttributeWriteRefusal` — the rule the SVG
 *     importer uses too: no handlers, no namespaces, fragment-only `href`, no
 *     remote `url()`.
 *   - **No binding is overwritten.** An attribute that holds code
 *     (`d={ICON}`) refuses `svg-attr-expression`; a spread on the part refuses
 *     `spread-attribute` (it can override anything written).
 *
 * Every check runs before the first byte changes, so a refused edit writes
 * nothing, and the whole set/remove is ONE save. Refusals are RETURNED, the
 * `setStyledDeclaration` shape; the dispatcher turns them into the batch's
 * refusal channel.
 */
import { Node, type JsxAttribute, type Project } from 'ts-morph'
import { isLiteralJsxAttribute } from '@core/page-parser'
import { SVG_WRITABLE_PART_TAGS, svgAttributeWriteRefusal } from '@core/vector'
import {
  createProject,
  findJsxElementAtLocation,
  loadSourceFile,
  resolveJsxWholeElement,
  type JsxOpeningLikeElement,
} from './locateJsxElement'
import { jsxAttributeInitializerText, jsxAttributeQuote } from './stringSpelling'

export interface SetSvgPartAttributesParams {
  /** The host `<svg>`'s file and tag-name location. */
  file: string
  line: number
  col: number
  /** The part's tag-name location in the same file, or `null` for the host `<svg>` itself. */
  part: { line: number; col: number } | null
  /** The part's tag as the caller read it — a mismatch means the file changed under the edit. */
  partTag: string
  /** JSX attribute names → the literal to write. */
  set: Readonly<Record<string, string | number>>
  /** JSX attribute names to delete (literal ones only; an absent one is a no-op). */
  remove?: readonly string[]
  project?: Project
}

export type SvgPartAttributesRefusalReason =
  | 'element-moved'
  | 'svg-host'
  | 'svg-part-outside-host'
  | 'svg-part-tag'
  | 'svg-attr-name'
  | 'svg-attr-value'
  | 'svg-attr-expression'
  | 'spread-attribute'

export type SetSvgPartAttributesResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: SvgPartAttributesRefusalReason; message: string }

const MOVED_SENTENCE =
  'The file changed since the board read it, and this part of the graphic is no longer where it was, so nothing was written.'

function refuse(reason: SvgPartAttributesRefusalReason, message: string): SetSvgPartAttributesResult {
  return { ok: false, reason, message }
}

function tagOf(element: JsxOpeningLikeElement): string {
  return element.getTagNameNode().getText()
}

/**
 * Whether `part` sits inside `host` through JSX nesting alone — every node
 * between them is an element, a fragment or a child list, never an
 * expression container.
 */
function isNestedAsJsx(part: JsxOpeningLikeElement, hostRoot: Node): boolean {
  const { root } = resolveJsxWholeElement(part)
  for (let node = root.getParent(); node; node = node.getParent()) {
    if (node === hostRoot) return true
    if (!(Node.isJsxElement(node) || Node.isJsxFragment(node) || Node.isSyntaxList(node) ||
      Node.isJsxOpeningFragment(node) || Node.isJsxClosingFragment(node))) return false
  }
  return false
}

/** The element's own named attribute, or `undefined`. A spread never matches. */
function namedAttribute(element: JsxOpeningLikeElement, name: string): JsxAttribute | undefined {
  for (const attribute of element.getAttributes()) {
    if (Node.isJsxAttribute(attribute) && attribute.getNameNode().getText() === name) return attribute
  }
  return undefined
}

/** The literal an attribute holds now, as the text a write would produce — to tell a no-op write apart. */
function currentInitializerText(attribute: JsxAttribute): string | undefined {
  return attribute.getInitializer()?.getText()
}

export function setSvgPartAttributes(params: SetSvgPartAttributesParams): SetSvgPartAttributesResult {
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, params.file)

  const host = findJsxElementAtLocation(sourceFile, params.line, params.col)
  if (!host) return refuse('element-moved', MOVED_SENTENCE)
  if (tagOf(host) !== 'svg') {
    return refuse('svg-host', 'This element is not an inline <svg> written in the code, so its graphic has no parts to write.')
  }

  let part = host
  if (params.part) {
    const found = findJsxElementAtLocation(sourceFile, params.part.line, params.part.col)
    if (!found) return refuse('element-moved', MOVED_SENTENCE)
    if (!isNestedAsJsx(found, resolveJsxWholeElement(host).root)) {
      return refuse('svg-part-outside-host', 'That part is not drawn directly inside this <svg>, so Studio will not write it from here.')
    }
    part = found
  }
  const partTag = tagOf(part)
  if (partTag !== params.partTag) return refuse('element-moved', MOVED_SENTENCE)
  if (!SVG_WRITABLE_PART_TAGS.has(partTag)) {
    return refuse('svg-part-tag', `<${partTag}> is not a part of the graphic Studio edits.`)
  }
  if (part.getAttributes().some((attribute) => Node.isJsxSpreadAttribute(attribute))) {
    return refuse('spread-attribute', 'This part takes attributes from a spread ({...props}), which could override anything written here. Change it in the code.')
  }

  // Validate everything before the first byte changes.
  const writes: { name: string; text: string; existing: JsxAttribute | undefined }[] = []
  for (const [name, value] of Object.entries(params.set)) {
    const refusal = svgAttributeWriteRefusal(name, value)
    if (refusal) return refuse(refusal.reason, refusal.message)
    const existing = namedAttribute(part, name)
    if (existing && !isLiteralJsxAttribute(existing)) {
      return refuse('svg-attr-expression', `"${name}" is set from code here (${existing.getInitializer()?.getText() ?? ''}), so writing a value would delete that binding. Change it in the code.`)
    }
    writes.push({ name, text: jsxAttributeInitializerText(value, jsxAttributeQuote(existing)), existing })
  }
  const removals: JsxAttribute[] = []
  for (const name of params.remove ?? []) {
    if (name in params.set) continue
    const refusal = svgAttributeWriteRefusal(name, '')
    if (refusal?.reason === 'svg-attr-name') return refuse(refusal.reason, refusal.message)
    const existing = namedAttribute(part, name)
    if (!existing) continue
    if (!isLiteralJsxAttribute(existing)) {
      return refuse('svg-attr-expression', `"${name}" is set from code here, so Studio will not delete it. Change it in the code.`)
    }
    removals.push(existing)
  }

  let changed = removals.length > 0
  for (const write of writes) {
    if (write.existing) {
      if (currentInitializerText(write.existing) === write.text) continue
      write.existing.setInitializer(write.text)
    } else {
      part.addAttribute({ name: write.name, initializer: write.text })
    }
    changed = true
  }
  for (const attribute of removals) attribute.remove()

  if (changed) sourceFile.saveSync()
  return { ok: true, changed }
}
