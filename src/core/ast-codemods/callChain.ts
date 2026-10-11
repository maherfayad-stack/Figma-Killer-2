/**
 * callChain — the components between a page and an element, read from source.
 *
 * An element inside a component that another component renders is addressed by
 * an id with one segment per call site (`page~Card~Badge`). Both orchestrators
 * that write through such a chain (`exposeThroughLevels` for a literal,
 * `classOverride` for a class) need the same facts: for each call site, the
 * file, the element, which component it renders and that component's function.
 * And both need the same answer to "does this hop pass the page's props on
 * without anyone filtering them?", which is the spread-forwarding case
 * (`<Inner {...props} />`): the page's call site then reaches the inner
 * component by itself, and no component between them is edited.
 */
import * as path from 'node:path'
import { Node, type Project, type SourceFile } from 'ts-morph'
import type { FunctionLike } from '@core/page-parser'
import type { CallSiteLocation } from './exposeLiteralSites'
import { findJsxElementAtLocationOrThrow, loadSourceFile, type JsxOpeningLikeElement } from './locateJsxElement'
import { resolveComponentCallSite, type ResolvedCallSiteComponent } from './resolveComponentCallSite'

/** One component on the chain: the call site that renders it, and the component itself. */
export interface Level {
  callFile: SourceFile
  callSite: JsxOpeningLikeElement
  identifier: string
  componentFile: SourceFile
  fn: FunctionLike
  target: ResolvedCallSiteComponent['target']
}

export type ChainRefusal = { reason: 'unresolvable' | 'package-component' | 'not-in-component'; message: string }

function inside(outer: Node, inner: Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd()
}

/**
 * Resolves every call site of `locations` (outermost first) to its component,
 * checking that each inner call site really sits in the component the one above
 * it renders. `remember` is told every file read, so the caller can restore them.
 */
export function resolveCallChain(
  project: Project,
  workspaceRoot: string,
  locations: readonly CallSiteLocation[],
  remember: (file: SourceFile) => void,
): { ok: true; levels: Level[] } | { ok: false; refusal: ChainRefusal } {
  const levels: Level[] = []
  for (const [k, location] of locations.entries()) {
    const callFile = loadSourceFile(project, location.file)
    remember(callFile)
    const callSite = findJsxElementAtLocationOrThrow(callFile, location.file, location.line, location.col)
    const previous = levels[k - 1]
    if (previous && (path.relative(previous.componentFile.getFilePath(), location.file) !== '' || !inside(previous.fn, callSite))) {
      return { ok: false, refusal: { reason: 'not-in-component', message: `That element is not part of the markup <${previous.identifier}> renders. Select an element inside it.` } }
    }
    const identifier = callSite.getTagNameNode().getText().split('.')[0]!
    const resolved = resolveComponentCallSite(project, callFile, workspaceRoot, identifier, location.file, location.line, location.col)
    if (!resolved.ok) return { ok: false, refusal: resolved.failure }
    const { target, fn } = resolved.result
    remember(target.sourceFile)
    levels.push({ callFile, callSite, identifier, componentFile: target.sourceFile, fn, target })
  }
  return { ok: true, levels }
}

/** The names a component's own props go by: the undestructured `props` parameter, or the `...rest` binding. */
function forwardedNames(fn: FunctionLike): { names: Set<string>; destructured: Set<string> } | undefined {
  const pattern = fn.getParameters()[0]?.getNameNode()
  if (!pattern) return undefined
  if (Node.isIdentifier(pattern)) return { names: new Set([pattern.getText()]), destructured: new Set() }
  if (!Node.isObjectBindingPattern(pattern)) return undefined
  const elements = pattern.getElements()
  const rest = elements.find((element) => element.getDotDotDotToken() !== undefined)
  const restName = rest?.getNameNode()
  if (!restName || !Node.isIdentifier(restName)) return undefined
  const destructured = new Set(elements.filter((element) => element !== rest).map((element) => element.getPropertyNameNode()?.getText() ?? element.getName()))
  return { names: new Set([restName.getText()]), destructured }
}

export type Hop =
  /** The call site spreads the enclosing component's own props: the page's attributes reach the inner component as they are. */
  | { kind: 'spread'; destructured: ReadonlySet<string> }
  /** Anything else: the hop passes only what its attributes name. */
  | { kind: 'explicit' }
  /** The call site spreads something the codemod cannot prove passes every prop on (`{...omit(props, 'x')}`, another object). */
  | { kind: 'filtered'; message: string }

/** How the call site of `inner` (which sits in `outer`'s markup) hands `outer`'s props on. */
export function hopKind(outer: Level, innerCallSite: JsxOpeningLikeElement): Hop {
  const spreads = innerCallSite.getAttributes().filter(Node.isJsxSpreadAttribute)
  if (spreads.length === 0) return { kind: 'explicit' }
  const own = forwardedNames(outer.fn)
  const only = spreads.length === 1 ? spreads[0]!.getExpression() : undefined
  if (own && only && Node.isIdentifier(only) && own.names.has(only.getText())) return { kind: 'spread', destructured: own.destructured }
  return {
    kind: 'filtered',
    message: `<${outer.identifier}> passes its props on through a spread Studio cannot read (${spreads.map((spread) => spread.getText()).join(', ')}), so a prop added here might not arrive. Pass the props explicitly in the code.`,
  }
}
