/**
 * subtreeSlotChildren — E2.2's "keep/slot toggle at promote time": which of a
 * subtree ROOT's own direct, markup-bearing children could become a named
 * slot instead of moving inline into the new component file.
 *
 * THIS MODULE IS READ-ONLY. It never writes a file — it exists so a caller
 * (E2.5's panel) can show the user, BEFORE they commit anything, exactly
 * which children are eligible and what Studio would call each one by
 * default. `extractSubtreeToComponent.ts`'s own `slotChildren` param takes
 * the caller's (possibly corrected) decisions as plain data; this module is
 * how those decisions get PROPOSED, never how they get applied — matching
 * E2.1's own principle ("each inference shown for correction, never silently
 * applied") one step earlier in the flow than `freeVariables` applies it.
 *
 * WHAT COUNTS AS A "DIRECT, MARKUP-BEARING CHILD"
 * ---------------------------------------------------
 * Only `root`'s own immediate JSX children that are themselves markup: a
 * `JsxElement`, a `JsxSelfClosingElement`, or a `JsxFragment` (`<>…</>`).
 * Whitespace-only text, a `JsxExpression` child (`{count}`, `{cond && <X/>}`),
 * and a self-closing `root` (which has no children at all) are never
 * candidates — a slot replaces a whole piece of markup with `{propName}`,
 * and none of those three shapes is markup to begin with.
 *
 * NAMING — "children" FOR ONE SLOT, REAL NAMES FOR SEVERAL
 * -------------------------------------------------------------
 * `SlotChildCandidate.suggestedName` is always a TAG-DERIVED default (or a
 * positional `slot1`/`slot2`/… fallback when the tag gives nothing useful) —
 * usable as-is when several children end up chosen as slots, since each then
 * needs a name distinct from the others. `suggestSlotNames` is the one place
 * that additionally applies the OTHER half of the naming rule: when the
 * caller's current selection is exactly ONE child, the conventional default
 * is the literal `'children'` instead — that decision depends on how MANY
 * children are selected, not on any one candidate alone, so it cannot live on
 * the candidate itself.
 */
import { Node, type Project, type SourceFile } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile, resolveJsxWholeElement } from './locateJsxElement'

export type SlotChildCandidateKind = 'element' | 'fragment'

export interface SlotChildCandidate {
  /**
   * 0-based index among `root`'s own SLOTTABLE children only, in source
   * order — NOT the raw index into ts-morph's `getJsxChildren()` (whitespace
   * text and `{…}` expression children are excluded from this numbering).
   * This is what `extractSubtreeToComponent.ts`'s `SlotChildDecision
   * .childIndex` refers to.
   */
  index: number
  kind: SlotChildCandidateKind
  /** The child's own JSX tag name (`'Icon'`, `'div'`) — `undefined` for a `<>…</>` fragment child, which has none. */
  tagName?: string
  /** First ~60 characters of the child's own source text, collapsed to one line — enough for a picker row, not a full preview. */
  preview: string
  /** A tag-derived default slot name — see this module's own doc for when to use it vs. the `'children'` convention (`suggestSlotNames`). */
  suggestedName: string
}

/** One resolved candidate paired with the actual AST node it names — the shape `extractSubtreeToComponent.ts` needs internally; `listSlotChildCandidates` strips this down to the public `SlotChildCandidate` alone. */
export interface ResolvedSlotChildCandidate {
  node: Node
  candidate: SlotChildCandidate
}

const GENERIC_INTRINSIC_TAGS = new Set([
  'div', 'span', 'p', 'a', 'img', 'ul', 'ol', 'li', 'button', 'i', 'b', 'svg', 'path', 'g',
])
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function tagNameOf(child: Node): string | undefined {
  if (Node.isJsxSelfClosingElement(child)) return child.getTagNameNode().getText()
  if (Node.isJsxElement(child)) return child.getOpeningElement().getTagNameNode().getText()
  return undefined
}

/**
 * A tag-derived default: `Header` -> `'header'` (a component reference — the
 * common case for a slotted region); a landmark intrinsic tag (`nav`,
 * `footer`) -> itself; anything else (a generic `div`/`span`, a dotted or
 * non-identifier tag name, a fragment) -> the positional fallback
 * `slot<position>`, 1-based over ALL candidates so it stays stable as other
 * children are toggled. A heuristic, shown for correction — never assumed
 * correct.
 */
function tagBasedSlotName(child: Node, position: number): string {
  const positional = `slot${position}`
  const tagName = tagNameOf(child)
  if (!tagName) return positional
  const root = tagName.split('.')[0]!
  if (!IDENTIFIER_RE.test(root)) return positional
  if (/^[A-Z]/.test(root)) return root.charAt(0).toLowerCase() + root.slice(1)
  return GENERIC_INTRINSIC_TAGS.has(root) ? positional : root
}

function previewText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine
}

/**
 * Every slottable direct child of `root`, paired with the AST node it names.
 * Pure — reads only, never mutates. `root` is what
 * `resolveJsxWholeElement`/`extractSubtreeToComponent.ts` already resolve a
 * located element to; a self-closing `root` has no children and always
 * yields `[]`.
 */
export function collectSlotChildCandidates(root: Node): ResolvedSlotChildCandidate[] {
  if (!Node.isJsxElement(root)) return []

  const children = root
    .getJsxChildren()
    .filter((child) => Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child) || Node.isJsxFragment(child))

  return children.map((child, index) => ({
    node: child,
    candidate: {
      index,
      kind: Node.isJsxFragment(child) ? 'fragment' : 'element',
      ...(Node.isJsxFragment(child) ? {} : { tagName: tagNameOf(child) }),
      preview: previewText(child.getText()),
      suggestedName: tagBasedSlotName(child, index + 1),
    } satisfies SlotChildCandidate,
  }))
}

export interface ListSlotChildCandidatesParams {
  /** Absolute path to the page file holding the subtree ROOT (not the new component being considered — that doesn't exist yet). */
  file: string
  /** 1-based line/col of the root element's tag-name start — same convention `extractSubtreeToComponent.ts` uses for the same location. */
  line: number
  col: number
  project?: Project
}

/**
 * The public, location-based entry point E2.5's panel calls to populate the
 * keep/slot toggle list — resolves (file, line, col) to the same `root`
 * `extractSubtreeToComponent` would operate on, and returns its slottable
 * children as plain data (no AST types leak out). Throws for a stale/missing
 * location, matching `extractSubtreeToComponent`'s own trust posture for a
 * bad `(file, line, col)` — this is a preview call the picker UI only ever
 * makes against a location it just read off the loaded page tree.
 */
export function listSlotChildCandidates(params: ListSlotChildCandidatesParams): SlotChildCandidate[] {
  const project = params.project ?? createProject()
  const sourceFile: SourceFile = loadSourceFile(project, params.file)
  const opening = findJsxElementAtLocationOrThrow(sourceFile, params.file, params.line, params.col)
  const { root } = resolveJsxWholeElement(opening)
  return collectSlotChildCandidates(root).map((c) => c.candidate)
}

/** The conventional name for a lone slot — never assigned silently; see `suggestSlotNames`. */
export const SOLE_SLOT_DEFAULT_NAME = 'children'

/**
 * Given the FULL candidate list and the indices the caller's UI currently has
 * toggled "slot" (in whatever order the user picked them), proposes a name
 * for EACH selected index — recomputed live as the toggle state changes,
 * never persisted, and always still shown for correction before a commit:
 *
 *   - Exactly one selected -> the literal `'children'` (the conventional
 *     single default slot), regardless of that child's own tag.
 *   - Two or more selected -> each gets its own `suggestedName`
 *     (`collectSlotChildCandidates`'s tag-derived default), disambiguated
 *     against the OTHER selected candidates by appending `2`, `3`, … when two
 *     would otherwise derive the identical base name (e.g. two `<Icon/>`
 *     children both slotted -> `icon`, `icon2`).
 */
export function suggestSlotNames(
  candidates: readonly SlotChildCandidate[],
  selectedIndices: readonly number[],
): Map<number, string> {
  if (selectedIndices.length === 1) {
    return new Map([[selectedIndices[0]!, SOLE_SLOT_DEFAULT_NAME]])
  }

  const byIndex = new Map(candidates.map((c) => [c.index, c]))
  const usedCount = new Map<string, number>()
  const result = new Map<number, string>()
  for (const index of selectedIndices) {
    const base = byIndex.get(index)?.suggestedName ?? `slot${index + 1}`
    const count = (usedCount.get(base) ?? 0) + 1
    usedCount.set(base, count)
    result.set(index, count === 1 ? base : `${base}${count}`)
  }
  return result
}
