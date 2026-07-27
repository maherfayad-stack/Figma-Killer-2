/**
 * componentSubstitution — fills a locally-inlined component's own JSX with the
 * values its CALL SITE passed (§2.3).
 *
 * `inlineLocalComponents` owns the structural half of expansion: parse the
 * component's file, prefix its ids, splice the subtree in where the call site
 * was. This module owns the value half. The two are separable because the
 * structural half never reads a prop and this half never moves a node.
 *
 * What `parseJsxTree` cannot do alone is the reason this exists: parsing
 * `Icon.jsx` on its own sees `width: size` and `__html: svg`, where `size` and
 * `svg` are PARAMETERS with no value anywhere in that file. The values live at
 * the call site, one level up. So each element is revisited here with the call
 * site's props in hand — as a literal substitution table (`env`) for the simple
 * `{paramName}` forwards, and as §7 bindings (`paramEvalContext`) for the
 * expressions those params feed.
 *
 * Scope is deliberately the same as the parser's: this fills in values the
 * readers had to skip, and never re-derives structure, locking, or capture
 * rules. See `inlineLocalComponents`'s header, SCOPE, for the exact list of
 * shapes and why loop-bearing transforms stay unresolved.
 */
import { Node, SyntaxKind, type JsxElement, type JsxSelfClosingElement, type SourceFile } from 'ts-morph'
import { extractInlineStyles, rawHtmlValueExpression, SVG_DOCUMENT_RE } from './jsxAttributeReaders'
import { tryResolveExpression, type PageEvalContext } from './resolutionLock'
import { createEvalScope, type LocalBinding } from './staticEval'
import type { FunctionLike, ParsedPage } from './types'
import type { StaticEvalOptions } from './staticEval'

/** `extractInlineStyles` takes a full `ParseContext`; the image-import map is only consulted by `extractProps`, never on the style path. */
const EMPTY_IMAGE_IMPORTS: Map<string, string> = new Map()

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

/** A literal a call site passed, or its `{children}`. */
export type LiteralValue = string | number | boolean

/** What `buildSubstitutionEnv` resolved a destructured prop param to. */
export type Substitution = { kind: 'literal'; value: LiteralValue } | { kind: 'children' }

/**
 * Builds the substitution table (§2.3) from the target component's OWN
 * destructured first-parameter pattern and the call site's literal props.
 * Only a single `{ a, b: renamed, c = 1 }`-shaped object binding pattern is
 * supported (every validation-corpus component uses one) — a non-destructured
 * parameter (`function Foo(props) {…}`), a nested pattern, or a rest element
 * yields no entry for that param, so any `{paramName}` reference to it is
 * simply left unresolved (existing lock/drop path), never guessed at.
 */
export function buildSubstitutionEnv(fn: FunctionLike, callSiteProps: Record<string, LiteralValue>): Map<string, Substitution> {
  const env = new Map<string, Substitution>()
  const first = fn.getParameters()[0]
  if (!first) return env

  const pattern = first.getNameNode()
  if (!Node.isObjectBindingPattern(pattern)) return env

  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue // ...rest — unsupported

    const nameNode = element.getNameNode()
    if (!Node.isIdentifier(nameNode)) continue // nested destructuring pattern — unsupported
    const paramName = nameNode.getText()

    const propertyNameNode = element.getPropertyNameNode()
    const attrName = propertyNameNode ? propertyNameNode.getText() : paramName

    if (attrName === 'children') {
      env.set(paramName, { kind: 'children' })
      continue
    }

    if (Object.hasOwn(callSiteProps, attrName)) {
      env.set(paramName, { kind: 'literal', value: callSiteProps[attrName]! })
      continue
    }

    const initializer = element.getInitializer()
    if (!initializer) continue
    if (Node.isStringLiteral(initializer) || Node.isNumericLiteral(initializer)) {
      env.set(paramName, { kind: 'literal', value: initializer.getLiteralValue() })
    } else if (initializer.getKind() === SyntaxKind.TrueKeyword || initializer.getKind() === SyntaxKind.FalseKeyword) {
      env.set(paramName, { kind: 'literal', value: initializer.getKind() === SyntaxKind.TrueKeyword })
    }
    // Any other default (a call, a template literal, …) is not a literal —
    // intentionally left unresolved, same policy as `extractProps`.
  }

  return env
}

/**
 * Patches `subPage` (already structurally correct via `parseJsxTree`) with
 * §2.3's substitutions: a `{paramName}` prop/text reference resolved to a
 * literal via `env`, a `{children}` reference spliced with the call site's
 * own already-parsed children ids, and a `className` template literal's
 * static head text. Does NOT re-derive structure, locking, svg capture, or
 * style extraction — `parseJsxTree` already owns all of that; this only
 * fills in values `extractProps`/`extractSingleText` had to skip because
 * they were identifier references, not literals.
 *
 * Walks `rootExpr` in the same shape as the element tree (JSX
 * element/self-closing/fragment/expression) purely to re-derive each
 * element's id (same `${relFile}:${line}:${col}` convention) and match it
 * against `subPage.nodes` — it does not replicate locking or capture rules,
 * only finds where to patch.
 */
export function applySubstitutions(
  rootExpr: Node,
  subPage: ParsedPage,
  env: Map<string, Substitution>,
  callSiteChildrenIds: string[],
  sourceFile: SourceFile,
  relFile: string,
  fn: FunctionLike,
  evalOptions: StaticEvalOptions | undefined,
): ParsedPage {
  if (env.size === 0) return subPage
  const nodes = { ...subPage.nodes }

  const idFor = (el: Node): string => {
    const { line, column } = sourceFile.getLineAndColumnAtPos(el.getStart())
    return `${relFile}:${line}:${column}`
  }

  /**
   * The component's own scope with its PARAMETERS bound to the values this call
   * site passed, so §7 can evaluate an expression that reads them.
   *
   * The evaluator already binds arguments this way for a Tier C call
   * (`LocalBinding`'s `'resolved'` variant); seeding a component's params with
   * the same binding is what lets an expression like
   * `dangerouslySetInnerHTML={{ __html: applyTokens(svg) }}` resolve — `svg` is
   * a parameter, so nothing was reachable from the component's file alone when
   * it was parsed.
   */
  const paramEvalContext: PageEvalContext | undefined = evalOptions && {
    options: evalOptions,
    scope: {
      sourceFile,
      locals: new Map<string, LocalBinding>([
        ...createEvalScope(sourceFile, fn).locals,
        ...[...env].flatMap(([name, sub]): [string, LocalBinding][] =>
          sub.kind === 'literal' ? [[name, { kind: 'resolved', value: { kind: 'literal', value: sub.value } }]] : [],
        ),
      ]),
    },
  }

  const patchElement = (el: JsxOpeningLike): void => {
    const isElement = Node.isJsxElement(el)
    const tagNameNode = isElement ? el.getOpeningElement().getTagNameNode() : el.getTagNameNode()
    const id = idFor(tagNameNode)
    const existing = nodes[id]
    if (existing) {
      const attributes = isElement ? el.getOpeningElement().getAttributes() : el.getAttributes()

      let patchedProps: Record<string, LiteralValue> | undefined
      for (const attr of attributes) {
        if (!Node.isJsxAttribute(attr)) continue
        const attrName = attr.getNameNode().getText()
        if (attrName in existing.props) continue // already captured as a literal
        const initializer = attr.getInitializer()
        if (!initializer || !Node.isJsxExpression(initializer)) continue
        const expr = initializer.getExpression()
        if (!expr || !Node.isIdentifier(expr)) continue
        const sub = env.get(expr.getText())
        if (sub?.kind !== 'literal') continue
        patchedProps ??= { ...existing.props }
        patchedProps[attrName] = sub.value
      }

      // `<Icon svg={checkSvg}/>` → `<span dangerouslySetInnerHTML={{__html: svg}}/>`:
      // the span is the element that actually renders the markup (and carries
      // the class that sizes and colours it). Evaluating the `__html` expression
      // against the param-bound scope covers the corpus's two shapes with one
      // mechanism — a bare `svg` and `applyTokens(svg)`, a pure local function
      // that swaps hardcoded hex fills for design tokens. `props.svg` is the
      // same key `extractRawSvgMarkup` writes, which promotes it to `base.svg`.
      if (!('svg' in (patchedProps ?? existing.props))) {
        const htmlExpr = rawHtmlValueExpression(attributes)
        const resolved = htmlExpr ? tryResolveExpression(htmlExpr, paramEvalContext)?.value : undefined
        if (typeof resolved === 'string' && SVG_DOCUMENT_RE.test(resolved)) {
          patchedProps ??= { ...existing.props }
          patchedProps.svg = resolved
        }
      }

      // className, in two passes. First the whole expression against the
      // param-bound scope: the corpus's components build their class with
      // `['ds-raw-icon', className].filter(Boolean).join(' ')`, so the call
      // site's class only reaches the element that carries the design's rule
      // (the one that sizes an icon) if `className` is bound. Falling back to
      // §2.3's `className={\`static ${dynamic}\`}` head keeps the static prefix
      // when the expression as a whole doesn't resolve — visual fidelity only.
      //
      // No lock/resolution is recorded for either: `parsedPageToSitePage` turns
      // className into `classIds` and deletes the prop, so this value is never a
      // writeback target that could bake over the expression.
      if (!('className' in (patchedProps ?? existing.props))) {
        const classNameAttr = attributes.find(
          (a): a is typeof attributes[number] & { getNameNode(): Node } =>
            Node.isJsxAttribute(a) && a.getNameNode().getText() === 'className',
        )
        const classInitializer = Node.isJsxAttribute(classNameAttr) ? classNameAttr.getInitializer() : undefined
        if (classInitializer && Node.isJsxExpression(classInitializer)) {
          const expr = classInitializer.getExpression()
          const resolved = expr ? tryResolveExpression(expr, paramEvalContext)?.value : undefined
          if (typeof resolved === 'string' && resolved.trim().length > 0) {
            patchedProps ??= { ...existing.props }
            patchedProps.className = resolved.trim()
          } else if (expr && Node.isTemplateExpression(expr)) {
            const head = expr.getHead().getLiteralText().trim()
            if (head.length > 0) {
              patchedProps ??= { ...existing.props }
              patchedProps.className = head
            }
          }
        }
      }

      // `style={{ width: size, height: size }}` — the same story as the props
      // loop: the values are parameters, so §7 had nothing to resolve when the
      // component's own file was parsed. Re-reading the attribute against the
      // param-bound scope is what sizes an inlined `<Icon size={44}/>`'s span;
      // without it the raw SVG inside has no box and overflows whatever badge
      // the design put around it. Re-using `extractInlineStyles` keeps one
      // reader for "how a style object is written".
      let patchedStyles = existing.inlineStyles
      if (paramEvalContext) {
        const { styles } = extractInlineStyles(attributes, {
          sourceFile,
          relFile,
          nodes,
          imageImports: EMPTY_IMAGE_IMPORTS,
          eval: paramEvalContext,
        })
        if (styles) patchedStyles = { ...existing.inlineStyles, ...styles }
      }

      let patchedText = existing.text
      if (existing.text === undefined && existing.children.length === 0 && isElement) {
        const meaningful = el
          .getJsxChildren()
          .filter((c) => !(Node.isJsxText(c) && c.getText().trim().length === 0))
        if (meaningful.length === 1 && Node.isJsxExpression(meaningful[0])) {
          const expr = meaningful[0].getExpression()
          if (expr && Node.isIdentifier(expr)) {
            const sub = env.get(expr.getText())
            if (sub?.kind === 'literal') patchedText = String(sub.value)
          }
        }
      }

      let patchedChildren = existing.children
      if (isElement) {
        let insertAt = 0
        for (const child of el.getJsxChildren()) {
          if (Node.isJsxText(child)) continue
          if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child)) {
            insertAt += 1
            continue
          }
          if (Node.isJsxExpression(child)) {
            const expr = child.getExpression()
            if (expr && Node.isIdentifier(expr) && env.get(expr.getText())?.kind === 'children') {
              patchedChildren = [
                ...existing.children.slice(0, insertAt),
                ...callSiteChildrenIds,
                ...existing.children.slice(insertAt),
              ]
            }
          }
        }
      }

      if (
        patchedProps ||
        patchedStyles !== existing.inlineStyles ||
        patchedText !== existing.text ||
        patchedChildren !== existing.children
      ) {
        nodes[id] = {
          ...existing,
          ...(patchedProps ? { props: patchedProps } : {}),
          ...(patchedStyles ? { inlineStyles: patchedStyles } : {}),
          ...(patchedText !== undefined ? { text: patchedText } : {}),
          children: patchedChildren,
        }
      }
    }

    if (isElement) {
      for (const child of el.getJsxChildren()) walk(child)
    }
  }

  const walk = (node: Node): void => {
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) {
      patchElement(node)
      return
    }
    if (Node.isJsxFragment(node)) {
      for (const child of node.getJsxChildren()) walk(child)
      return
    }
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression()
      if (expr) walk(expr)
      return
    }
    // Ternary/logical/`.map(...)` bodies — descend to find any JSX literal
    // reachable inside, same reachability `parseJsxTree` already used to
    // decide what got a node at all.
    node.forEachChild(walk)
  }

  walk(rootExpr)

  return { rootIds: subPage.rootIds, nodes }
}
