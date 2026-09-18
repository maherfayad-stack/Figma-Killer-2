/**
 * cssInJsAttach — the JSX half of W4-4 Phase A: given a JSX tag name and its
 * attributes, decides what a styled component actually RENDERS and which
 * synthetic classes ride on it.
 *
 * ## No wrapper element, ever
 *
 * `<Wrapper>` where `const Wrapper = styled.div\`…\`` renders a `<div>` with a
 * class. Not a `<div>` inside a `<Wrapper>` box, not an opaque
 * "Unknown module" placeholder (which is what a styled component reached the
 * canvas as before this pass — `resolveModuleId` saw a `kind: 'component'`
 * node whose local declaration inlining could never expand, because a tagged
 * template is not a function that returns JSX). So the node is rewritten in
 * place: same source location, same id, `kind: 'element'`, the host tag as its
 * name. That is the same invariant `studio.instance` exists to protect —
 * "the canvas DOM must be the DOM React renders" — applied one construct over.
 *
 * ## The class goes on `className`, not on a new field
 *
 * `parsedPageToSitePage` already turns a literal `className` into
 * `node.classIds` via the class registry. Prepending the synthetic class to
 * whatever `className` the call site itself wrote means the whole downstream
 * path — `classIdsForClassName`, the CSS Classes panel, the canvas class
 * injector — needs no new concept. Prepending (not appending) matches
 * styled-components' own ordering: the generated class comes first, a
 * hand-written one after it.
 */
import { Node, type JsxAttribute, type JsxSpreadAttribute } from 'ts-morph'
import { classifyJsxTagKind } from '@core/page-tree'
import type { CssInJsScope } from './cssInJsExtract'
import type { ParsedPropValue } from './types'

/** Emotion's `css` prop is compiled away by its babel plugin — it is never a DOM attribute, so leaving it in `props` would emit `css="[object Object]"` on the canvas. */
const EMOTION_CSS_PROP = 'css'

export interface StyledAttachment {
  /** What the element renders as — the host tag for `styled.div`, the wrapped component's own name otherwise. */
  name: string
  kind: 'element' | 'component'
  /** Synthetic classes to prepend to this element's own `className`, base-first. */
  classNames: string[]
  /** Attribute names to drop from `props`/`codeProps` — see `EMOTION_CSS_PROP`. */
  dropProps: string[]
}

/**
 * `undefined` when this tag has nothing to do with CSS-in-JS — the
 * overwhelmingly common case, and the reason this is a cheap map lookup
 * before anything else happens.
 */
export function resolveStyledAttachment(
  tagName: string,
  attributes: readonly (JsxAttribute | JsxSpreadAttribute)[],
  file: CssInJsScope,
): StyledAttachment | undefined {
  if (file.empty) return undefined

  const binding = classifyJsxTagKind(tagName) === 'component' ? file.binding(tagName) : undefined
  const classNames: string[] = []
  const dropProps: string[] = []
  let name = tagName
  let kind: 'element' | 'component' = classifyJsxTagKind(tagName)

  if (binding && binding.base.kind === 'tag') {
    name = binding.base.tag
    kind = 'element'
    classNames.push(...binding.classNames)
  } else if (binding && binding.base.kind === 'component') {
    // styled-components renders `<Card className="…"/>` here — the wrapped
    // component keeps its own identity (and so its own detach/swap/inlining
    // behaviour), it just receives the class.
    classNames.push(...binding.classNames)
  }

  // Emotion: `css={headerStyles}` / `className={headerStyles}` where the value
  // is a module-scope `css\`…\`` const. Only a bare identifier is recognised —
  // a computed value is a runtime composition this pass cannot read, and
  // guessing which of several `css` blocks it composes would be exactly the
  // kind of "looks right, is a lie" answer the tier table bans.
  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    const attributeName = attribute.getNameNode().getText()
    if (attributeName !== EMOTION_CSS_PROP && attributeName !== 'className') continue
    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) continue
    const expression = initializer.getExpression()
    if (!expression || !Node.isIdentifier(expression)) continue
    const referenced = file.binding(expression.getText())
    if (!referenced || referenced.base.kind !== 'standalone') continue
    for (const className of referenced.classNames) if (!classNames.includes(className)) classNames.push(className)
    if (attributeName === EMOTION_CSS_PROP) dropProps.push(EMOTION_CSS_PROP)
  }

  if (classNames.length === 0 && name === tagName) return undefined
  return { name, kind, classNames, dropProps }
}

/** The subset of `extractProps`' result this module rewrites — everything else on it passes through untouched. */
interface StyledPropsResult {
  props: Record<string, ParsedPropValue>
  codeProps: string[]
}

/**
 * Folds an attachment into one element's already-extracted props.
 *
 * The synthetic class(es) are PREPENDED to whatever `className` the call site
 * itself wrote — `parsedPageToSitePage` turns that one field into `classIds`,
 * so nothing downstream needs a new concept, and prepending matches
 * styled-components' own ordering (generated class first, hand-written one
 * after).
 *
 * An emotion `css` prop, having been consumed into a class, is dropped from
 * BOTH `props` and `codeProps`. Not just `props`: a `codeProps` entry would put
 * a read-only row in the Properties panel for an attribute the rendered element
 * does not have, since emotion's babel plugin compiles the prop away entirely.
 */
export function applyStyledAttachment<T extends StyledPropsResult>(result: T, styled: StyledAttachment | undefined): T {
  if (!styled) return result
  const props = { ...result.props }
  for (const key of styled.dropProps) delete props[key]

  if (styled.classNames.length > 0) {
    const existing = typeof props.className === 'string' ? props.className.split(/\s+/).filter(Boolean) : []
    const merged: string[] = []
    for (const name of [...styled.classNames, ...existing]) if (!merged.includes(name)) merged.push(name)
    props.className = merged.join(' ')
  }

  return {
    ...result,
    props,
    codeProps: result.codeProps.filter((prop) => !styled.dropProps.includes(prop)),
  }
}
