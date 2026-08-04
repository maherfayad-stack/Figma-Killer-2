/**
 * jsxAttributeReaders — reads concrete VALUES off a JSX element's attributes
 * and text children: props, inline styles, the single-text-leaf case, and the
 * raw SVG an element injects via `dangerouslySetInnerHTML`.
 *
 * Split out of `parsePageFile.ts` to stay under the module-size ceiling, along
 * a clean seam: that module walks TREE STRUCTURE (which elements exist, how
 * they nest, what is locked); this one answers "what value does this attribute
 * hold?" for one element at a time. Every function here is a pure read against
 * `ParseContext` — none of them touch `ctx.nodes`.
 *
 * Each reader takes the literal fast path first and only falls through to §7's
 * evaluator when the caller opted in (`ctx.eval` present), so a page that uses
 * nothing but literals costs exactly what it did before §7 existed.
 */
import {
  Node,
  type JsxAttribute,
  type JsxSpreadAttribute,
  type SourceFile,
} from 'ts-morph'
import { LOOP_ID_SEPARATOR } from '@core/page-tree'
import type { ParsedNode, ParsedPropValue } from './types'
import { tryResolveExpression, tryResolvePropValue, type PageEvalContext, type Resolution } from './nodeResolution'
import type { ValueOrigin } from './staticEvalTypes'
import { packagedImageImportRefusal, STUDIO_ASSET_SENTINEL } from './assetImports'
import { decodeJsxTextEntities } from './jsxTextEntities'

/**
 * Everything one parse pass needs to read values and record nodes. Built once
 * per parse by `parseJsxTree`; owned here because these readers are its main
 * consumers.
 */
export interface ParseContext {
  sourceFile: SourceFile
  /** appDir-relative POSIX path, precomputed once per parse. */
  relFile: string
  nodes: Record<string, ParsedNode>
  /**
   * §7 value resolution — present ONLY when the caller opted in (passed
   * `evalOptions` to `parsePageFile`/`parseJsxTree`). `undefined` for every
   * existing caller/test: the readers below keep their literal-only fast path
   * unconditionally and simply skip the evaluator fallback when this is absent.
   * See `./nodeResolution` for the wiring glue this feeds.
   */
  eval?: PageEvalContext
  /**
   * Appended to every node id minted under this context, to distinguish
   * iterations of an expanded `.map` (`…:70:21#0`, `…:70:21#1`, …) — one piece
   * of source JSX legitimately produces N nodes, and without this they would
   * collide on the single source location and destroy the flat node map. Nested
   * loops chain segments. See `staticLoopExpansion`.
   *
   * Deliberately makes the id stop matching `NODE_LOC_ID`, so the writeback
   * guards reject it: there is no single source location an edit to row 3 could
   * land on that would not rewrite every row.
   */
  idSuffix?: string
}

/**
 * Separator between a node's source location and its `.map` iteration index.
 * Declared in `@core/page-tree`'s `sourceNodeId` with the rest of the id grammar
 * — including the reason an id carrying it has no writable source location —
 * and re-exported here because this is where the suffix is applied.
 */
export { LOOP_ID_SEPARATOR }

/**
 * Markup that actually opens an `<svg>` document.
 *
 * This prop can carry any HTML, and handing arbitrary markup to `base.svg` —
 * whose whole contract is "an inline SVG" — would be a category error. Exported
 * for `inlineLocalComponents`, which applies the same test to a value it
 * substitutes in from a call site.
 */
export const SVG_DOCUMENT_RE = /^\s*<svg[\s>]/i

/**
 * The `<expr>` inside `dangerouslySetInnerHTML={{ __html: <expr> }}`, or
 * `undefined` when this element has no such attribute (or writes it in a shape
 * this parser does not read — a spread, a call, a non-literal object).
 *
 * Split out from `extractRawSvgMarkup` because two callers need this one shape
 * and resolve `<expr>` differently: the parser hands it to §7's evaluator, while
 * `inlineLocalComponents` looks it up in a call site's substitution env (a
 * component parameter has no value the evaluator could reach). Sharing the
 * reader keeps "how the attribute is written" in one place.
 */
export function rawHtmlValueExpression(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
): Node | undefined {
  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    if (attribute.getNameNode().getText() !== 'dangerouslySetInnerHTML') continue

    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) return undefined
    const objectExpr = initializer.getExpression()
    if (!objectExpr || !Node.isObjectLiteralExpression(objectExpr)) return undefined

    const htmlProp = objectExpr.getProperty('__html')
    return htmlProp && Node.isPropertyAssignment(htmlProp) ? htmlProp.getInitializer() : undefined
  }
  return undefined
}

/**
 * The raw SVG markup an element injects via
 * `dangerouslySetInnerHTML={{ __html: <expr> }}`, or `undefined`.
 *
 * `<expr>` goes through §7's evaluator, which resolves a `?raw` text import
 * (`resolveRawTextImport` in `./staticEvalCore`) as well as a local alias, a
 * member chain, or a value substituted in from a call site — so this one path
 * covers `<span dangerouslySetInnerHTML={{__html: checkSvg}} />` written
 * directly. The far more common `<Icon svg={checkSvg} />` reaches the same span
 * through `inlineLocalComponents`, which substitutes the `svg` param into this
 * same attribute — a component parameter has no value for §7 to resolve here.
 *
 * Only markup that actually opens an `<svg>` document is returned — see
 * `SVG_DOCUMENT_RE`.
 */
export function extractRawSvgMarkup(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
): string | undefined {
  const valueExpr = rawHtmlValueExpression(attributes)
  return valueExpr ? resolveRawSvgMarkup(valueExpr, ctx.eval) : undefined
}

/**
 * The SVG markup a `__html` expression yields — the resolved value when §7 can
 * evaluate it, otherwise the markup its TRANSFORM was handed.
 *
 * The fallback exists because the common real shape is not a bare identifier but
 * `__html: applyTokens(svg)`, where `applyTokens` LOOPS over a substitution
 * table swapping hardcoded hex fills for design tokens. A loop over a resolved
 * array in a callee's body is a statement-level evaluation the §7 evaluator does
 * not do, so the call returns unresolved — and 9 illustration icons on the eSIM
 * corpus's homepage rendered as blank 48px boxes with their markup sitting in
 * plain sight one argument away.
 *
 * What this gives up, stated plainly: the icon renders with the fills the source
 * file holds rather than the ones the transform would have produced (here, real
 * hex instead of `var(--color-aqua-*)`, so it does not follow a dark theme). That
 * is the same trade `applySubstitutions` already makes for a computed
 * `className`, keeping the static prefix for visual fidelity — and it beats a
 * blank box, which tells the user nothing about their screen.
 *
 * Deliberately ONE call level deep and argument-order-first: this recovers the
 * input of a transform, it does not try to guess at nested composition.
 *
 * Exported for `componentSubstitution`, which re-reads the same attribute against
 * a call site's param-bound scope.
 */
export function resolveRawSvgMarkup(valueExpr: Node, evalCtx: PageEvalContext | undefined): string | undefined {
  const direct = tryResolveExpression(valueExpr, evalCtx)?.value
  if (typeof direct === 'string' && SVG_DOCUMENT_RE.test(direct)) return direct

  if (!Node.isCallExpression(valueExpr)) return undefined
  for (const argument of valueExpr.getArguments()) {
    const inner = tryResolveExpression(argument, evalCtx)?.value
    if (typeof inner === 'string' && SVG_DOCUMENT_RE.test(inner)) return inner
  }
  return undefined
}

/**
 * The value shape a JSX-valued icon prop is captured as: `{ svg: markup }`.
 *
 * `<Cell icon={<Icon svg={rewardCardSvg}/>}/>` is how a design system's icon
 * slots are actually filled, and a React element has no JSON form — so the prop
 * was skipped and the cell rendered with an empty visual slot (8 of them across
 * the eSIM corpus, in `Cell`, `GlassButton`, and the `leadingIcon`/`trailingIcon`
 * slots).
 *
 * `svg` is the SAME key a node carrying raw markup uses (`resolveModuleId`
 * promotes such a node to `base.svg`), so this is one convention read at two
 * altitudes rather than a new one: a value holding `svg` IS inline SVG. The
 * module layer turns it back into an element — see `src/modules/alm/register.tsx`.
 */
export const ICON_PROP_SVG_KEY = 'svg'

/**
 * The inline SVG markup a JSX-valued prop's element renders, as
 * `{ svg: markup }`, or `undefined` when the element yields no markup.
 *
 * Reads only the element's OWN attributes, one level deep: its
 * `dangerouslySetInnerHTML` (the `<span dangerouslySetInnerHTML/>` shape), or any
 * attribute whose value resolves to a string that opens an `<svg>` document
 * (the `<Icon svg={…}/>` shape, where the wrapper component is what would
 * eventually inject it). Anything else — a nested layout, a component whose
 * markup only materialises after inlining — declines, and the prop stays absent
 * rather than being guessed at.
 */
function iconPropFromJsx(
  expression: Node,
  evalCtx: PageEvalContext | undefined,
): Record<string, string> | undefined {
  if (!Node.isJsxElement(expression) && !Node.isJsxSelfClosingElement(expression)) return undefined
  const attributes = Node.isJsxElement(expression)
    ? expression.getOpeningElement().getAttributes()
    : expression.getAttributes()

  const rawHtml = rawHtmlValueExpression(attributes)
  const injected = rawHtml ? resolveRawSvgMarkup(rawHtml, evalCtx) : undefined
  if (injected !== undefined) return { [ICON_PROP_SVG_KEY]: injected }

  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) continue
    const inner = initializer.getExpression()
    if (!inner) continue
    const resolved = tryResolveExpression(inner, evalCtx)?.value
    if (typeof resolved === 'string' && SVG_DOCUMENT_RE.test(resolved)) {
      return { [ICON_PROP_SVG_KEY]: resolved }
    }
  }
  return undefined
}

/**
 * Attributes this reader never captures, because another reader owns them and
 * would end up duplicated (or actively broken) by a second copy in `props`:
 * `extractInlineStyles` owns `style`, and `extractRawSvgMarkup` owns
 * `dangerouslySetInnerHTML` (whose value it promotes to the `svg` prop).
 *
 * Before structured props existed this was implicit — both attributes are
 * object literals, and the scalar-only evaluator fallback declined them. Now
 * that an object resolves, the exclusion has to be stated.
 */
const READER_OWNED_ATTRIBUTES: ReadonlySet<string> = new Set(['style', 'dangerouslySetInnerHTML'])

/**
 * Literal-valued attributes (mirrors `../ast-codemods/readJsxProps`), falling
 * through to §7's evaluator ONLY when the literal fast path misses AND the
 * caller opted in (`ctx.eval` present) — zero behaviour change, zero cost,
 * for a page that only uses literals (§7.8's non-regression guarantee).
 *
 * `kind` decides whether an array/object value is captured at all. A COMPONENT
 * consumes a structured prop as a real JS value (`<ActionSheet actions={[…]}/>`
 * renders one button per entry); an HTML ELEMENT cannot — an attribute is a
 * string, so an object there would only ever stringify to `[object Object]`.
 * Restricting it this way also keeps `base.*` modules and the publisher's
 * prop-escaping on the scalar diet they were written for.
 */
export function extractProps(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
  kind: ParsedNode['kind'] = 'element',
): { props: Record<string, ParsedPropValue>; resolutions: Resolution[]; codeProps: string[]; assetOrigin?: ValueOrigin } {
  const result: Record<string, ParsedPropValue> = {}
  const resolutions: Resolution[] = []
  /** Names whose value came from code, not a literal attribute — see `ParsedNode.codeProps`. */
  const codeProps: string[] = []
  // First resolved import-backed asset value wins — mirrors `textOrigin`'s
  // "only the first" scoping (see its doc comment in `./types`): a node
  // rarely has more than one image-shaped prop, and picking one honest target
  // beats guessing which of several an edit meant.
  let assetOrigin: ValueOrigin | undefined

  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue // skip {...spread} attributes

    const name = attribute.getNameNode().getText()
    if (READER_OWNED_ATTRIBUTES.has(name)) continue
    const initializer = attribute.getInitializer()

    if (initializer === undefined) {
      // Valueless shorthand (`<Foo primary />`) is JSX sugar for `true`.
      result[name] = true
      continue
    }

    if (Node.isStringLiteral(initializer)) {
      result[name] = initializer.getLiteralValue()
      continue
    }

    if (Node.isJsxExpression(initializer)) {
      const expression = initializer.getExpression()
      if (expression === undefined) continue

      if (Node.isNumericLiteral(expression)) {
        result[name] = expression.getLiteralValue()
        continue
      }
      if (Node.isStringLiteral(expression)) {
        result[name] = expression.getLiteralValue()
        continue
      }
      if (Node.isTrueLiteral(expression)) {
        result[name] = true
        continue
      }
      if (Node.isFalseLiteral(expression)) {
        result[name] = false
        continue
      }
      // Any other expression kind (call, template, object, member access, a
      // plain identifier, …) is not a literal — §7's evaluator gets a shot at
      // it now, still skipped unchanged when `ctx.eval` is absent. An imported
      // image (`<img src={esimChip}/>`, `src={deal.image}`) resolves through
      // here too, as a `studio-asset:` path — see `resolveImageAssetImport`.
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        result[name] = resolved.value
        resolutions.push({ source: expression.getText(), note: resolved.note })
        // The value shown is what the expression evaluates to; the source holds
        // the expression. Writing an edit here would replace the binding with a
        // baked literal, so this one prop is not a writeback target — UNLESS
        // it's an import-backed asset (see below), which has a different, honest
        // target one hop away.
        codeProps.push(name)
        // An image import (`src={heroImg}`) resolves to a `studio-asset:` value
        // carrying the import specifier's own location — see
        // `resolveImageAssetImport`. That is `ParsedNode.assetOrigin`, the one
        // honest writeback target for this prop (WS-8.3): editing it rewrites
        // the IMPORT, never the JSX (which stays `src={heroImg}` unchanged).
        if (
          assetOrigin === undefined &&
          resolved.origin !== undefined &&
          typeof resolved.value === 'string' &&
          resolved.value.startsWith(STUDIO_ASSET_SENTINEL)
        ) {
          assetOrigin = resolved.origin
        }
        continue
      }
      // An image imported from an INSTALLED PACKAGE is refused on purpose
      // (`resolveImageAssetImport` passes `allowBare: false`), and until now it
      // was refused silently: the prop simply vanished, so `<img
      // src={packagedIcon}/>` reached the canvas as a `base.image` with no
      // `src` and drew the same "No image selected" placeholder an `<img>` with
      // no source at all draws. Those two are not the same fact, and conflating
      // them taught the agent that Studio could not render the design system's
      // icon set — so it hand-drew SVG path data instead of adding `?raw` to
      // the specifier.
      //
      // Recorded as a `Resolution` note (which `SourceConstraintNotice` shows)
      // plus a `codeProps` entry, keeping `withResolution`'s invariant that
      // every resolution recorded here has a matching code-valued prop: the
      // value does come from code, and no scalar may be written over it.
      if (Node.isIdentifier(expression)) {
        const refusal = packagedImageImportRefusal(expression.getSourceFile(), expression.getText())
        if (refusal !== undefined) {
          resolutions.push({ source: expression.getText(), note: refusal })
          codeProps.push(name)
          continue
        }
      }
      // A component's prop may also be an array/object. No `Resolution` is
      // recorded for it — see `tryResolvePropValue` for why a structured value
      // must not lock the node the way a resolved scalar does. It is still
      // code-valued: `setJsxProp` writes scalars, and there is no scalar form of
      // an array or a JSX element to write.
      if (kind === 'component') {
        const icon = iconPropFromJsx(expression, ctx.eval)
        if (icon !== undefined) {
          result[name] = icon
          codeProps.push(name)
          continue
        }
        const structured = tryResolvePropValue(expression, ctx.eval)
        if (structured !== undefined) {
          result[name] = structured
          codeProps.push(name)
        }
      }
    }
  }

  return { props: result, resolutions, codeProps, ...(assetOrigin ? { assetOrigin } : {}) }
}

/**
 * Flatten an element's `style={{ … }}` object-literal attribute into its
 * literal (string/number) entries, so the canvas renders the inline styles
 * actually authored in source (`node.inlineStyles` → `NodeRenderer`). Mirrors
 * `extractProps`' literal-fast-path-then-evaluator-fallback policy: a
 * property whose value isn't a string/number literal (an identifier, a
 * `var(--x)` reference held in a const, a template, …) falls through to §7's
 * evaluator (still skipped when `ctx.eval` is absent). Returns `styles:
 * undefined` when there's no `style` attribute, it isn't a plain object
 * literal, or it has no resolvable entries.
 */
export function extractInlineStyles(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
): {
  styles: Record<string, string | number> | undefined
  resolutions: Resolution[]
  /** Style properties whose value came from code — `ParsedNode.codeProps` entries, minus the `style:` prefix the caller adds. */
  codeStyles: string[]
} {
  const styleAttr = attributes.find(
    (a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'style',
  )
  if (!styleAttr) return { styles: undefined, resolutions: [], codeStyles: [] }

  const initializer = styleAttr.getInitializer()
  if (initializer === undefined || !Node.isJsxExpression(initializer)) {
    return { styles: undefined, resolutions: [], codeStyles: [] }
  }
  const expression = initializer.getExpression()
  if (expression === undefined || !Node.isObjectLiteralExpression(expression)) {
    return { styles: undefined, resolutions: [], codeStyles: [] }
  }

  const styles: Record<string, string | number> = {}
  const resolutions: Resolution[] = []
  const codeStyles: string[] = []
  for (const property of expression.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue // skip shorthand / spread / methods
    const nameNode = property.getNameNode()
    const key = Node.isIdentifier(nameNode)
      ? nameNode.getText()
      : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : null
    if (key === null) continue // computed keys are not statically known
    const valueNode = property.getInitializer()
    if (valueNode === undefined) continue
    if (Node.isStringLiteral(valueNode)) {
      styles[key] = valueNode.getLiteralValue()
      continue
    }
    if (Node.isNumericLiteral(valueNode)) {
      styles[key] = valueNode.getLiteralValue()
      continue
    }
    // Non-literal values (var refs, calls, templates, nested objects) fall
    // through to §7's evaluator — e.g. a `const accent = 'var(--text-link-default)'`
    // reference, or `width: \`${pct}%\``. A style value is never boolean, so a
    // resolved boolean (unlike for `extractProps`) isn't a usable style value.
    const resolved = tryResolveExpression(valueNode, ctx.eval)
    if (resolved && typeof resolved.value !== 'boolean') {
      styles[key] = resolved.value
      resolutions.push({ source: valueNode.getText(), note: resolved.note })
      codeStyles.push(key)
    }
  }

  return { styles: Object.keys(styles).length > 0 ? styles : undefined, resolutions, codeStyles }
}

/**
 * When an element's only meaningful child is a single non-whitespace text
 * node — either raw JSX text or a `{"..."}` / `{'...'}` string-literal
 * expression container — returns that trimmed string. Falls through to §7's
 * evaluator when the sole child is some OTHER expression (`{t.homepage.greeting}`,
 * `` {`${pct}%`} ``, …). Elements with element children, more than one
 * meaningful child, or an unresolvable expression get no `text` (their
 * `children` are still walked structurally by `processChildren` instead,
 * exactly as before this capture existed).
 *
 * Mirrors `assertTextOnlyChildren` in `../ast-codemods/setJsxText` — a
 * captured `text` is always a shape that codemod is willing to overwrite
 * (§7.6: a RESOLVED text value is additionally always read-only ON THAT PROP,
 * via `codeText` -> `codeProps`, since writing an edit back over the original
 * expression would destroy it — unless `textOrigin` names the literal it read,
 * which is somewhere honest to land).
 */
export function extractSingleText(
  children: Node[],
  ctx: ParseContext,
): { text: string | undefined; resolution?: Resolution; origin?: ValueOrigin } {
  if (children.length !== 1) return { text: undefined }
  const only = children[0]!

  if (Node.isJsxText(only)) {
    // Decoded because React decodes: the AST hands back the authored source,
    // so `it&apos;s` would otherwise reach the canvas with the entity visible.
    const text = decodeJsxTextEntities(only.getText().trim())
    return { text: text.length > 0 ? text : undefined }
  }

  if (Node.isJsxExpression(only)) {
    const expression = only.getExpression()
    if (expression !== undefined) {
      if (Node.isStringLiteral(expression)) return { text: expression.getLiteralValue() }
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        return {
          text: String(resolved.value),
          resolution: { source: expression.getText(), note: resolved.note },
          // Where the string actually lives, so an edit can be written there
          // instead of over the expression. See `ParsedNode.textOrigin`.
          origin: resolved.origin,
        }
      }
    }
  }

  return { text: undefined }
}

