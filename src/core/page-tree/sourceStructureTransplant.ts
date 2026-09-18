/**
 * sourceStructureTransplant — D2 G3's rule: may this element leave the page it
 * is written in and land in a container on ANOTHER page?
 *
 * Its own module rather than another function in `sourceStructurePreview.ts`
 * because it is the only structural question in the codebase that takes TWO
 * trees. Every other preview asks something about one page's child list; this
 * one asks about a node in page A and a container in page B, and folding a
 * second tree parameter into that file's shape would make every reader of
 * `previewStructuralMove` wonder which tree it is about.
 *
 * ## What it decides, and what it deliberately leaves to the AST
 *
 * From the two node ids alone this can answer everything the existing
 * vocabulary already covers on both ends — a `.map` row, an inlined component,
 * route chrome, a parser-recorded structural lock — plus the two questions that
 * are specific to crossing a file boundary:
 *
 *  - **is the destination container an honest one** (`resolveSourceContainer`,
 *    the same resolution an insert uses, so dropping on a page's background and
 *    adding one from the picker cannot disagree about which element that means);
 *  - **is this genuinely a cross-file gesture** — two frames can show the SAME
 *    page (a "duplicate as variant" sibling), and a drop between those two is
 *    an ordinary reparent. The caller routes on page id; this refuses as a
 *    backstop rather than writing a cross-file codemod against one file.
 *
 * What it does NOT decide is whether the markup can survive the move: whether
 * the subtree reads a binding that is body-local to the origin's component, and
 * whether the imports it needs can be carried. Those are AST questions with AST
 * answers, and they arrive at save time as `captured-scope` / `binding-conflict`
 * from `transplantJsxElement.ts` — the same layering `struct-01` established
 * (asked cheaply here from the id, re-derived in RESIDUAL form by the codemod).
 *
 * ## One element at a time
 *
 * Same reason `planSourceDuplicateTo` gives: a cross-frame drop resolves ONE
 * target, and N elements dropped at one position would have to be ordered
 * against each other inside a child list each of them is shifting — in a file
 * whose line numbers the previous write already moved. Refused as
 * `multi-select`, with the remedy that is actually true.
 */
import { decodeSourceNodeId, isSourceDerivedNodeId, isStudioPageRootId } from './sourceNodeId'
import { refusePlacement, type StructuralRefusal } from './sourceStructure'
import { resolveContainerAnchor, resolveSourceContainer } from './sourceStructurePreview'
import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'

/**
 * Where a transplanted element is written: which element moves, which file's
 * container it lands inside, and which existing child of that container it
 * lands beside (`null` appends, which is a real position — the same reading
 * `insert` and `reparent` already give a missing anchor).
 *
 * Both ends are node ids. The FILES are recovered from them server-side, by
 * the same `studioEditLocation` decoder every other edit's target goes
 * through, so a hand-crafted id cannot name a file outside the workspace.
 */
export interface StructuralTransplantCommit {
  nodeId: string
  destinationParentNodeId: string
  anchorNodeId: string | null
  position: 'before' | 'after'
  /** K2 across frames — leave the origin's markup where it is and write only the copy. */
  copy: boolean
}

export type StructuralTransplantPreview =
  | { ok: true; commit: StructuralTransplantCommit }
  /** `nodeId` is the node the refusal is about, for the constraint's `origin` and the retry closure. */
  | { ok: false; refusal: StructuralRefusal; nodeId?: string }

export interface StructuralTransplantInput {
  /** The tree the dragged element lives in today. */
  originTree: NodeTree<PageNode>
  /** The dragged selection, in the order the gesture named them. */
  nodeIds: readonly string[]
  /** The tree the drop landed in — a DIFFERENT page from `originTree`. */
  destinationTree: NodeTree<PageNode>
  /** The container the drop resolved to, in `destinationTree`. */
  newParentId: string
  /** Where among the container's CANVAS children the drop landed. */
  newIndex: number
  /** Alt held: copy across frames instead of moving. */
  copy?: boolean
}

export function previewStructuralTransplant(
  input: StructuralTransplantInput,
): StructuralTransplantPreview {
  const { originTree, nodeIds, destinationTree, newParentId, newIndex } = input
  const copy = input.copy === true
  const gesture = copy ? 'Copied' : 'Moved'

  const nodeId = nodeIds[0]
  const node = nodeId === undefined ? undefined : originTree.nodes[nodeId]
  if (!node) {
    return {
      ok: false,
      refusal: {
        reason: 'reparent',
        message:
          'The element this gesture started on is no longer on the board. Reload the project and try again.',
      },
    }
  }

  if (nodeIds.length > 1) {
    return {
      ok: false,
      nodeId: node.id,
      refusal: {
        reason: 'multi-select',
        message: `Studio ${copy ? 'copies' : 'moves'} one element between frames at a time: each write changes the line numbers the next one would be written against, and several elements dropped at one position have no single order in the code. Drag them one by one.`,
      },
    }
  }

  // A node minted on the canvas has no markup anywhere, so there is nothing to
  // relocate into another file. Same sentence `previewStructuralMove` gives for
  // the same situation within one page.
  if (!isSourceDerivedNodeId(node.id)) {
    return {
      ok: false,
      nodeId: node.id,
      refusal: {
        reason: 'insert',
        message:
          'This element exists only on the canvas — there is no markup for it in the code, so Studio has nothing to move into the other frame. Add the component from the picker instead, which writes it to the source.',
      },
    }
  }

  const placement = refusePlacement(node, gesture)
  if (placement) return { ok: false, refusal: placement, nodeId: node.id }

  const container = resolveSourceContainer(destinationTree, newParentId)
  if (!container.ok) return { ok: false, refusal: container.refusal }

  // The destination page has to BE a studio-imported page. Dropping imported
  // markup into a CMS tree has no file to write into at all.
  if (!isSourceDerivedNodeId(container.node.id)) {
    return {
      ok: false,
      nodeId: node.id,
      refusal: {
        reason: 'reparent',
        message:
          'The frame this would land in is not backed by a file in your project, so there is nowhere to write the markup. Drop it into one of the imported screens instead.',
      },
    }
  }

  const containerPlacement = refusePlacement(container.node, `${gesture} into`)
  if (containerPlacement) {
    return {
      ok: false,
      nodeId: container.node.id,
      refusal: {
        reason: containerPlacement.reason,
        message: `The container this would land in is not an ordinary element: ${lowerFirst(containerPlacement.message)}`,
      },
    }
  }

  const fromFile = decodeSourceNodeId(node.id)?.rel
  const intoFile = decodeSourceNodeId(container.node.id)?.rel
  if (fromFile !== undefined && fromFile === intoFile) {
    return {
      ok: false,
      nodeId: node.id,
      refusal: {
        reason: 'reparent',
        message:
          'These two frames are two views of the same file, so this is an ordinary move rather than a move between screens. Drag it inside one frame.',
      },
    }
  }

  return {
    ok: true,
    commit: {
      nodeId: node.id,
      destinationParentNodeId: container.node.id,
      // `newIndex` counts the DROP PARENT's children. When the container had
      // to be re-resolved (the page root became the page's root element), that
      // index names a position in a different list, so it is dropped rather
      // than applied to the wrong one — identical reasoning to
      // `previewStructuralMove`'s reparent branch.
      ...resolveContainerAnchor(
        destinationTree,
        container.node,
        container.node.id === newParentId ? newIndex : undefined,
      ),
      copy,
    },
  }
}

/**
 * Whether `destinationTree` is a page a cross-frame drop could ever write into
 * — used by the DRAG, while the pointer is still down, to decide whether a
 * frame is a candidate at all before any container has been resolved.
 *
 * Cheap and shape-only on purpose: the real verdict is
 * {@link previewStructuralTransplant}, and this exists so the session does not
 * have to run it against every frame on the board on every animation frame.
 */
export function isTransplantDestinationTree(destinationTree: NodeTree<PageNode>): boolean {
  return isStudioPageRootId(destinationTree.rootNodeId)
}

/** Lowercase the first letter of a sentence being embedded inside another one. */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1)
}
