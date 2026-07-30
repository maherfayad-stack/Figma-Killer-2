/**
 * Converts a `ParsedPage` (from `../page-parser` — a flat element/instance
 * tree extracted from a real .tsx page file) into an Studio `Page` (from
 * `../page-tree`) so the parsed source can be loaded into the editor's
 * document model.
 *
 * CRITICAL Studio rule: `rootNodeId` must point at a `base.body` node, so
 * this converter synthesises one and hangs the parsed root nodes under it.
 */
import { CUSTOM_HTML_TAG_VALUE, htmlTagControl } from '@modules/base/utils/htmlTag'
import type { ParsedPage, ParsedNode, ParsedPropValue } from '../page-parser'
import { hasWritableSourceLocation, styleValueKey } from '../page-tree'
import type { Page, PageNode } from '../page-tree'

export interface ParsedPageToSitePageOptions {
  pageId: string
  slug: string
  title: string
  /** Maps a parsed node to an Studio moduleId. Pure/injected so this converter
   *  stays decoupled from the design-system list. e.g. component "Button" -> "alm.Button",
   *  element "div" -> "base.container". Also carries `children` and `text` so the
   *  resolver can tell a text-only tag (`<p>Hello</p>`) apart from one that wraps
   *  element children (`<p><Icon/></p>`) or carries no content at all
   *  (`<span className="icon" />`) — only the first may resolve to a leaf module
   *  like `base.text`, or the children are dropped and an empty element renders
   *  that module's placeholder label. */
  resolveModuleId: (node: Pick<ParsedNode, 'kind' | 'name' | 'children' | 'text' | 'props'>) => string
  /**
   * Maps a resolved moduleId to the single prop key its module's
   * `inlineTextEdit` declares (`base.text` -> 'text', `base.button` -> 'label',
   * `base.link` -> 'text'), or `null` when the module has no known text prop
   * (e.g. every `alm.*` design-system component — out of scope for source
   * writeback this slice). Pure/injected for the same decoupling reason as
   * `resolveModuleId`.
   */
  resolveTextProp: (moduleId: string) => string | null
  /**
   * §6.3 — maps a literal `className` attribute to the `classIds` the engine
   * renders styling from. Injected for the same decoupling reason as the two
   * resolvers above: this converter must not know how imported CSS was parsed
   * or how its rule ids are derived.
   *
   * Omitted when no CSS was imported, in which case `className` is dropped
   * (it is not a renderable prop in this engine, and keeping it would show a
   * dead value in the properties panel).
   */
  resolveClassIds?: (className: string) => string[]
}

/**
 * The built-in tag choices `base.container`'s `tag` select control offers
 * (read off the shared control rather than re-declaring the list, so this
 * stays in sync with `base.loop`'s identical picker). Any other tag still
 * gets preserved, via the control's 'custom' escape hatch.
 */
const BUILTIN_CONTAINER_TAGS: ReadonlySet<string> = (() => {
  const control = htmlTagControl()
  const options = control.type === 'select' ? control.options : []
  return new Set(
    options
      .map((o) => o.value)
      .filter((value): value is string => typeof value === 'string' && value !== CUSTOM_HTML_TAG_VALUE),
  )
})()

export function parsedPageToSitePage(parsed: ParsedPage, opts: ParsedPageToSitePageOptions): Page {
  const bodyId = `${opts.pageId}:body`

  const bodyNode: PageNode = {
    id: bodyId,
    moduleId: 'base.body',
    props: {},
    children: [...parsed.rootIds],
    classIds: [],
    breakpointOverrides: {},
  }

  const nodes: Record<string, PageNode> = { [bodyId]: bodyNode }
  for (const [id, node] of Object.entries(parsed.nodes)) {
    const moduleId = opts.resolveModuleId({
      kind: node.kind,
      name: node.name,
      children: node.children,
      text: node.text,
      props: node.props,
    })
    const props: Record<string, ParsedPropValue> = { ...node.props }

    // §6.3 — `className` is how the source attaches styling, but this engine
    // attaches it through `classIds` -> `site.styleRules`. Translate, then drop
    // the prop: it renders nothing on its own.
    const className = props.className
    delete props.className
    const classIds = typeof className === 'string' && opts.resolveClassIds
      ? opts.resolveClassIds(className)
      : []

    // `className` never reaches the panel (translated to `classIds` above), so
    // a code-valued one would name a prop that does not exist.
    const codeProps = (node.codeProps ?? []).filter((name) => name !== 'className')

    // Map captured element text onto the module's declared text prop — but
    // an explicit attribute always wins (e.g. `<Button label="x">y</Button>`
    // is a real, if odd, source shape; the attribute is the author's intent).
    let originTextProp: string | null = null
    if (node.text !== undefined) {
      const textProp = opts.resolveTextProp(moduleId)
      if (textProp !== null && !(textProp in props)) {
        props[textProp] = node.text
        // Text that came from an expression is only writable if the parser found
        // the string literal it reads (`textOrigin`) — `saveSite` then aims a
        // `literal` edit there instead of overwriting the JSX. With no origin
        // there is nowhere honest to write, so the text prop joins `codeProps`.
        if (node.textOrigin) originTextProp = textProp
        else if (node.codeText) codeProps.push(textProp)
      }
    }

    // Every tag-bearing module must keep rendering as its real host tag, or a
    // module default silently rewrites the element: `base.container` would turn
    // an `<h1>`/`<li>`/`<section>` into a `<div>`, and `base.text` would turn a
    // `<span>` into a block `<p>`, which visibly breaks inline layout. Each
    // module's own default tag needs no override.
    //
    // `tag`/`customTag` are SYNTHESIZED from the element's name rather than read
    // off an attribute, so they do not write back through `setJsxProp` — the save
    // adapter routes a change to them as a `tag` edit, which renames the element
    // itself (`setJsxTagName`). They stay out of `codeProps` because they ARE
    // editable; they just take a different road.
    if (node.kind === 'element' && !('tag' in props)) {
      const tag = node.name.toLowerCase()
      if (moduleId === 'base.container' && tag !== 'div') {
        if (BUILTIN_CONTAINER_TAGS.has(tag)) {
          props.tag = tag
        } else {
          props.tag = CUSTOM_HTML_TAG_VALUE
          props.customTag = tag
        }
      } else if (moduleId === 'base.text' && tag !== 'p') {
        // `resolveModuleId` only picks `base.text` for a tag it can render, so
        // there is no custom-tag fallback to reach here.
        props.tag = tag
      }
    }

    // A `.map` row (`…:70:21#2`) has no source location of its own — one piece of
    // JSX produced every row, so a prop write there would rewrite all of them.
    // Its resolved TEXT is the exception: that came from its own array element,
    // and `textOrigin` says which literal, so it keeps its one editable field.
    if (!hasWritableSourceLocation(id)) {
      for (const name of Object.keys(props)) {
        if (name !== originTextProp && !codeProps.includes(name)) codeProps.push(name)
      }
      for (const property of Object.keys(node.inlineStyles ?? {})) {
        const key = styleValueKey(property)
        if (!codeProps.includes(key)) codeProps.push(key)
      }
    }

    nodes[id] = {
      id,
      moduleId,
      props,
      children: [...node.children],
      classIds,
      breakpointOverrides: {},
      // Propagate the page-parser's STRUCTURAL lock (`.map`/ternary/`&&`/spread
      // subtree detection) onto the built PageNode, so the editor refuses to
      // move, delete, or reorder a node the source does not place. Distinct
      // from the manual "layer lock" the editor itself toggles — see
      // `lockReason`'s doc comment in `page-tree/baseNode.ts`.
      ...(node.locked ? { locked: true } : {}),
      ...(node.lockReason ? { lockReason: node.lockReason } : {}),
      // Per-prop writability, which is what the VALUE edit guards read. Kept
      // separate from the structural lock above because the two answer different
      // questions — see `PageNode.codeProps`.
      ...(codeProps.length > 0 ? { codeProps } : {}),
      // Carry the source `style={{…}}` through so the canvas renders the real
      // inline styles (`NodeRenderer` reads `node.inlineStyles`). Without this
      // an authored flex/gap/etc. layout is invisible on the board.
      ...(node.inlineStyles ? { inlineStyles: node.inlineStyles } : {}),
      // §7 — carry the static evaluator's provenance through so the editor can
      // show WHY a resolved node is locked and which branch/note it chose.
      // Follows the exact `locked`/`lockReason` pattern above.
      ...(node.resolution ? { resolution: node.resolution } : {}),
      // Same straight copy — the editable-origin pointer behind resolved text.
      ...(node.textOrigin ? { textOrigin: node.textOrigin } : {}),
      // §2 — which local component this node was inlined out of. Provenance,
      // not a lock: the properties panel warns that an edit here rewrites that
      // component's file and so lands on every instance of it.
      ...(node.fromComponent ? { fromComponent: node.fromComponent } : {}),
    }
  }

  return {
    id: opts.pageId,
    slug: opts.slug,
    title: opts.title,
    rootNodeId: bodyId,
    nodes,
  }
}
