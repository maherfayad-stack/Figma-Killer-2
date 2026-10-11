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
import { styleValueKey } from '@core/page-tree'
import {
  extractInlineStyles,
  extractProps,
  extractSingleText,
  rawHtmlValueExpression,
  resolveRawSvgMarkup,
  templateHeadClassNames,
} from './jsxAttributeReaders'
import { paramReadCount } from './paramReads'
import { shortenSource, tryResolveExpression, type PageEvalContext, type Resolution } from './nodeResolution'
import { createEvalScope, type LocalBinding, type StaticValue, type ValueOrigin } from './staticEval'
import type { ReturnedJsx } from './branchSelection'
import type { FunctionLike, ParsedNode, ParsedPage, ParsedPropValue } from './types'
import type { StaticEvalOptions } from './staticEval'

/** `extractInlineStyles` takes a full `ParseContext`; the image-import map is only consulted by `extractProps`, never on the style path. */

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

/**
 * What `buildSubstitutionEnv` resolved a destructured prop param to: a value the
 * call site passed (scalar, or a structured one for a component prop — see
 * `ParsedPropValue`), or its `{children}`.
 *
 * `origin` (P3-C, WB-6) is where a STRING value the call site passed
 * physically lives — its own attribute literal (`ParsedNode.literalPropOrigins`)
 * or the literal its expression resolved through (`resolvedProps[k].origin`).
 * It travels with the value into the component, so an inlined node that renders
 * it records the call site's literal as its write target instead of the
 * component's `{param}` (which is code, and shared by every instance). Never
 * set for a component's own destructure DEFAULT: that literal feeds every call
 * site that omits the prop, so an edit there would change instances the user
 * did not touch.
 *
 * `prop` is the name the CALL SITE passes it under (`ParsedNode.propFeeds`'s
 * value), and `fromDefault` marks a value the call site did NOT pass, so the
 * component's destructure default fed it. Neither changes what renders; they
 * are what lets the editor write the call site for a value that has no literal
 * of its own (OD-19). `viaCode` marks a call site that passes the prop as an
 * expression the parser could not trace to one literal (or could not resolve at
 * all, so the default stands in): such a value is never a place to write.
 */
export type Substitution =
  | { kind: 'value'; value: ParsedPropValue; prop: string; origin?: ValueOrigin; fromDefault?: true; viaCode?: true }
  | { kind: 'children' }

/** The call-site facts `buildSubstitutionEnv` reads. */
export type SubstitutionCallSite = Pick<ParsedNode, 'props' | 'literalPropOrigins' | 'resolvedProps' | 'codeProps'>

/**
 * Lifts a call site's already-captured prop value back into a `StaticValue`, so
 * the evaluator can read INTO it when the component's own JSX does
 * (`<Row item={pkg}/>` → `{item.gb}`). The round trip through
 * `ParsedPropValue` is lossless for everything the parser kept — the entries it
 * dropped (functions, unresolved values) were never representable anyway.
 *
 * A top-level string carries its `origin` as the literal it is (P3-C): the
 * evaluator hands a bound value through unchanged, so `{title}` and
 * `{title || 'Untitled'}` resolve WITH it and `{`${title}!`}` — a computed
 * value — without it, by the evaluator's own existing rule.
 */
function toStaticValue(value: ParsedPropValue, origin?: ValueOrigin): StaticValue {
  // `complete: true` on both: this is a plain JS value the parser already
  // finished reading, so its keys and its length ARE what they are — there is
  // no unread spread or computed key left to surprise `pluck`.
  if (Array.isArray(value)) return { kind: 'array', items: value.map((item) => toStaticValue(item)), complete: true }
  if (typeof value === 'object') {
    return {
      kind: 'object',
      entries: new Map(Object.entries(value).map(([k, v]) => [k, toStaticValue(v)])),
      complete: true,
    }
  }
  return origin && typeof value === 'string' ? { kind: 'literal', value, origin } : { kind: 'literal', value }
}

/** Where the call site's value for `attrName` is written, when it is a string with one literal behind it. */
function callSiteOrigin(callSite: SubstitutionCallSite, attrName: string, value: ParsedPropValue): ValueOrigin | undefined {
  if (typeof value !== 'string') return undefined
  return callSite.literalPropOrigins?.[attrName] ?? callSite.resolvedProps?.[attrName]?.origin
}

/**
 * Builds the substitution table (§2.3) from the target component's OWN
 * destructured first-parameter pattern and the call site's literal props.
 * Only a single `{ a, b: renamed, c = 1 }`-shaped object binding pattern is
 * supported (every validation-corpus component uses one) — a non-destructured
 * parameter (`function Foo(props) {…}`), a nested pattern, or a rest element
 * yields no entry for that param, so any `{paramName}` reference to it is
 * simply left unresolved (existing lock/drop path), never guessed at.
 */
export function buildSubstitutionEnv(fn: FunctionLike, callSite: SubstitutionCallSite): Map<string, Substitution> {
  const callSiteProps = callSite.props
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

    const passedAsCode = callSite.codeProps?.includes(attrName) === true
    if (Object.hasOwn(callSiteProps, attrName)) {
      const value = callSiteProps[attrName]!
      const origin = callSiteOrigin(callSite, attrName, value)
      env.set(paramName, { kind: 'value', value, prop: attrName, ...(origin ? { origin } : passedAsCode ? { viaCode: true as const } : {}) })
      continue
    }

    // A destructure DEFAULT carries no origin — see `Substitution`.
    const initializer = element.getInitializer()
    if (!initializer) continue
    if (Node.isStringLiteral(initializer) || Node.isNumericLiteral(initializer)) {
      env.set(paramName, { kind: 'value', value: initializer.getLiteralValue(), prop: attrName, fromDefault: true, ...(passedAsCode ? { viaCode: true as const } : {}) })
    } else if (initializer.getKind() === SyntaxKind.TrueKeyword || initializer.getKind() === SyntaxKind.FalseKeyword) {
      env.set(paramName, { kind: 'value', value: initializer.getKind() === SyntaxKind.TrueKeyword, prop: attrName, fromDefault: true, ...(passedAsCode ? { viaCode: true as const } : {}) })
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
 * Walks each of the component's returns in the same shape as the element tree (JSX
 * element/self-closing/fragment/expression) purely to re-derive each
 * element's id (same `${relFile}:${line}:${col}` convention) and match it
 * against `subPage.nodes` — it does not replicate locking or capture rules,
 * only finds where to patch.
 */
export function applySubstitutions(
  roots: readonly ReturnedJsx[],
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
          sub.kind === 'value' ? [[name, { kind: 'resolved', value: toStaticValue(sub.value, sub.origin) }]] : [],
        ),
      ]),
    },
  }

  /**
   * The `ParseContext` the value readers take, minus the `eval` field each call
   * site supplies.
   */
  const readerCtx = { sourceFile, relFile, nodes }

  /** Does `fn` read this param in exactly one place? Asked at most once per param. */
  const readOnce = new Map<string, boolean>()
  const readsOnce = (paramName: string): boolean => {
    let answer = readOnce.get(paramName)
    if (answer === undefined) {
      answer = paramReadCount(fn, paramName) === 1
      readOnce.set(paramName, answer)
    }
    return answer
  }

  const patchElement = (el: JsxOpeningLike): void => {
    const isElement = Node.isJsxElement(el)
    const tagNameNode = isElement ? el.getOpeningElement().getTagNameNode() : el.getTagNameNode()
    const id = idFor(tagNameNode)
    const existing = nodes[id]
    if (existing) {
      const attributes = isElement ? el.getOpeningElement().getAttributes() : el.getAttributes()

      let patchedProps: Record<string, ParsedPropValue> | undefined
      // P3-C (WB-6) — where each value filled in below physically lives, when a
      // call site's literal is behind it. The attribute in THIS file stays code
      // (`codeProps`, from `parseJsxTree`'s catch-all), and the origin is what
      // makes it writable — at the call site, never over `{param}`.
      let patchedResolved: Record<string, Resolution> | undefined
      let patchedCodeProps: string[] | undefined
      // OD-19 — the value keys that are the bare forward of one prop. See `ParsedNode.propFeeds`.
      let patchedFeeds: Record<string, string> | undefined
      const recordFeed = (key: string, paramName: string): void => {
        const sub = env.get(paramName)
        // A call-site LITERAL string already has its own write target (`origin`); a children slot is not a value.
        if (sub?.kind !== 'value' || sub.origin || sub.viaCode || typeof sub.value === 'object' || !readsOnce(paramName)) return
        patchedFeeds ??= { ...existing.propFeeds }
        patchedFeeds[key] = sub.prop
      }
      const recordOrigin = (key: string, resolution: Resolution): void => {
        if (!resolution.origin) return
        patchedResolved ??= { ...existing.resolvedProps }
        patchedResolved[key] = {
          source: shortenSource(resolution.source),
          ...(resolution.note ? { note: resolution.note } : {}),
          origin: resolution.origin,
        }
        if (key === 'text') return // text's code-ness is `codeText`, not a `codeProps` entry
        const codeProps = patchedCodeProps ?? existing.codeProps ?? []
        if (!codeProps.includes(key)) patchedCodeProps = [...codeProps, key]
      }

      // Re-read EVERY attribute against the param-bound scope, filling only the
      // gaps `parseJsxTree` left. The loop below handles a param forwarded as a
      // bare `{paramName}`; this handles everything read OFF a param —
      // `title={plan.name}`, `label={money(plan.monthly)}`. A component that
      // takes an object and renders its fields is the normal way to write a
      // typed React component, and none of it resolved: the component's own file
      // sees `plan` as a parameter with no value anywhere in it.
      if (paramEvalContext) {
        const { props: reread, resolutionsByKey } = extractProps(
          attributes,
          { ...readerCtx, eval: paramEvalContext },
          existing.kind,
        )
        for (const [key, value] of Object.entries(reread)) {
          // A value the evaluator resolved while parsing the component ALONE can
          // be a guess: `styles[variant]` with `variant` unbound picks the map's
          // first entry (`staticEval.ts`'s dynamic-key rule). The param-bound
          // scope knows what this call site passed, so it outranks that guess —
          // otherwise every instance of a component shows its first variant.
          // A literal attribute has no `resolvedProps` entry and is never replaced.
          if (key in existing.props && (!existing.resolvedProps?.[key] || Object.is(existing.props[key], value))) continue
          patchedProps ??= { ...existing.props }
          patchedProps[key] = value
          const resolution = resolutionsByKey[key]
          if (resolution) recordOrigin(key, resolution)
        }
      }

      for (const attr of attributes) {
        if (!Node.isJsxAttribute(attr)) continue
        const attrName = attr.getNameNode().getText()
        if (attrName in existing.props) continue // already captured as a literal
        const initializer = attr.getInitializer()
        if (!initializer || !Node.isJsxExpression(initializer)) continue
        const expr = initializer.getExpression()
        if (!expr || !Node.isIdentifier(expr)) continue
        const sub = env.get(expr.getText())
        if (sub?.kind !== 'value') continue
        // A structured value forwarded onto a plain HTML element would only
        // stringify — same rule `extractProps` applies at the top level.
        if (typeof sub.value === 'object' && existing.kind !== 'component') continue
        patchedProps ??= { ...existing.props }
        patchedProps[attrName] = sub.value
        if (sub.origin) recordOrigin(attrName, { source: expr.getText(), origin: sub.origin })
        else if (attrName !== 'className') recordFeed(attrName, expr.getText())
      }

      // `<Icon svg={checkSvg}/>` → `<span dangerouslySetInnerHTML={{__html: svg}}/>`:
      // the span is the element that actually renders the markup (and carries
      // the class that sizes and colours it). Reading the `__html` expression
      // against the param-bound scope covers the corpus's two shapes with one
      // mechanism — a bare `svg` and `applyTokens(svg)` — see
      // `resolveRawSvgMarkup` for how the second one lands. `props.svg` is the
      // same key `extractRawSvgMarkup` writes, which promotes it to `base.svg`.
      if (!('svg' in (patchedProps ?? existing.props))) {
        const htmlExpr = rawHtmlValueExpression(attributes)
        const resolved = htmlExpr ? resolveRawSvgMarkup(htmlExpr, paramEvalContext) : undefined
        if (resolved !== undefined) {
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
      // The same outranking applies to a className the parse-time evaluator
      // resolved without the call site's values (`styles[variant]`, above), so
      // an expression is re-read whenever the call site passed a value at all.
      const passesValues = [...env.values()].some((sub) => sub.kind === 'value')
      if (passesValues || !('className' in (patchedProps ?? existing.props))) {
        const classNameAttr = attributes.find(
          (a): a is typeof attributes[number] & { getNameNode(): Node } =>
            Node.isJsxAttribute(a) && a.getNameNode().getText() === 'className',
        )
        const classInitializer = Node.isJsxAttribute(classNameAttr) ? classNameAttr.getInitializer() : undefined
        if (classInitializer && Node.isJsxExpression(classInitializer)) {
          const expr = classInitializer.getExpression()
          const resolved = expr ? tryResolveExpression(expr, paramEvalContext)?.value : undefined
          if (typeof resolved === 'string' && resolved.trim().length > 0) {
            if (resolved.trim() !== existing.props.className) {
              patchedProps ??= { ...existing.props }
              patchedProps.className = resolved.trim()
            }
          } else if (expr && Node.isTemplateExpression(expr) && !('className' in (patchedProps ?? existing.props))) {
            const head = templateHeadClassNames(expr)
            if (head !== undefined) {
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
        const { styles } = extractInlineStyles(attributes, { ...readerCtx, eval: paramEvalContext })
        if (styles) patchedStyles = { ...existing.inlineStyles, ...styles }
        // `style={{ width: widthValue }}` / `{ width }`: a property that IS a param.
        const styleAttr = attributes.find((a) => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'style')
        const styleInit = Node.isJsxAttribute(styleAttr) ? styleAttr.getInitializer() : undefined
        const styleObject = styleInit && Node.isJsxExpression(styleInit) ? styleInit.getExpression() : undefined
        if (styleObject && Node.isObjectLiteralExpression(styleObject)) {
          for (const property of styleObject.getProperties()) {
            if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) continue
            const nameNode = property.getNameNode()
            const key = Node.isIdentifier(nameNode) ? nameNode.getText() : Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : null
            const value = Node.isShorthandPropertyAssignment(property) ? nameNode : property.getInitializer()
            if (key !== null && value !== undefined && Node.isIdentifier(value)) recordFeed(styleValueKey(key), value.getText())
          }
        }
      }

      let patchedText = existing.text
      let patchedTextOrigin = existing.textOrigin
      if (existing.text === undefined && existing.children.length === 0 && isElement) {
        const meaningful = el
          .getJsxChildren()
          .filter((c) => !(Node.isJsxText(c) && c.getText().trim().length === 0))
        if (meaningful.length === 1 && Node.isJsxExpression(meaningful[0])) {
          const expr = meaningful[0].getExpression()
          if (expr && Node.isIdentifier(expr)) {
            const sub = env.get(expr.getText())
            // Only a scalar has a text form. `String({…})` is `[object Object]`,
            // which is worse than leaving the element empty.
            if (sub?.kind === 'value' && typeof sub.value !== 'object') {
              patchedText = String(sub.value)
              if (sub.origin) {
                patchedTextOrigin = sub.origin
                recordOrigin('text', { source: expr.getText(), origin: sub.origin })
              } else {
                recordFeed('text', expr.getText())
              }
            }
          }
        }
        // Same story as the props re-read: the text is commonly not the param
        // itself but something read off it (`{plan.name}`,
        // `{seatLabel(plan.seats)}`). Reusing `extractSingleText` keeps one
        // reader for "what counts as a text-only leaf". Its `origin` is the
        // call site's literal whenever the value passed through unchanged
        // (`{plan.name}` off a `plan` the call site read from a data module).
        if (patchedText === undefined && paramEvalContext) {
          const reread = extractSingleText(meaningful, { ...readerCtx, eval: paramEvalContext })
          patchedText = reread.text
          if (reread.origin && reread.resolution) {
            patchedTextOrigin = reread.origin
            recordOrigin('text', { ...reread.resolution, origin: reread.origin })
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
        patchedFeeds ||
        patchedStyles !== existing.inlineStyles ||
        patchedText !== existing.text ||
        patchedChildren !== existing.children
      ) {
        nodes[id] = {
          ...existing,
          ...(patchedProps ? { props: patchedProps } : {}),
          ...(patchedStyles ? { inlineStyles: patchedStyles } : {}),
          ...(patchedText !== undefined ? { text: patchedText } : {}),
          // Substituted text came from a parameter: it is code in this file
          // whether or not an origin was found for it (`codeText`'s contract).
          ...(patchedText !== undefined && patchedText !== existing.text ? { codeText: true } : {}),
          ...(patchedTextOrigin ? { textOrigin: patchedTextOrigin } : {}),
          ...(patchedResolved ? { resolvedProps: patchedResolved } : {}),
          ...(patchedCodeProps ? { codeProps: patchedCodeProps } : {}),
          ...(patchedFeeds ? { propFeeds: patchedFeeds } : {}),
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

  // Every `return` the component has — see `getReturnedJsxRoots`. Only the
  // CHOSEN one produced nodes in `subPage`; walking the non-chosen ones too is
  // harmless (their ids simply have no `existing` entry in `nodes`, so
  // `patchElement` no-ops for them) and keeps this loop from having to know
  // which is which.
  for (const root of roots) walk(root.expr)

  return { rootIds: subPage.rootIds, nodes }
}
