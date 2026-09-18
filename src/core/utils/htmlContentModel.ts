/**
 * The HTML content model, as DATA — which elements may contain which, and
 * therefore what tag Studio may write around a run of elements it did not
 * author.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * ⌘G wrote `<div>` unconditionally. Grouping two inline `<span>`s that live
 * inside a `<p>` therefore put a `<div>` into phrasing content, which is not
 * merely untidy: React reports it in the user's own console as *"In HTML,
 * `<div>` cannot be a descendant of `<p>`. This will cause a hydration
 * error."* — Studio wrote markup that breaks their real app. The wrapper tag
 * is not a keybinding decision or a module default; it is a consequence of
 * where the wrapper lands and what it holds, and that is a fact about HTML.
 * So it lives here, once, as a table, rather than as an `if` at a call site.
 *
 * `@core/utils` rather than beside either consumer, for the same reason
 * `htmlTags.ts` is here: two callers point in different directions and the
 * module graph only stays one-directional if the shared leaf sits below both.
 *
 *   - `@core/ast-codemods`' `wrapJsxElement` / `wrapJsxElements` — the
 *     AUTHORITY. They read the real parent and the real members out of the
 *     user's AST, so whatever they decide is what the file gets, and a wrapper
 *     that cannot be legal is refused before a byte is written.
 *   - the editor store's group gesture — the same question asked EARLY, off
 *     the page tree, so an impossible group is refused with a dialog and a way
 *     forward instead of a round trip that comes back as a toast.
 *
 * Both call {@link chooseGroupWrapperTag}. One rule, two fact sources; the AST
 * is the one that decides.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a validator for the user's existing markup, and not a linter. It answers
 * exactly one question — "may Studio write a `<div>` or a `<span>` here, and
 * which one" — and it answers `null`/unknown generously, because an unknown
 * tag (a custom element, a component) is far more often fine than not. It
 * refuses only on POSITIVE knowledge that the wrapper would be invalid.
 */

import { VOID_HTML_ELEMENTS } from './htmlTags'

/**
 * What an element may CONTAIN.
 *
 * `transparent` is the spec's own word for elements whose content model is
 * their parent's (`a`, `ins`, `del`, `object`, `slot`, `video`, `audio`,
 * `canvas`, `noscript`, `map`). They are resolved by walking up
 * ({@link resolveContentModel}) rather than guessed at: treating `<a>` as
 * phrasing-only would refuse the extremely ordinary block link
 * (`<a><div/><div/></a>`), and treating it as flow would happily write a
 * `<div>` into `<p><a>…</a></p>`.
 *
 * `empty` covers both void elements (`<br>`, `<img>`) and text-only ones
 * (`<option>`, `<textarea>`, `<title>`): nothing that is an element may sit
 * inside either, so nothing inside them can be wrapped.
 */
export type HtmlContentModel =
  | { kind: 'flow' }
  | { kind: 'phrasing' }
  | { kind: 'empty' }
  | { kind: 'transparent' }
  | { kind: 'restricted'; allows: ReadonlySet<string> }

/**
 * What an element IS, in the one dimension this module needs.
 *
 *  - `phrasing` — text-level; legal wherever phrasing OR flow content is.
 *  - `flow` — block-level; legal only where flow content is.
 *  - `positional` — only means anything as a child of one specific parent
 *    (`li` in a list, `tr`/`td` in a table, `option` in a `select`). A wrapper
 *    around one of these breaks the relationship that gives it meaning, so it
 *    is refused rather than re-tagged.
 *  - `metadata` — document head material (`title`, `meta`, `script`, `style`).
 *    Same treatment as `positional`, different reason.
 */
export type HtmlElementCategory = 'phrasing' | 'flow' | 'positional' | 'metadata'

// ---------------------------------------------------------------------------
// The table. Anything not named here is UNKNOWN, which every consumer reads as
// "no opinion" — HTML gains elements, and a hard-coded list that predates one
// must not refuse a gesture because of its own age.
// ---------------------------------------------------------------------------

/** Text-level elements: legal wherever phrasing content is allowed. */
const PHRASING_ELEMENTS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas', 'cite', 'code',
  'data', 'datalist', 'del', 'dfn', 'em', 'embed', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'map', 'mark', 'math', 'meter', 'noscript', 'object',
  'output', 'picture', 'progress', 'q', 'ruby', 's', 'samp', 'select', 'slot',
  'small', 'span', 'strong', 'sub', 'sup', 'svg', 'template', 'textarea', 'time',
  'u', 'var', 'video', 'wbr',
])

/** Block-level elements: legal where flow content is allowed, never where only phrasing is. */
const FLOW_ONLY_ELEMENTS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl',
  'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search',
  'section', 'table', 'ul',
])

/** Elements whose only legal home is one specific parent — see {@link HtmlElementCategory}. */
const POSITIONAL_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ['li', 'ul'],
  ['dt', 'dl'],
  ['dd', 'dl'],
  ['caption', 'table'],
  ['colgroup', 'table'],
  ['col', 'colgroup'],
  ['thead', 'table'],
  ['tbody', 'table'],
  ['tfoot', 'table'],
  ['tr', 'tbody'],
  ['td', 'tr'],
  ['th', 'tr'],
  ['option', 'select'],
  ['optgroup', 'select'],
  ['legend', 'fieldset'],
  ['summary', 'details'],
  ['figcaption', 'figure'],
  ['source', 'picture'],
  ['track', 'video'],
  ['param', 'object'],
  ['area', 'map'],
  ['rt', 'ruby'],
  ['rp', 'ruby'],
  ['body', 'html'],
  ['head', 'html'],
  ['html', 'html'],
])

/** Document-head material. */
const METADATA_ELEMENTS: ReadonlySet<string> = new Set(['base', 'link', 'meta', 'script', 'style', 'title'])

/** Elements that may hold only phrasing content. */
const PHRASING_CONTENT_PARENTS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'em', 'strong', 'b', 'i', 'u',
  's', 'small', 'mark', 'abbr', 'cite', 'code', 'dfn', 'kbd', 'samp', 'sub', 'sup',
  'var', 'q', 'label', 'button', 'legend', 'summary', 'bdi', 'bdo', 'data', 'time',
  'meter', 'output', 'progress', 'pre',
])

/** Elements whose content model is their parent's — resolved by walking up. */
const TRANSPARENT_ELEMENTS: ReadonlySet<string> = new Set([
  'a', 'ins', 'del', 'object', 'slot', 'video', 'audio', 'canvas', 'noscript', 'map',
])

/**
 * Elements that may hold NOTHING that is an element — void elements plus the
 * text-only ones. Void names come from `htmlTags.ts` rather than a second copy.
 */
const TEXT_ONLY_ELEMENTS: ReadonlySet<string> = new Set([
  'option', 'textarea', 'title', 'script', 'style',
])

/**
 * Elements that accept only a named set of children. The set is what may
 * legally appear, so a wrapper is permitted exactly when it is a member —
 * which is why `dl` (whose spec allows `dt`/`dd` to be grouped in a `div`)
 * takes a `<div>` group while `ul` takes none.
 */
const RESTRICTED_CONTENT_PARENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['ul', new Set(['li', 'script', 'template'])],
  ['ol', new Set(['li', 'script', 'template'])],
  ['menu', new Set(['li', 'script', 'template'])],
  ['dl', new Set(['dt', 'dd', 'div', 'script', 'template'])],
  ['table', new Set(['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'script', 'template'])],
  ['thead', new Set(['tr', 'script', 'template'])],
  ['tbody', new Set(['tr', 'script', 'template'])],
  ['tfoot', new Set(['tr', 'script', 'template'])],
  ['tr', new Set(['td', 'th', 'script', 'template'])],
  ['colgroup', new Set(['col', 'template'])],
  ['select', new Set(['option', 'optgroup', 'hr', 'script', 'template'])],
  ['optgroup', new Set(['option', 'script', 'template'])],
  ['datalist', new Set(['option', 'script', 'template'])],
  ['picture', new Set(['source', 'img', 'script', 'template'])],
  ['ruby', new Set(['rt', 'rp'])],
  ['head', new Set([...METADATA_ELEMENTS, 'noscript', 'template'])],
  ['html', new Set(['head', 'body'])],
])

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Normalises a tag the way HTML does — `<DIV>` and `<div>` are one element. */
function normalise(tag: string): string {
  return tag.toLowerCase()
}

/**
 * What `tag` IS, or `null` when this table has never heard of it (a custom
 * element, a typo, an element added to HTML after this file was written).
 */
export function htmlElementCategory(tag: string): HtmlElementCategory | null {
  const name = normalise(tag)
  if (POSITIONAL_ELEMENTS.has(name)) return 'positional'
  if (METADATA_ELEMENTS.has(name)) return 'metadata'
  if (PHRASING_ELEMENTS.has(name)) return 'phrasing'
  if (FLOW_ONLY_ELEMENTS.has(name)) return 'flow'
  return null
}

/** The parent this `positional` element only means anything inside, for the refusal sentence. */
export function htmlPositionalParent(tag: string): string | null {
  return POSITIONAL_ELEMENTS.get(normalise(tag)) ?? null
}

/**
 * What `tag` may CONTAIN, or `null` for an element this table does not know.
 *
 * `transparent` is returned rather than resolved — resolving it needs the
 * ancestor chain, which only the caller has. {@link resolveContentModel} does
 * that walk given a list of ancestors.
 */
export function htmlContentModel(tag: string): HtmlContentModel | null {
  const name = normalise(tag)
  if (VOID_HTML_ELEMENTS.has(name) || TEXT_ONLY_ELEMENTS.has(name)) return { kind: 'empty' }
  const restricted = RESTRICTED_CONTENT_PARENTS.get(name)
  if (restricted) return { kind: 'restricted', allows: restricted }
  if (TRANSPARENT_ELEMENTS.has(name)) return { kind: 'transparent' }
  if (PHRASING_CONTENT_PARENTS.has(name)) return { kind: 'phrasing' }
  if (htmlElementCategory(name) !== null) return { kind: 'flow' }
  return null
}

/**
 * The effective content model of the nearest ancestor that HAS one.
 *
 * `ancestors` runs from the immediate parent OUTWARDS. Each entry is an
 * intrinsic tag name, or `null` for something this module cannot categorise —
 * a component, a fragment, a custom element.
 *
 * Two different `null`s, deliberately collapsed into one: a JSX fragment
 * renders nothing (so the real parent is further out) and a component renders
 * markup nobody here can see (so nothing further out is the real parent). The
 * caller is the one that knows which it has, and both codemods stop the list
 * at a component for exactly that reason — see `wrapperContextTags`.
 *
 * Returns `null` when nothing in the chain has a known model.
 */
export function resolveContentModel(ancestors: readonly (string | null)[]): HtmlContentModel | null {
  for (const tag of ancestors) {
    if (tag === null) return null
    const model = htmlContentModel(tag)
    if (model === null) return null
    if (model.kind !== 'transparent') return model
  }
  return null
}

// ---------------------------------------------------------------------------
// The one decision every caller wants
// ---------------------------------------------------------------------------

/** Why no wrapper could be written. Each maps to a distinct sentence. */
export type GroupWrapperRefusalReason =
  /** The parent accepts no wrapper at all — `<ul>`, `<tr>`, `<select>`, a void element. */
  | 'parent-forbids-wrapper'
  /** A member only means something as a direct child of its parent — an `<li>`, a `<td>`. */
  | 'member-is-positional'
  /** The parent holds text-level content only, but a member is block-level. Both tags would be invalid. */
  | 'phrasing-conflict'

export type GroupWrapperChoice =
  | { ok: true; tag: 'div' | 'span' }
  | { ok: false; reason: GroupWrapperRefusalReason; message: string }

export interface GroupWrapperContext {
  /**
   * The wrapper's ancestor tags, immediate parent first. `null` for anything
   * that is not an intrinsic element; see {@link resolveContentModel}.
   */
  ancestorTags: readonly (string | null)[]
  /**
   * The tags of the elements being wrapped, in source order. `null` for a
   * component — its category is genuinely unknown, so it neither demands a
   * block wrapper nor permits an inline one, and the parent decides instead.
   */
  memberTags: readonly (string | null)[]
}

/**
 * The tag Studio may write around `memberTags` inside `ancestorTags`, or why
 * it may write none.
 *
 * THE RULE, in the order it is applied:
 *
 *  1. The parent's model says which tags may SIT there: flow → `div` or
 *     `span`; phrasing-only → `span`; restricted → whichever of the two its
 *     allow-set names (`<dl>` takes a `div`, `<ul>` takes neither); empty →
 *     neither; unknown → both, because refusing on ignorance is worse than
 *     writing the ordinary container.
 *  2. A member that is `positional` or `metadata` is refused — unless the
 *     parent's allow-set named the wrapper itself, which is `<dl>` and only
 *     `<dl>`. An `<li>` inside a `<div>` is not a grouped list item; it is a
 *     list item that stopped being one.
 *  3. The members say which tags may CONTAIN them: a `<span>` holds phrasing
 *     only, so a block-level member rules it out.
 *  4. Of what survives both, `<span>` wins when every member is phrasing.
 *     This is the "keep the group looking like what it replaced" half: two
 *     inline `<span>`s inside an `<li>` grouped into a `<div>` stop flowing
 *     with the text around them, and that is a visible change the user did not
 *     ask for. Otherwise `<div>` — the ordinary container, and the one that
 *     follows the parent when the members cannot say (all components).
 *  5. Nothing survives → refuse, naming which of the two constraints bit.
 */
export function chooseGroupWrapperTag(context: GroupWrapperContext): GroupWrapperChoice {
  const parentModel = resolveContentModel(context.ancestorTags)
  const parentTag = firstKnownAncestor(context.ancestorTags)
  const permitted = permittedWrappers(parentModel)
  if (permitted.size === 0) {
    return {
      ok: false,
      reason: 'parent-forbids-wrapper',
      message: parentDescription(parentTag, parentModel),
    }
  }

  // A `positional` member may be wrapped in exactly one situation: its parent
  // NAMES the container among its own legal children. `<dl>` does — the spec
  // lets a `<div>` group a `<dt>`/`<dd>` pair — and nothing else in HTML does.
  // Anywhere else the wrapper would sever the relationship that gives the
  // element its meaning: an `<li>` inside a `<div>` is no longer that list's
  // item, and a `<figcaption>` inside one is no longer that figure's caption.
  const parentNamesTheWrapper = parentModel?.kind === 'restricted'
  if (!parentNamesTheWrapper) {
    for (const tag of context.memberTags) {
      if (tag === null) continue
      const category = htmlElementCategory(tag)
      if (category === 'positional') {
        const parent = htmlPositionalParent(tag)
        return {
          ok: false,
          reason: 'member-is-positional',
          message: `A <${normalise(tag)}> only means anything as a direct child of <${parent}>, so putting a container around it would break the list or table it belongs to. Group the <${parent}> itself, or add the container in the file.`,
        }
      }
      if (category === 'metadata') {
        return {
          ok: false,
          reason: 'member-is-positional',
          message: `<${normalise(tag)}> is document metadata, not page content, so there is nothing Studio could legally write around it. Group the elements around it instead.`,
        }
      }
    }
  }

  const demand = memberDemand(context.memberTags)
  const canDiv = permitted.has('div')
  const canSpan = permitted.has('span') && demand !== 'flow'
  if (!canDiv && !canSpan) {
    // The only way here is a phrasing-only parent holding a block-level
    // member: `<span>` cannot contain it, `<div>` cannot sit there.
    return {
      ok: false,
      reason: 'phrasing-conflict',
      message: `<${parentTag}> can only hold text-level elements, but one of these is a block, so any container Studio wrote here would be invalid HTML — React reports that as a hydration error in your app. Add the container in the file, or move these out of the <${parentTag}> first.`,
    }
  }
  if (demand === 'phrasing' && canSpan) return { ok: true, tag: 'span' }
  return { ok: true, tag: canDiv ? 'div' : 'span' }
}

/**
 * Whether an explicitly-named intrinsic wrapper may sit where the group lands.
 *
 * Used for the tag the CALLER chose rather than the one this module would pick
 * — "group into a `<section>`" is a request Studio honours or refuses, never
 * silently re-spells, because the tag carries meaning the user asked for.
 * `div`/`span` never reach this: they are the two interchangeable containers
 * and {@link chooseGroupWrapperTag} owns them.
 */
export function canWrapperTagSitHere(wrapperTag: string, ancestorTags: readonly (string | null)[]): boolean {
  const model = resolveContentModel(ancestorTags)
  if (model === null) return true
  const category = htmlElementCategory(wrapperTag)
  switch (model.kind) {
    case 'empty':
      return false
    case 'restricted':
      return model.allows.has(normalise(wrapperTag))
    case 'phrasing':
      // An unknown tag renders as an inline box and is legal in phrasing
      // content; a known block-level one is not.
      return category !== 'flow'
    case 'flow':
      return true
    // `resolveContentModel` never returns this — it is what the walk resolves.
    case 'transparent':
      return true
  }
}

/** The tags a wrapper may be, given only where it would sit. */
function permittedWrappers(model: HtmlContentModel | null): ReadonlySet<'div' | 'span'> {
  if (model === null) return new Set(['div', 'span'])
  switch (model.kind) {
    case 'empty':
      return new Set()
    case 'phrasing':
      return new Set(['span'])
    case 'restricted': {
      const allowed = new Set<'div' | 'span'>()
      if (model.allows.has('div')) allowed.add('div')
      if (model.allows.has('span')) allowed.add('span')
      return allowed
    }
    case 'flow':
    case 'transparent':
      return new Set(['div', 'span'])
  }
}

/** What the members need of their wrapper: block, inline, or no opinion. */
function memberDemand(memberTags: readonly (string | null)[]): 'flow' | 'phrasing' | 'unknown' {
  let known = 0
  for (const tag of memberTags) {
    if (tag === null) continue
    const category = htmlElementCategory(tag)
    if (category === 'flow') return 'flow'
    if (category === 'phrasing') known += 1
    // An unknown intrinsic name (a custom element) is inline by default but
    // says nothing reliable; it is counted as no opinion, like a component.
  }
  return known > 0 && known === memberTags.length ? 'phrasing' : 'unknown'
}

/** The nearest ancestor this module recognises, for a sentence that names something real. */
function firstKnownAncestor(ancestorTags: readonly (string | null)[]): string {
  for (const tag of ancestorTags) {
    if (tag === null) break
    const model = htmlContentModel(tag)
    if (model === null) break
    if (model.kind !== 'transparent') return normalise(tag)
  }
  return 'this element'
}

/** The sentence for a parent that takes no wrapper at all. */
function parentDescription(parentTag: string, model: HtmlContentModel | null): string {
  if (model?.kind === 'restricted') {
    const allows = [...model.allows].filter((name) => name !== 'script' && name !== 'template')
    const list = allows.map((name) => `<${name}>`).join(', ')
    return `<${parentTag}> can only contain ${list}, so a container around these would be invalid HTML and the browser would move it out. Add the container inside one of them, or in the file.`
  }
  return `<${parentTag}> cannot contain other elements, so there is nothing Studio could write around these.`
}
