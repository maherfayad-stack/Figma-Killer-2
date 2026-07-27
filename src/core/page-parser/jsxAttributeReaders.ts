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
import * as path from 'node:path'
import {
  Node,
  type JsxAttribute,
  type JsxSpreadAttribute,
  type SourceFile,
} from 'ts-morph'
import type { ParsedNode } from './types'
import { tryResolveExpression, type PageEvalContext, type Resolution } from './resolutionLock'

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
   * Local identifier -> workspace-relative POSIX asset path, for THIS file's
   * default-imported image specifiers only (`import esimChip from
   * '../assets/x.png'`). Built once per parse (§5.1) so `extractProps` doesn't
   * re-walk import declarations per attribute — a page can reference the same
   * imported image on many elements.
   */
  imageImports: Map<string, string>
  /**
   * §7 value resolution — present ONLY when the caller opted in (passed
   * `evalOptions` to `parsePageFile`/`parseJsxTree`). `undefined` for every
   * existing caller/test: the readers below keep their literal-only fast path
   * unconditionally and simply skip the evaluator fallback when this is absent.
   * See `./resolutionLock` for the wiring glue this feeds.
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

/** Separator between a node's source location and its `.map` iteration index. */
export const LOOP_ID_SEPARATOR = '#'

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|svg|webp|gif|avif)$/i

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
 * Sentinel prefix `extractProps` emits (§5.1) for a prop whose value is a
 * plain identifier resolving to a default-imported image asset, e.g.
 * `props.src = 'studio-asset:assets/esim-flow/figma/esim-chip.png'`.
 *
 * Deliberately NOT a URL: `@core/page-parser` has no concept of an HTTP route
 * (it also runs against a bare workspace with no server around it). Rewriting
 * this into `/admin/api/studio/asset?dir=…&path=…` is the load handler's job
 * (`server/handlers/studioPageLoad.ts`), which is the only layer that knows the
 * route shape and the project's `dir`. Exported so that layer never hardcodes
 * the prefix string.
 */
export const STUDIO_ASSET_SENTINEL = 'studio-asset:'

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
  if (!valueExpr) return undefined
  const resolved = tryResolveExpression(valueExpr, ctx.eval)?.value
  return typeof resolved === 'string' && SVG_DOCUMENT_RE.test(resolved) ? resolved : undefined
}

/**
 * Literal-valued attributes (mirrors `../ast-codemods/readJsxProps`), falling
 * through to §7's evaluator ONLY when the literal fast path misses AND the
 * caller opted in (`ctx.eval` present) — zero behaviour change, zero cost,
 * for a page that only uses literals (§7.8's non-regression guarantee).
 */
export function extractProps(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  ctx: ParseContext,
): { props: Record<string, string | number | boolean>; resolutions: Resolution[] } {
  const result: Record<string, string | number | boolean> = {}
  const resolutions: Resolution[] = []

  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue // skip {...spread} attributes

    const name = attribute.getNameNode().getText()
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
      if (Node.isIdentifier(expression)) {
        // §5.1 — a bare identifier that resolves to a default-imported image
        // (`<img src={esimChip}/>`) is captured as a sentinel path rather than
        // skipped outright, so an imported screen's images can be served
        // (see STUDIO_ASSET_SENTINEL's doc comment for why this isn't a URL
        // yet).
        const assetPath = ctx.imageImports.get(expression.getText())
        if (assetPath !== undefined) {
          result[name] = `${STUDIO_ASSET_SENTINEL}${assetPath}`
          continue
        }
      }
      // Any other expression kind (call, template, object, member access, a
      // plain identifier that isn't an image import, …) is not a literal —
      // §7's evaluator gets a shot at it now, still skipped unchanged when
      // `ctx.eval` is absent. The `style={{…}}` object is captured separately
      // by `extractInlineStyles` so the canvas can render the authored
      // inline styles.
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        result[name] = resolved.value
        resolutions.push({ source: expression.getText(), note: resolved.note })
      }
    }
  }

  return { props: result, resolutions }
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
): { styles: Record<string, string | number> | undefined; resolutions: Resolution[] } {
  const styleAttr = attributes.find(
    (a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'style',
  )
  if (!styleAttr) return { styles: undefined, resolutions: [] }

  const initializer = styleAttr.getInitializer()
  if (initializer === undefined || !Node.isJsxExpression(initializer)) return { styles: undefined, resolutions: [] }
  const expression = initializer.getExpression()
  if (expression === undefined || !Node.isObjectLiteralExpression(expression)) return { styles: undefined, resolutions: [] }

  const styles: Record<string, string | number> = {}
  const resolutions: Resolution[] = []
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
    }
  }

  return { styles: Object.keys(styles).length > 0 ? styles : undefined, resolutions }
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
 * (§7.6: a RESOLVED text value is additionally always locked, see
 * `withResolutionLock`, since writing an edit back over the original
 * expression would destroy it).
 */
export function extractSingleText(children: Node[], ctx: ParseContext): { text: string | undefined; resolution?: Resolution } {
  if (children.length !== 1) return { text: undefined }
  const only = children[0]!

  if (Node.isJsxText(only)) {
    const text = only.getText().trim()
    return { text: text.length > 0 ? text : undefined }
  }

  if (Node.isJsxExpression(only)) {
    const expression = only.getExpression()
    if (expression !== undefined) {
      if (Node.isStringLiteral(expression)) return { text: expression.getLiteralValue() }
      const resolved = tryResolveExpression(expression, ctx.eval)
      if (resolved) {
        return { text: String(resolved.value), resolution: { source: expression.getText(), note: resolved.note } }
      }
    }
  }

  return { text: undefined }
}

/**
 * Maps `sourceFile`'s default-imported identifiers to a workspace-relative
 * POSIX asset path, for import specifiers that look like an image
 * (`import esimChip from '../assets/esim-flow/figma/esim-chip.png'`) — §5.1.
 *
 * Only RELATIVE specifiers are resolved (this is plain `path` resolution, not
 * module resolution: ts-morph's `Project` only tracks `.ts/.tsx/.js/.jsx`
 * files — see `createWorkspaceProject` — so a `.png` specifier never resolves
 * to a real `SourceFile` the way `classifyImport` in `componentSources.ts`
 * resolves a component import; there is nothing to reuse there beyond the
 * containment-check shape, which this mirrors). A bare/aliased specifier
 * (`@/assets/x.png`) is out of scope — same "small, contained widening" as
 * the rest of `extractProps`.
 *
 * A specifier that resolves outside `workspaceRoot` is dropped rather than
 * ever handed to a caller as a path — the asset-serving endpoint (§5.3) has
 * its own containment guard too, but the parser should never manufacture an
 * escaping path in the first place.
 */
export function buildImageImportMap(sourceFile: SourceFile, workspaceRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  const root = path.resolve(workspaceRoot)

  for (const declaration of sourceFile.getImportDeclarations()) {
    const defaultImport = declaration.getDefaultImport()
    if (!defaultImport) continue

    const specifier = declaration.getModuleSpecifierValue()
    if (!specifier.startsWith('.') || !IMAGE_EXTENSION_RE.test(specifier)) continue

    const absolute = path.resolve(path.dirname(sourceFile.getFilePath()), specifier)
    const relFromRoot = path.relative(root, absolute)
    const insideRoot = relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)
    if (!insideRoot) continue

    map.set(defaultImport.getText(), relFromRoot.split(path.sep).join('/'))
  }

  return map
}
