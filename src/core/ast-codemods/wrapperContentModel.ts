/**
 * wrapperContentModel — the AST half of "what tag may Studio write around
 * these elements", shared by `wrapJsxElement` (⌘G on one) and
 * `wrapJsxElements` (⌘G on a run).
 *
 * THE DEFECT THIS CLOSES. Both codemods used to write whatever tag the caller
 * named, and every caller named `div` (`base.container`'s `sourceIntrinsic`).
 * Grouping two inline `<span>`s inside a `<p>` therefore wrote
 * `<p><div><span/><span/></div></p>` into the user's repository, which React
 * reports as a hydration error in their own app — Studio broke the file it was
 * editing. The tag is a consequence of the CONTEXT, and only the AST knows the
 * context, so the decision belongs here.
 *
 * WHAT IS READ, AND WHAT IS NOT. Two facts, both already in the parse: the
 * chain of ancestor tags above the insertion point, and the tag of each element
 * being wrapped. Nothing is executed, nothing is rendered, and a name this
 * module cannot categorise — a component, a custom element, a fragment — is
 * reported as "unknown" rather than guessed at. `@core/utils/htmlContentModel`
 * turns those two facts into a tag or a refusal; this file only collects them.
 *
 * `div` AND `span` ARE THE TWO INTERCHANGEABLE CONTAINERS. A caller that names
 * either is asking for "a box", and this module picks whichever one is legal.
 * A caller that names anything else — `section`, `Stack` — asked for that
 * specific thing, which carries meaning Studio must not silently re-spell: it
 * is written as asked, or refused with the reason it cannot go there.
 */
import { Node } from 'ts-morph'
import {
  canWrapperTagSitHere,
  chooseGroupWrapperTag,
  type GroupWrapperContext,
} from '@core/utils/htmlContentModel'

/**
 * The intrinsic tag of a JSX element, or `null` when it is a component
 * (`<Stack>`, `<Ui.Card>`) whose rendered element nothing here can see.
 *
 * The leading-lowercase test is JSX semantics, not style: React reads `<div>`
 * as the string `"div"` and `<Div>` as the in-scope identifier.
 */
export function intrinsicTagName(element: Node): string | null {
  const opening = Node.isJsxElement(element)
    ? element.getOpeningElement()
    : Node.isJsxSelfClosingElement(element)
      ? element
      : null
  if (!opening) return null
  const name = opening.getTagNameNode().getText()
  if (!/^[a-z]/.test(name)) return null
  return name.includes('.') ? null : name
}

/**
 * Ancestor tags above `parent`, immediate parent first, for
 * `resolveContentModel` to walk.
 *
 * Three rules, each with a reason:
 *
 *  - A JSX **fragment** contributes nothing and the walk continues: it renders
 *    no element, so the real parent is further out.
 *  - A **component** contributes one `null` and the walk STOPS: what it
 *    renders around its children is in another file, so nothing above it is
 *    the real parent either. `null` is the caller's signal for "no opinion".
 *  - An **expression container** (`{cond && <div/>}`) is walked through. The
 *    branch is decided when the app runs — which is why a structural edit
 *    refuses to reorder across one — but where it SITS is not: that `<div>`
 *    is inside whatever encloses the `{…}`, on every branch. Anything else
 *    non-JSX (an arrow function body, a `.map` callback) ends the walk with
 *    `null`, because the element's real parent then depends on where the
 *    callback's result is used.
 */
export function ancestorTagNames(parent: Node): (string | null)[] {
  const tags: (string | null)[] = []
  let current: Node | undefined = parent
  while (current) {
    if (Node.isJsxElement(current) || Node.isJsxSelfClosingElement(current)) {
      const tag = intrinsicTagName(current)
      tags.push(tag)
      if (tag === null) return tags
    } else if (
      !Node.isJsxFragment(current) &&
      !Node.isJsxExpression(current) &&
      !Node.isParenthesizedExpression(current) &&
      !Node.isBinaryExpression(current) &&
      !Node.isConditionalExpression(current)
    ) {
      return tags
    }
    current = current.getParent()
  }
  return tags
}

/** A wrapper tag this module refused to write, in the shape both codemods return it. */
export interface WrapperTagRefusal {
  reason: 'content-model'
  message: string
}

export type WrapperTagResolution = { ok: true; name: string } | { ok: false; refusal: WrapperTagRefusal }

/**
 * The tag to actually write, given what the caller asked for and where it
 * would land.
 *
 * `div`/`span` with no import are the generic containers and are re-picked
 * from the context. Every other name is the caller's own choice and is only
 * checked, never changed — the check still runs, because "write it anyway" is
 * how invalid markup got into a user's repository in the first place.
 */
export function resolveWrapperTag(
  requestedName: string,
  importSpecifier: string | undefined,
  context: GroupWrapperContext,
): WrapperTagResolution {
  const choice = chooseGroupWrapperTag(context)
  if (!choice.ok) return { ok: false, refusal: { reason: 'content-model', message: choice.message } }

  const generic = importSpecifier === undefined && (requestedName === 'div' || requestedName === 'span')
  if (generic) return { ok: true, name: choice.tag }

  if (!canWrapperTagSitHere(requestedName, context.ancestorTags)) {
    return {
      ok: false,
      refusal: {
        reason: 'content-model',
        message: `A <${requestedName}> cannot go where these elements are without making the HTML invalid, and Studio will not write markup your app would report as an error. Group them in a plain container instead, or add the <${requestedName}> in the file.`,
      },
    }
  }
  return { ok: true, name: requestedName }
}
