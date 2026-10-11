/**
 * gatherGroupRun - ⌘G on elements that do not form a run (G-7).
 *
 * `wrapJsxElements` writes ONE container around a contiguous span. A selection
 * that is not one - two elements with a third between them, or two the source
 * nests in different parents (the canvas flattens a `<Fragment>`) - used to be
 * refused (`not-contiguous`, `not-siblings`) with "select siblings next to each
 * other". That sentence asks the person to do the codemod's job: the gesture is
 * "put these, together, inside one thing", and what it means in the source is
 * unambiguous.
 *
 * THE MEANING. The first member in the file keeps its place and gets the
 * container; every other member is cut from where it is and written inside the
 * container, after the one before it, in source order. Whatever the person did
 * NOT select stays exactly where it was - the element between two members is
 * not pulled in, and no member's neighbour is touched beyond the bytes the
 * member itself owned. One cut per member, one container, one write: the
 * edits are all measured against the original text and applied last-first, so
 * it is the same byte-exact splice every other structural codemod makes.
 *
 * WHAT STILL REFUSES, because the file would break:
 *
 *   - **`out-of-scope`** - a member read a name from the code around it (a
 *     `.map` row's item, another component's props) that is not visible where
 *     the container sits. Moving it there would leave an undefined variable.
 *   - everything `resolveJsxChildRange` refuses about a MEMBER on its own
 *     (the element a component returns, an element the code produces).
 *
 * The caller has already chosen the container's tag (`resolveWrapperTag`
 * against the first member's ancestors and ALL the members' tags) and handed
 * in the whole-line wrapping the contiguous path uses, so the container looks
 * the same either way.
 */
import { Node, type SourceFile } from 'ts-morph'
import { applyTextEdits, type JsxChildRange, type TextEdit } from './jsxChildRange'
import { lineIndentAt, reindentBlock } from './jsxChildPlacement'
import { inlineRemoval } from './moveJsxElement'
import { freeVariablesOutOfScopeAt } from './subtreeFreeVariables'

/** The members after the first, pulled out of the run, and the text of the whole run as it will sit inside the container. */
export interface GatheredRun {
  /** The text that goes between the container's tags: every member, one per line, at the first member's indentation. */
  span: string
  /** One cut per member after the first. */
  removals: TextEdit[]
}

/**
 * The members that matter: sorted into source order, and with any member that
 * sits inside another dropped (it travels with the one that holds it).
 */
export function topLevelMembers(ranges: readonly JsxChildRange[]): JsxChildRange[] {
  const sorted = [...ranges].sort((a, b) => a.element.getStart() - b.element.getStart())
  // Distinct elements never share both ends, so "starts no later and ends no
  // earlier" is "contains" for every pair that is not the same element.
  return sorted.filter(
    (range) =>
      !sorted.some(
        (other) =>
          other.element !== range.element &&
          other.element.getStart() <= range.element.getStart() &&
          other.element.getEnd() >= range.element.getEnd(),
      ),
  )
}

/** True when the members are siblings of one parent with no other element or code between the first and the last. */
export function isUnbrokenRun(members: readonly JsxChildRange[]): boolean {
  const parent = members[0]!.parent
  if (members.some((member) => member.parent !== parent)) return false
  if (!Node.isJsxElement(parent) && !Node.isJsxFragment(parent)) return true
  const children: Node[] = parent
    .getJsxChildren()
    .filter(
      (child) =>
        Node.isJsxElement(child) ||
        Node.isJsxSelfClosingElement(child) ||
        (Node.isJsxExpression(child) && child.getExpression() !== undefined),
    )
  const first = children.indexOf(members[0]!.element)
  const last = children.indexOf(members[members.length - 1]!.element)
  return first !== -1 && last !== -1 && last - first + 1 === members.length
}

/** The names a member reads that are not visible where the container will sit, or `[]`. */
export function namesLostByGathering(
  sourceFile: SourceFile,
  members: readonly JsxChildRange[],
): string[] {
  const first = members[0]!
  const lost = new Set<string>()
  for (const member of members.slice(1)) {
    if (member.parent === first.parent) continue
    for (const name of freeVariablesOutOfScopeAt(member.element, first.element, sourceFile)) lost.add(name)
  }
  return [...lost]
}

/** Cut every member after the first and lay the whole run out at the first member's indentation. */
export function gatherRun(verbatim: string, members: readonly JsxChildRange[]): GatheredRun {
  const [first, ...rest] = members as [JsxChildRange, ...JsxChildRange[]]
  const baseIndent = lineIndentAt(verbatim, first.element.getStart())
  const texts = members.map((member) =>
    reindentBlock(
      verbatim.slice(member.element.getStart(), member.element.getEnd()),
      lineIndentAt(verbatim, member.element.getStart()),
      baseIndent,
    ),
  )
  const removals = rest.map((member): TextEdit =>
    member.wholeLine
      ? { start: member.start, end: member.end, text: '' }
      : { ...inlineRemoval(verbatim, member.start, member.end), text: '' },
  )
  return { span: texts.join(`\n${baseIndent}`), removals }
}

/**
 * Apply the container's edit, the cuts and any import edits as one write, after
 * making sure no two of them claim the same byte. Two inline neighbours can: the
 * container's line split takes the spaces after the first member, and the cut of
 * a member right behind it takes the spaces before it. The later edit yields.
 */
export function applyGather(verbatim: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const settled: TextEdit[] = []
  for (const edit of ordered) {
    const previous = settled[settled.length - 1]
    const start = previous !== undefined && edit.start < previous.end ? Math.min(previous.end, edit.end) : edit.start
    if (start === edit.end && edit.text === '') continue
    settled.push(start === edit.start ? edit : { ...edit, start })
  }
  return applyTextEdits(verbatim, settled)
}
