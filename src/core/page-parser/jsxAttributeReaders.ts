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
import { LOOP_ID_SEPARATOR, styleValueKey } from '@core/page-tree'
import type { ParsedNode, ParsedPropValue } from './types'
export { ICON_PROP_SVG_KEY, SVG_DOCUMENT_RE, rawHtmlValueExpression, resolveRawSvgMarkup } from './iconPropValues'
import {
  tryResolveExpression,
  tryResolvePropValue,
  type PageEvalContext,
  type Resolution,
  type ResolutionMap,
} from './nodeResolution'
import type { ValueOrigin } from './staticEvalTypes'
import { packagedImageImportRefusal, STUDIO_ASSET_SENTINEL } from './assetImports'
import { iconPropFromJsx, withNestedIconValues } from './iconPropValues'
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
): {
  props: Record<string, ParsedPropValue>
  resolutions: Resolution[]
  /** R2 — same facts as `resolutions`, keyed by the prop NAME they explain. See `ParsedNode.resolvedProps`. */
  resolutionsByKey: ResolutionMap
  codeProps: string[]
  /**
   * Dotted/bracketed paths to a FUNCTION nested inside a resolved object/array
   * prop value, each prefixed with the prop's own name (`toolbar.onBack`,
   * `actions[0].onClick`) — see `ParsedNode.codeFunctionPaths`.
   */
  codeFunctionPaths: string[]
  assetOrigin?: ValueOrigin
} {
  const result: Record<string, ParsedPropValue> = {}
  const resolutions: Resolution[] = []
  const resolutionsByKey: ResolutionMap = {}
  /** Names whose value came from code, not a literal attribute — see `ParsedNode.codeProps`. */
  const codeProps: string[] = []
  /** See the `codeFunctionPaths` field on this function's own return type, above. */
  const codeFunctionPaths: string[] = []
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
        resolutionsByKey[name] = { source: expression.getText(), note: resolved.note, origin: resolved.origin }
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
      // A prop whose value is a FUNCTION written in the source — `onClose={fn}`,
      // `onClick={() => …}`. It has no value the canvas can hold, so it is not
      // a resolvable expression and used to vanish here without a trace.
      //
      // The trace matters: several design-system components gate a VISIBLE
      // affordance on being handed a handler (a `BottomSheet` draws its leading
      // close button only when given `onClose`), so a dropped handler silently
      // deletes an affordance from the rendered design. Recording it in
      // `codeProps` — with no value, because there isn't one — lets a module
      // stand in a no-op and draw what the source actually asked for
      // (`src/modules/alm/register.tsx`).
      //
      // This USED to be deliberately narrow — only a function's absence of a
      // value was recorded, reasoning that every OTHER unresolvable expression
      // (a dynamic `className` interpolation included) could just vanish. That
      // narrowness was itself a silent-drop bug of the identical shape this
      // comment describes for a handler: the catch-all a few lines down now
      // records every remaining unresolvable shape the same way, so a function
      // is no longer special-cased for "leaves a trace" — only for "there is
      // definitely no value at all, so don't even try `tryResolveExpression`".
      if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
        codeProps.push(name)
        continue
      }
      if (Node.isIdentifier(expression)) {
        const refusal = packagedImageImportRefusal(expression.getSourceFile(), expression.getText())
        if (refusal !== undefined) {
          resolutions.push({ source: expression.getText(), note: refusal })
          resolutionsByKey[name] = { source: expression.getText(), note: refusal }
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
        // `structured.value` is the resolvable half of the object/array (per
        // `tryResolvePropValue`'s own doc); `structured.functionPaths` is a
        // SEPARATE fact about the same expression and survives even when the
        // value collapsed to nothing (`toolbar={{ onBack: () => {} }}` alone).
        // A design-system component routinely gates a visible affordance on a
        // handler nested INSIDE an object prop, not just a top-level one — a
        // `Navbar` draws its leading back button only when `toolbar.onBack` is
        // present — and the parser cannot hand a function to the canvas either
        // way. Recording where inside the prop it was written (never a value —
        // there isn't one) is what lets `register.tsx` stand a no-op back up at
        // exactly that nested key, the same rule the top-level handler case
        // already follows one level shallower.
        if (structured !== undefined && (structured.value !== undefined || structured.functionPaths.length > 0)) {
          if (structured.value !== undefined) {
            result[name] = withNestedIconValues(expression, structured.value, ctx.eval)
          }
          codeProps.push(name)
          for (const fnPath of structured.functionPaths) {
            // No dot before a `[N]` array-index segment — `actions[0].onClick`,
            // never `actions.[0].onClick`.
            codeFunctionPaths.push(fnPath.startsWith('[') ? `${name}${fnPath}` : `${name}.${fnPath}`)
          }
          continue
        }
        // A bare JSX element/self-closing element/fragment value is
        // `captureSlotProps`'s job (`./slotCapture.ts`, WS-3.4/E2.3) — it
        // materializes the markup as a real (locked) child node ONE LEVEL UP
        // in `processElement`, and records the prop in `codeProps` itself.
        // Recording it again here would be a harmless duplicate, but skipping
        // it is the honest choice: this function is done with the prop before
        // slot capture even runs, and claiming "code-valued, no value" for a
        // prop that is about to gain a real (if locked) node representation
        // would undersell what actually happens to it.
        if (Node.isJsxElement(expression) || Node.isJsxSelfClosingElement(expression) || Node.isJsxFragment(expression)) {
          continue
        }
      }
      // Every other shape reaching this point could not be resolved by any of
      // the paths above: an identifier bound to hook state or an unresolvable
      // const, a member/element-access chain the evaluator couldn't walk, a
      // template literal with an unresolvable interpolation (`className={
      // \`esb esb--${tone}\`}` included — this is deliberately no longer a
      // special case; see `canonicalCheck.ts`'s `static-class-name` rule,
      // which can now see this shape for the first time), a ternary/`&&`/`||`/
      // `??` whose condition isn't statically decidable, a call outside Tier
      // C's whitelist, or — on an HTML element, which stays scalar-only — a
      // JSX-valued prop, an array, or an object.
      //
      // None of these carry a representable VALUE, and that is fine — that is
      // exactly what "could not resolve" means. What is not fine is leaving no
      // trace at all: `isPropWritableToSource` treats an ABSENT `codeProps`
      // entry as "writable", so a prop the parser silently dropped used to
      // look editable in the panel, and `setJsxProp` has NO guard against
      // replacing a non-literal attribute's initializer — an edit would bake a
      // literal straight over an expression the user never even saw, deleting
      // the binding. Gated on `ctx.eval`: with the evaluator off, nothing here
      // was actually attempted (every existing caller/test that omits
      // `evalOptions` keeps its pre-§7 behaviour exactly, per this module's
      // own header comment), so there is nothing to report failing.
      if (ctx.eval) codeProps.push(name)
    }
  }

  return { props: result, resolutions, resolutionsByKey, codeProps, codeFunctionPaths, ...(assetOrigin ? { assetOrigin } : {}) }
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
  /** R2 — same facts as `resolutions`, keyed by `style:<property>` (`styleValueKey`). See `ParsedNode.resolvedProps`. */
  resolutionsByKey: ResolutionMap
  /** Style properties whose value came from code — `ParsedNode.codeProps` entries, minus the `style:` prefix the caller adds. */
  codeStyles: string[]
} {
  const styleAttr = attributes.find(
    (a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'style',
  )
  if (!styleAttr) return { styles: undefined, resolutions: [], resolutionsByKey: {}, codeStyles: [] }

  const initializer = styleAttr.getInitializer()
  if (initializer === undefined || !Node.isJsxExpression(initializer)) {
    return { styles: undefined, resolutions: [], resolutionsByKey: {}, codeStyles: [] }
  }
  const expression = initializer.getExpression()
  if (expression === undefined || !Node.isObjectLiteralExpression(expression)) {
    return { styles: undefined, resolutions: [], resolutionsByKey: {}, codeStyles: [] }
  }

  const styles: Record<string, string | number> = {}
  const resolutions: Resolution[] = []
  const resolutionsByKey: ResolutionMap = {}
  const codeStyles: string[] = []
  for (const property of expression.getProperties()) {
    // A spread element (`{ ...base, color: 'red' }`) can introduce ANY key —
    // there is no name to file a trace under, the same "genuinely cannot be
    // represented" gap `extractProps` accepts for a JSX attribute spread. A
    // method-valued property is never a usable style value either way. Both
    // are skipped with no trace, deliberately — everything else below is not.
    if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) continue
    const nameNode = property.getNameNode()
    const key = Node.isIdentifier(nameNode)
      ? nameNode.getText()
      : Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : null
    if (key === null) continue // computed keys are not statically known
    // `{ color }` shorthand — the value IS the name node, an identifier bound
    // to some local. Resolving it is the same "member/identifier chain" job
    // `tryResolveExpression` already does for `{ color: accent }`; only the
    // syntax differs.
    const valueNode = Node.isShorthandPropertyAssignment(property) ? nameNode : property.getInitializer()
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
      resolutionsByKey[styleValueKey(key)] = { source: valueNode.getText(), note: resolved.note, origin: resolved.origin }
      codeStyles.push(key)
      continue
    }
    // Same trace-not-value fix as `extractProps`' catch-all, one attribute
    // over: a style property whose value could not be resolved at all (hook
    // state, an unresolvable call/template), or that resolved to a boolean
    // (never a usable CSS value), used to vanish from BOTH `styles` and
    // `codeStyles` — leaving `style:<property>` out of `codeProps` entirely,
    // which `isStyleWritableToSource` reads as "writable". `setJsxProp` has no
    // guard against replacing a non-literal `style={{…}}` property's value
    // with a baked one, so this was the identical destructive-write hole.
    // Gated on `ctx.eval` for the same "off = unchanged pre-§7 behaviour"
    // reason `extractProps` gates its own catch-all.
    if (ctx.eval) codeStyles.push(key)
  }

  return { styles: Object.keys(styles).length > 0 ? styles : undefined, resolutions, resolutionsByKey, codeStyles }
}

/**
 * When an element's only meaningful child is a single non-whitespace text
 * node — either raw JSX text or a `{"..."}` / `{'...'}` string-literal
 * expression container — returns that trimmed string. Falls through to §7's
 * evaluator when the sole child is some OTHER expression (`{t.homepage.greeting}`,
 * `` {`${pct}%`} ``, …). Elements with element children, more than one
 * meaningful child, or an unresolvable expression get no `text` (their
 * `children` are still walked structurally by `processChildren` instead,
 * exactly as before this capture existed) — but see `hasCodeText` below for
 * why "no `text`" no longer means "nothing to say about this node".
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
): {
  text: string | undefined
  resolution?: Resolution
  origin?: ValueOrigin
  /**
   * True when the sole child WAS a non-literal expression — the source
   * genuinely computes this node's text — but §7 could not resolve it to any
   * value at all (hook state, an unresolvable call, a template with no static
   * path). Distinct from an ABSENT expression (`<span className="icon" />`,
   * no children at all): both leave `text: undefined`, but only one of them is
   * a real, different fact about the source that a "this node has no text"
   * reading silently erased. `processElement` folds this into `codeText` the
   * same way a RESOLVED text value already does — see that field's doc
   * comment in `./types` — so the panel can tell "code, unresolved" apart from
   * "genuinely nothing here" instead of rendering both as an empty, freely
   * editable field.
   */
  hasCodeText?: boolean
} {
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
      // Gated on `ctx.eval` for the same "off = unchanged pre-§7 behaviour"
      // reason `extractProps`/`extractInlineStyles` gate their own catch-alls
      // — with the evaluator off, `tryResolveExpression` never actually tried.
      if (ctx.eval) return { text: undefined, hasCodeText: true }
    }
  }

  return { text: undefined }
}

