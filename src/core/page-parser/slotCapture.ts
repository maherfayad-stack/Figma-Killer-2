/**
 * slotCapture — WS-3.4 / E2.3's "materialize a component prop's JSX value as
 * a real child node" pass.
 *
 * Split out of `parsePageFile.ts` to stay under the module-size ceiling,
 * along the same seam every other extraction from that file already follows
 * (`branchSelection.ts`, `jsxAttributeReaders.ts`, `staticLoopExpansion.ts`):
 * that module owns the main tree WALK (`processElement`/`processChildren`,
 * recursively turning JSX into `ParsedNode`s); this one is a single,
 * independently-testable RESPONSIBILITY hung off one call site in that walk
 * (`processElement`'s `kind === 'component'` branch). `processElement` and
 * `processChildren` are passed in as parameters rather than imported, so this
 * file has no dependency edge back onto `parsePageFile.ts` at all — the two
 * modules would otherwise import each other.
 */
import { Node, type JsxAttribute, type JsxElement, type JsxFragment, type JsxSelfClosingElement, type JsxSpreadAttribute } from 'ts-morph'
import type { NodeLoc, ParsedNode, ParsedPropValue } from './types'
import type { ParseContext } from './jsxAttributeReaders'

type JsxOpeningLike = JsxElement | JsxSelfClosingElement

/** WS-3.4 — a component prop's JSX value, materialized as a real child node. See `captureSlotProps`. */
export const SLOT_LOCK_REASON = 'slot content — fills a component prop'

type ProcessElementFn = (
  element: JsxOpeningLike,
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
) => string

type ProcessChildrenFn = (
  children: Node[],
  ctx: ParseContext,
  inheritedLocked: boolean,
  inheritedReason: string | undefined,
) => string[]

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
 * A single JSX element/self-closing element takes the path above unchanged.
 * A JSX FRAGMENT value (`header={<><Back/><Title/></>}`) — E2.3 — takes
 * `processFragmentSlot` instead: there is no single element to mint, so it
 * mints a `studio.slot` CONTAINER node (see that function's doc comment for
 * why the container's id must be the fragment's own location, never minted)
 * whose `children` are the fragment's own JSX children, walked the ordinary
 * way. `style`/`dangerouslySetInnerHTML` never reach either path: `style`'s
 * value is never JSX, and a node with a resolvable `dangerouslySetInnerHTML`
 * already returned from `processElement` before this runs.
 */
export function captureSlotProps(
  attributes: (JsxAttribute | JsxSpreadAttribute)[],
  existingProps: Record<string, ParsedPropValue>,
  ctx: ParseContext,
  processElement: ProcessElementFn,
  processChildren: ProcessChildrenFn,
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
    let slotChildId: string
    if (Node.isJsxFragment(expression)) {
      slotChildId = processFragmentSlot(expression, ctx, processChildren)
    } else if (Node.isJsxElement(expression) || Node.isJsxSelfClosingElement(expression)) {
      slotChildId = processElement(expression, ctx, true, SLOT_LOCK_REASON)
    } else {
      continue
    }
    slots ??= {}
    slots[name] = slotChildId
  }
  return slots
}

/**
 * E2.3 — mints the `studio.slot` container node for a FRAGMENT-valued
 * component-prop slot. Sibling of `processElement`'s slot path (called from
 * `captureSlotProps` only), but a fragment has no tag name to anchor an id
 * on, so this is its own small walk rather than a branch inside
 * `processElement`.
 *
 * ⚠️ The id is the `JsxFragment`'s OWN source location
 * (`${relFile}:${line}:${col}`, exactly `processElement`'s convention, minus
 * the tag name) — never a minted/synthetic id. `sourceStructure.ts`'s
 * `refuseMintedNodeInsert` treats a source-derived id as real and anything
 * else as impossible to write back to; minting one here would make it
 * correctly refuse every future insert into a multi-element slot, and blame
 * the wrong thing while doing it (a real source position exists, the id
 * would just be lying about where).
 *
 * Children inherit the slot's own lock (`SLOT_LOCK_REASON`), exactly the way
 * a single captured element's OWN children already inherit its lock via
 * `processElement`'s `children = processChildren(rawChildren, ctx, locked,
 * lockReason)` — this keeps the two capture paths structurally identical,
 * just for N roots instead of one. The container's props stay empty: a
 * fragment carries no attributes of its own to capture.
 */
function processFragmentSlot(fragment: JsxFragment, ctx: ParseContext, processChildren: ProcessChildrenFn): string {
  const pos = fragment.getStart()
  const { line, column } = ctx.sourceFile.getLineAndColumnAtPos(pos)
  const loc: NodeLoc = { file: ctx.relFile, line, col: column }
  const id = `${ctx.relFile}:${line}:${column}${ctx.idSuffix ?? ''}`

  const children = processChildren(fragment.getJsxChildren(), ctx, true, SLOT_LOCK_REASON)

  const node: ParsedNode = {
    id,
    kind: 'element',
    name: 'Fragment',
    props: {},
    children,
    loc,
    locked: true,
    lockReason: SLOT_LOCK_REASON,
    fragmentSlot: true,
  }
  ctx.nodes[id] = node
  return id
}
