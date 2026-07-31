/**
 * parsePageFile — parses a React page `.tsx` file into a neutral, flat
 * element/instance tree (see `types.ts`).
 *
 * This is the read half of a design-tool's load step: it walks the JSX
 * returned by the page's exported component and produces one `ParsedNode`
 * per JSXElement/JSXSelfClosingElement, with a source location that is
 * compatible with `../ast-codemods` (same tag-name-start convention), plus
 * "editable-surface" locking for JSX that is rendered dynamically (from a
 * `.map(...)` callback, a conditional/logical expression, or via spread
 * props) rather than structurally present in the static tree.
 *
 * LOCATION CONVENTION (must match `../source-tags` and `../ast-codemods`):
 * 1-based line, 1-based column of the JSX element's tag-name identifier
 * start (the character immediately after `<`). Using ts-morph, that's
 * `tagNameNode.getStart()` converted via `sourceFile.getLineAndColumnAtPos`,
 * which already returns 1-based line/column.
 */
import * as path from 'node:path'
import {
  Node,
  Project,
  SyntaxKind,
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  type JsxSpreadAttribute,
  type SourceFile,
} from 'ts-morph'
import type { BranchAlternative, FunctionLike, NodeLoc, ParsedNode, ParsedPage, ParsedPropValue } from './types'
import { createEvalScope, type StaticEvalOptions } from './staticEval'
import { withResolutionLock } from './resolutionLock'
import {
  getReturnedJsxRoots,
  isLockingExpression,
  selectJsxBranch,
  unwrapParens,
  type ReturnedJsx,
} from './branchSelection'
import { studioSlotValue } from '@core/utils/studioSlotSentinel'
import {
  extractInlineStyles,
  extractProps,
  extractRawSvgMarkup,
  extractSingleText,
  LOOP_ID_SEPARATOR,
  type ParseContext,
} from './jsxAttributeReaders'
import { iterationEvalContext, loopCallbackBody, readStaticLoop } from './staticLoopExpansion'
import { serializeInlineSvg } from './inlineSvg'

// Re-exported so every existing `from './parsePageFile'` import (`index.ts`,
// `inlineLocalComponents.ts`, `nextAppLayout.ts`, `componentSubstitution.ts`)
// keeps working unchanged — the branch-SELECTION decision moved to its own
// module (`./branchSelection`, parser-06) purely for the module-size budget;
// this file still owns finding a component's declaration and walking its JSX.
export { getReturnedJsxRoots }
export type { ReturnedJsx }

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

const DYNAMIC_LOCK_REASON = 'dynamic — rendered in code'
const SPREAD_LOCK_REASON = 'spread props'
const DYNAMIC_SVG_LOCK_REASON = 'SVG built in code'
/** WS-3.4 — a component prop's JSX value, materialized as a real child node. See `captureSlotProps`. */
const SLOT_LOCK_REASON = 'slot content — fills a component prop'

/**
 * `project` defaults to a fresh, single-file `Project` (this file only) —
 * exactly the isolated behavior every existing caller relies on. Pass a
 * shared, workspace-wide `Project` (`../page-parser` → `createWorkspaceProject`)
 * when parsing every page of one workspace load, so cross-file imports (a
 * page importing a local component) can later be resolved against the SAME
 * parsed `SourceFile` via `resolveComponentSources` — a fresh per-file
 * Project can't see other files at all.
 */
export function parsePageFile(
  file: string,
  appDir: string,
  project: Project = new Project({ useInMemoryFileSystem: false }),
  evalOptions?: StaticEvalOptions,
): ParsedPage {
  try {
    const sourceFile = project.getSourceFile(file) ?? project.addSourceFileAtPath(file)
    const relFile = path.relative(appDir, path.resolve(file)).split(path.sep).join('/')

    const componentDecl = findComponentDeclaration(sourceFile)
    const fn = componentDecl ? getFunctionLikeNode(componentDecl) : undefined
    const roots = fn ? getReturnedJsxRoots(fn) : []

    if (roots.length === 0) return { rootIds: [], nodes: {} }

    return parseJsxTree(roots, sourceFile, relFile, fn, evalOptions)
  } catch {
    // Never throw on ordinary pages — anything unexpected just yields an
    // empty (unparsed) page rather than a crash for the caller.
    return { rootIds: [], nodes: {} }
  }
}

/**
 * Walks `rootExpr` (the JSX a component's return statement produces) into a
 * `ParsedPage`, exactly the tree-walk `parsePageFile` runs for a whole page —
 * extracted so `inlineLocalComponents` (§2) can reuse the SAME walk for a
 * local component's own returned JSX rather than re-implementing
 * `processElement`/`processChildren`/the locking rules/svg capture/etc.
 * `relFile` is the workspace-relative POSIX path to attribute produced node
 * ids and locations to (the component's OWN file when called for inlining,
 * not the page that references it).
 *
 * Not wrapped in try/catch itself — `parsePageFile` and `inlineLocalComponents`
 * each own their own top-level guard, since what "failure degrades to" differs
 * (an empty page vs. leaving one call site un-inlined).
 *
 * `componentFn`/`evalOptions` (§7) opt this parse into value resolution:
 * `componentFn` is the component whose OWN JSX this is (supplies its
 * component-body `const`/hook-destructuring bindings to the evaluator's
 * scope — see `createEvalScope`), and `evalOptions` carries the evaluator's
 * tuning plus the page-wide step budget shared across the whole page load,
 * including every locally-inlined subtree (`inlineLocalComponents` threads
 * the SAME `evalOptions` into its own recursive `parseJsxTree` calls). Both
 * are omitted by every caller that hasn't opted in — `extractProps`/
 * `extractInlineStyles`/`extractSingleText` then keep their pre-§7 literal-
 * only behaviour exactly, at zero extra cost.
 */
export function parseJsxTree(
  roots: readonly ReturnedJsx[],
  sourceFile: SourceFile,
  relFile: string,
  componentFn?: FunctionLike,
  evalOptions?: StaticEvalOptions,
): ParsedPage {
  const ctx: ParseContext = {
    sourceFile,
    relFile,
    nodes: {},
    ...(evalOptions ? { eval: { scope: createEvalScope(sourceFile, componentFn), options: evalOptions } } : {}),
  }
  // One `ctx` across every return, so ids and the eval budget are shared: two
  // returns in one component can never collide (their JSX is at different
  // source locations) and the page-wide step budget stays page-wide.
  //
  // Only the CHOSEN return(s) — see `getReturnedJsxRoots` — are walked into
  // real nodes. A NOT-chosen return contributes nothing to `ctx.nodes`: it is
  // recorded as a `BranchAlternative` (label + its own location) on whichever
  // chosen node ends up at the top of the tree, never materialized. That is
  // the parser-06 policy change — every `return` used to render, stacked and
  // locked; now exactly one does, unlocked, with the rest addressable but
  // invisible by default.
  const chosenRoots = roots.filter((root) => root.chosen)
  const alternateRoots = roots.filter((root) => !root.chosen)

  const rootIds = chosenRoots.flatMap((root) => collectRootIds(root, ctx))

  if (alternateRoots.length > 0 && rootIds.length > 0) {
    const alternatives: BranchAlternative[] = alternateRoots.map((root) => {
      const { line, column } = sourceFile.getLineAndColumnAtPos(root.expr.getStart())
      return { label: root.label ?? 'other branch', loc: { file: relFile, line, col: column } }
    })
    const note = `showing the final return; ${alternatives.length} other branch${
      alternatives.length === 1 ? '' : 'es'
    } not shown: ${alternatives.map((a) => a.label).join(', ')}`
    for (const id of rootIds) {
      const node = ctx.nodes[id]
      if (!node) continue
      ctx.nodes[id] = {
        ...node,
        branchAlternatives: alternatives,
        // Don't clobber a resolution the evaluator already recorded for THIS
        // node (e.g. its own text/prop resolved) — see `resolution`'s "only
        // the first" policy in `./types.ts`.
        ...(node.resolution ? {} : { resolution: { source: relFile, note } }),
      }
    }
  }

  return { rootIds, nodes: ctx.nodes }
}

// ---------------------------------------------------------------------------
// Component discovery: find the page's exported React component and the
// JSX it returns.
// ---------------------------------------------------------------------------

/**
 * Finds the declaration of the page's exported React component:
 *   1. `export default function Foo() {...}`
 *   2. `export default Foo` / `export default () => {...}` (resolves the
 *      identifier back to its local function/const declaration)
 *   3. The first exported function declaration or `const` with a
 *      function/arrow initializer, in source order.
 */
export function findComponentDeclaration(sourceFile: SourceFile): Node | undefined {
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isDefaultExport()) return fn
  }

  const exportAssignment = sourceFile.getExportAssignments().find((ea) => !ea.isExportEquals())
  if (exportAssignment) {
    const expr = exportAssignment.getExpression()
    if (Node.isIdentifier(expr)) {
      const declarations = expr.getSymbol()?.getDeclarations() ?? []
      const match = declarations.find((d) => Node.isVariableDeclaration(d) || Node.isFunctionDeclaration(d))
      if (match) return match
    } else if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      return expr
    }
  }

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isExported()) {
      return statement
    }
    if (Node.isVariableStatement(statement) && statement.isExported()) {
      for (const decl of statement.getDeclarations()) {
        const init = decl.getInitializer()
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return decl
        }
      }
    }
  }

  return undefined
}

/** Unwraps a `VariableDeclaration` down to its function/arrow initializer. */
export function getFunctionLikeNode(decl: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) {
    return decl
  }
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer()
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// JSX tree walk
//
// `ReturnedJsx`/`getReturnedJsxRoots` (which `return` renders) and
// `selectJsxBranch`/`isLockingExpression` (which side of a ternary/`&&`
// renders) live in `./branchSelection` — imported above, `getReturnedJsxRoots`
// re-exported above too. This section owns the actual WALK: turning the
// chosen JSX into `ParsedNode`s.
// ---------------------------------------------------------------------------

function collectRootIds(root: ReturnedJsx, ctx: ParseContext): string[] {
  const { expr: rootExpr } = root
  // `root` here is always the CHOSEN return — see `parseJsxTree`, which never
  // calls this for one of `getReturnedJsxRoots`'s non-chosen entries. So there
  // is no branch-selection lock to apply at this level any more; the only
  // remaining question is whether the return's own expression is itself
  // genuinely dynamic (a call, `||`) — same as any other JSX-bearing `{...}`.
  if (Node.isJsxElement(rootExpr) || Node.isJsxSelfClosingElement(rootExpr)) {
    return [processElement(rootExpr, ctx, false, undefined)]
  }
  if (Node.isJsxFragment(rootExpr)) {
    return processChildren(rootExpr.getJsxChildren(), ctx, false, undefined)
  }
  // The component's own return is itself a dynamic expression (e.g.
  // `return cond ? <A/> : <B/>`) — walk it through the same branch-selection
  // rule a nested `{...}` child gets (`collectFromExpression`/`selectJsxBranch`).
  const triggers = isLockingExpression(rootExpr)
  return collectFromExpression(rootExpr, ctx, triggers, triggers ? DYNAMIC_LOCK_REASON : undefined)
}

/**
 * The three JSX-bearing shapes an expression can take, dispatched the same way
 * everywhere: an element, a fragment, or something that merely *contains* JSX.
 *
 * `collectFromExpression` walks DESCENDANTS, so it never sees an expression that
 * is itself an element — hence this wrapper rather than calling it directly.
 */
function collectJsx(
  expr: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
): string[] {
  if (Node.isJsxElement(expr) || Node.isJsxSelfClosingElement(expr)) {
    return [processElement(expr, ctx, locked, reason)]
  }
  if (Node.isJsxFragment(expr)) {
    return processChildren(expr.getJsxChildren(), ctx, locked, reason)
  }
  return collectFromExpression(expr, ctx, locked, reason)
}

/**
 * Expands `items.map(item => <Row/>)` into one subtree per item, or returns
 * `undefined` to leave the expression opaque (today's single locked
 * placeholder). See `staticLoopExpansion` for what qualifies and why this is
 * not the banned "execute the code" tier.
 */
function expandStaticLoop(expr: Node, ctx: ParseContext): string[] | undefined {
  const evalCtx = ctx.eval
  if (!evalCtx) return undefined
  const loop = readStaticLoop(expr, evalCtx)
  if (!loop) return undefined
  const body = loopCallbackBody(loop.callback)
  if (!body) return undefined

  const ids: string[] = []
  loop.items.forEach((item, index) => {
    const iterationCtx: ParseContext = {
      ...ctx,
      eval: iterationEvalContext(loop, item, index, evalCtx),
      idSuffix: `${ctx.idSuffix ?? ''}${LOOP_ID_SEPARATOR}${index}`,
    }
    // Locked with a reason naming the item, not the generic dynamic-surface
    // message: the row IS resolved, it just has no isolated place to write to.
    ids.push(...collectJsx(body, iterationCtx, true, `item ${index + 1} of ${loop.sourceText}`))
  })
  return ids
}

/**
 * The `ParsedNode.codeProps` list for one element: prop names whose value is
 * code, plus its style properties under the `style:` prefix the editor's
 * inline-style surface reads back.
 */
function codePropNames(propNames: string[], styleNames: string[]): string[] {
  return [...propNames, ...styleNames.map((key) => `style:${key}`)]
}

/** Creates the `ParsedNode` for one JSXElement/JSXSelfClosingElement. */
function processElement(
  element: JsxOpeningLike,
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
): string {
  const tagNameNode = Node.isJsxElement(element)
    ? element.getOpeningElement().getTagNameNode()
    : element.getTagNameNode()

  const name = tagNameNode.getText()
  const kind: ParsedNode['kind'] = /^[A-Z]/.test(name) ? 'component' : 'element'

  const pos = tagNameNode.getStart()
  const { line, column } = ctx.sourceFile.getLineAndColumnAtPos(pos)
  const loc: NodeLoc = { file: ctx.relFile, line, col: column }
  // `loc` stays the real source location even for an expanded loop iteration —
  // that IS where this element is written. Only the id is made unique.
  const id = `${ctx.relFile}:${line}:${column}${ctx.idSuffix ?? ''}`

  const attributes = Node.isJsxElement(element)
    ? element.getOpeningElement().getAttributes()
    : element.getAttributes()

  const hasSpread = attributes.some((a) => Node.isJsxSpreadAttribute(a))
  const locked = inheritedLocked || hasSpread
  const lockReason = inheritedLocked ? inheritedReason : hasSpread ? SPREAD_LOCK_REASON : undefined

  const propsResult = extractProps(attributes, ctx, kind)
  const styleResult = extractInlineStyles(attributes, ctx)

  // <svg> is captured as one opaque unit for `base.svg` (raw inline markup) —
  // do NOT recurse into <path>/<circle>/<g>/… below, they are not page-tree
  // modules. `className`/`style` are still captured above so they reach the
  // canvas (§4/§6 depend on that).
  if (kind === 'element' && name.toLowerCase() === 'svg') {
    // Serialised from the JSX rather than copied out of the source text: the
    // source is JSX, not markup — `className=` is not a class attribute, and an
    // embedded expression (`strokeDashoffset={C*(1-pct/100)}`) is not an
    // attribute value at all. `serializeInlineSvg` resolves those through §7 and
    // writes real attribute names. Copying the text verbatim, and blanking the
    // whole graphic whenever it contained a `{`, is what left six empty rings on
    // the eSIM corpus.
    const markup = serializeInlineSvg(element, ctx.eval)
    // Nothing usable came back (a spread-driven or oversized graphic). Keep the
    // node so its class/style/position are still visible, but lock it — there is
    // no markup to edit. A `.map`/ternary/spread lock upstream, if any, is
    // superseded by this more specific reason.
    const svgLock = withResolutionLock(
      locked || markup === undefined,
      markup === undefined ? DYNAMIC_SVG_LOCK_REASON : lockReason,
      [...propsResult.resolutions, ...styleResult.resolutions],
    )
    const svgNode: ParsedNode = {
      id,
      kind,
      name,
      props: markup === undefined ? propsResult.props : { ...propsResult.props, svg: markup },
      children: [],
      loc,
      locked: svgLock.locked,
      ...(svgLock.lockReason ? { lockReason: svgLock.lockReason } : {}),
      // `svg` is markup serialised from the JSX children, not an attribute —
      // there is nothing at this location for a scalar write to land on.
      codeProps: codePropNames([...propsResult.codeProps, 'svg'], styleResult.codeStyles),
      ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
      ...(svgLock.resolution ? { resolution: svgLock.resolution } : {}),
    }
    ctx.nodes[id] = svgNode
    return id
  }

  // `dangerouslySetInnerHTML={{ __html: rawSvgImport }}` — the standard way a
  // real repo inlines an icon. The element keeps its own tag, classes, and
  // inline styles (they size and colour the icon); the resolved markup rides
  // along on `svg`, which `resolveModuleId` uses to pick `base.svg`. Children
  // are irrelevant here — React ignores them when this prop is set.
  const rawSvg = extractRawSvgMarkup(attributes, ctx)
  if (rawSvg !== undefined) {
    const rawLock = withResolutionLock(locked, lockReason, [...propsResult.resolutions, ...styleResult.resolutions])
    const rawNode: ParsedNode = {
      id,
      kind,
      name,
      props: { ...propsResult.props, svg: rawSvg },
      children: [],
      loc,
      locked: rawLock.locked,
      ...(rawLock.lockReason ? { lockReason: rawLock.lockReason } : {}),
      // `svg` is resolved out of `dangerouslySetInnerHTML={{__html: …}}`, an
      // expression — see the sibling branch above.
      codeProps: codePropNames([...propsResult.codeProps, 'svg'], styleResult.codeStyles),
      ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
      ...(rawLock.resolution ? { resolution: rawLock.resolution } : {}),
    }
    ctx.nodes[id] = rawNode
    return id
  }

  const rawChildren = Node.isJsxElement(element) ? element.getJsxChildren() : []
  const children = Node.isJsxElement(element) ? processChildren(rawChildren, ctx, locked, lockReason) : []
  // Capture text whether or not the node is locked.
  //
  // This used to skip locked nodes, reasoning that a node with no writeback path
  // should not imply an editable surface. But `locked` is what carries that
  // meaning — the editor's edit guards read it — and withholding the text does
  // not make a node less editable, it makes it BLANK. Every `.map` row, every
  // `{cond && <span>Saved</span>}`, every spread-bearing element rendered as an
  // empty box on the canvas while its text sat in plain sight in the source.
  //
  // §7 already settled this the other way: a resolved value sets `text` AND
  // locks the node (`withResolutionLock`). The two rules contradicted each
  // other; this is the one that shows the user their screen.
  const textResult = extractSingleText(rawChildren, ctx)
  const text = textResult?.text

  const lock = withResolutionLock(locked, lockReason, [
    ...(textResult?.resolution ? [textResult.resolution] : []),
    ...propsResult.resolutions,
    ...styleResult.resolutions,
  ])

  // WS-3.4 — a COMPONENT prop whose JSX value the readers above could not
  // resolve to a scalar/icon/structured value (a design-system slot: icon,
  // header, footer, …) is materialized as a real child node instead of being
  // silently dropped. See `captureSlotProps`'s doc for the full shape.
  const slotProps = kind === 'component' ? captureSlotProps(attributes, propsResult.props, ctx) : undefined
  const props = slotProps
    ? {
        ...propsResult.props,
        ...Object.fromEntries(Object.entries(slotProps).map(([name, childId]) => [name, studioSlotValue(childId)])),
      }
    : propsResult.props

  const codeProps = codePropNames(
    [...propsResult.codeProps, ...(slotProps ? Object.keys(slotProps) : [])],
    styleResult.codeStyles,
  )

  const node: ParsedNode = {
    id,
    kind,
    name,
    props,
    children,
    loc,
    locked: lock.locked,
    ...(lock.lockReason ? { lockReason: lock.lockReason } : {}),
    ...(codeProps.length > 0 ? { codeProps } : {}),
    ...(textResult?.resolution ? { codeText: true } : {}),
    ...(text !== undefined ? { text } : {}),
    // Only when the text came from a `.map` iteration's own scope would this be
    // ambiguous, and `idSuffix` marks those ids as unwritable anyway.
    ...(textResult?.origin ? { textOrigin: textResult.origin } : {}),
    // WS-8.3 — where the import naming this node's resolved image lives, when
    // one of its props traced back to one. See `ParsedNode.assetOrigin`.
    ...(propsResult.assetOrigin ? { assetOrigin: propsResult.assetOrigin } : {}),
    ...(styleResult.styles !== undefined ? { inlineStyles: styleResult.styles } : {}),
    ...(lock.resolution ? { resolution: lock.resolution } : {}),
  }
  ctx.nodes[id] = node

  return id
}

/**
 * WS-3.4 — captures a COMPONENT prop's JSX-element value as a real child
 * node, for every attribute `extractProps` did NOT already resolve into
 * `existingProps` (a scalar, the `{svg}` icon shape, or a resolved
 * array/object all win over this — see `extractProps`'s own component-prop
 * branch in `jsxAttributeReaders.ts`).
 *
 * `<Cell icon={<Icon/>}/>` mints `<Icon/>` via the SAME `processElement` walk
 * every ordinary child goes through — identical locking rules, identical
 * props/text/svg capture — but the minted id is NOT added to `children`: a
 * slot value is not a DOM child of the host, it is handed to one specific
 * prop (see `studioSlotSentinel.ts`, which the caller uses to encode the
 * reference into `props`). The minted node is always locked
 * (`SLOT_LOCK_REASON`) — it cannot be dragged out of the slot structurally —
 * but its OWN props stay ordinary and editable, the same `locked`-is-
 * structure / `codeProps`-is-values split every other locked node in this
 * parser already follows.
 *
 * Only a single JSX element/self-closing element is captured — a fragment is
 * declined (returns no slot for that attribute) because it can expand to
 * zero or several roots, which is ambiguous for a prop expecting exactly one
 * element. `style`/`dangerouslySetInnerHTML` never reach here: `style`'s
 * value is never JSX, and a node with a resolvable `dangerouslySetInnerHTML`
 * already returned from `processElement` before this runs.
 */
function captureSlotProps(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  existingProps: Record<string, ParsedPropValue>,
  ctx: ParseContext,
): Record<string, string> | undefined {
  let slots: Record<string, string> | undefined
  for (const attribute of attributes) {
    if (!Node.isJsxAttribute(attribute)) continue
    const name = attribute.getNameNode().getText()
    if (name in existingProps) continue // already a scalar/icon/structured value
    const initializer = attribute.getInitializer()
    if (!initializer || !Node.isJsxExpression(initializer)) continue
    const expression = initializer.getExpression()
    if (!expression) continue
    if (!Node.isJsxElement(expression) && !Node.isJsxSelfClosingElement(expression)) continue
    const slotChildId = processElement(expression, ctx, true, SLOT_LOCK_REASON)
    slots ??= {}
    slots[name] = slotChildId
  }
  return slots
}

/**
 * Walks a JSX element's children (`getJsxChildren()` output). Plain text is
 * skipped (not a node). Fragments are flattened (not a node themselves, but
 * their children become children of the enclosing element). `{expression}`
 * containers are not nodes either, but any JSX literal reachable inside one
 * is — locked when the expression is a dynamic-rendering construct.
 */
function processChildren(
  children: Node[],
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
): string[] {
  const ids: string[] = []

  for (const child of children) {
    if (Node.isJsxText(child)) continue

    if (Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child)) {
      ids.push(processElement(child, ctx, inheritedLocked, inheritedReason))
      continue
    }

    if (Node.isJsxFragment(child)) {
      ids.push(...processChildren(child.getJsxChildren(), ctx, inheritedLocked, inheritedReason))
      continue
    }

    if (Node.isJsxExpression(child)) {
      const expr = child.getExpression()
      if (!expr) continue

      const expanded = expandStaticLoop(expr, ctx)
      if (expanded) {
        ids.push(...expanded)
        continue
      }

      const triggers = isLockingExpression(expr)
      const locked = inheritedLocked || triggers
      const reason = inheritedLocked ? inheritedReason : triggers ? DYNAMIC_LOCK_REASON : undefined
      ids.push(...collectFromExpression(expr, ctx, locked, reason))
    }
  }

  return ids
}

/**
 * Finds the "top-level" JSX elements reachable inside an arbitrary
 * expression (e.g. the body of a `.map` callback, or a component's own
 * `return cond ? <A/> : <B/>`), without descending into elements once found —
 * their own children are handled by `processElement` → `processChildren` as
 * usual. A `.map` met on the way down is EXPANDED here, not walked into (see
 * `expandStaticLoop`'s doc comment for why that must happen at every level,
 * not only where a list is a direct `{items.map(…)}` child).
 *
 * A ternary or `&&` met on the way down is a BRANCH POINT (parser-06):
 * `selectJsxBranch` picks exactly one side to descend into, instead of both —
 * or (parser-07) none, for a statically-false `&&` — see that function's doc
 * comment. This is the SAME "select, don't stack" rule `getReturnedJsxRoots`
 * applies one level up, for the same reason: rendering every branch of a
 * runtime conditional shows a screen no user ever sees. A dynamic construct
 * this walk could NOT resolve a single branch/row
 * for (an unresolved `.map`, any other call, `||`) re-derives its own lock
 * instead of silently inheriting whichever ambient `locked`/`reason` this
 * walk started with — necessary now that `&&`/a ternary no longer forces
 * their whole subtree locked: `{ok && items.map(unresolvable)}` must still
 * lock `items.map`'s contents even though `&&` itself does not.
 */
function collectFromExpression(
  expr: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
): string[] {
  const ids: string[] = []
  walkExpressionForJsx(expr, ctx, locked, reason, ids)
  return ids
}

function walkExpressionForJsx(
  rawNode: Node,
  ctx: ParseContext,
  locked: boolean,
  reason: string | undefined,
  ids: string[],
): void {
  const node = unwrapParens(rawNode)

  const expanded = expandStaticLoop(node, ctx)
  if (expanded) {
    ids.push(...expanded)
    return
  }
  if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) {
    ids.push(processElement(node, ctx, locked, reason))
    return
  }

  const branch = selectJsxBranch(node, ctx)
  if (branch) {
    // parser-07: `chosen` is `undefined` only for a statically-false `&&` —
    // nothing renders at this position, so there is nothing further to walk
    // or attach a note/alternative to.
    if (!branch.chosen) return
    const before = ids.length
    walkExpressionForJsx(branch.chosen, ctx, locked, reason, ids)
    const chosenIds = ids.slice(before)
    if (chosenIds.length > 0) {
      let alternative: BranchAlternative | undefined
      if (branch.alternative) {
        const { line, column } = ctx.sourceFile.getLineAndColumnAtPos(unwrapParens(branch.alternative).getStart())
        alternative = { label: branch.altLabel ?? 'other branch', loc: { file: ctx.relFile, line, col: column } }
      }
      for (const id of chosenIds) {
        const existing = ctx.nodes[id]
        if (!existing) continue
        ctx.nodes[id] = {
          ...existing,
          ...(alternative ? { branchAlternatives: [...(existing.branchAlternatives ?? []), alternative] } : {}),
          // Don't clobber a resolution already recorded for THIS node's own
          // value — see `resolution`'s "only the first" policy in `./types.ts`.
          ...(existing.resolution ? {} : { resolution: { source: ctx.relFile, note: branch.note } }),
        }
      }
    }
    return
  }

  // A dynamic construct `selectJsxBranch` does not own (an unresolved `.map`,
  // any other function call, or `||`) re-triggers the SAME lock
  // `isLockingExpression` applies at the top level — see this function's doc
  // comment for why that can no longer be assumed to already be true here.
  if (
    Node.isCallExpression(node) ||
    (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.BarBarToken)
  ) {
    node.forEachChild((child) => walkExpressionForJsx(child, ctx, true, DYNAMIC_LOCK_REASON, ids))
    return
  }

  node.forEachChild((child) => walkExpressionForJsx(child, ctx, locked, reason, ids))
}
