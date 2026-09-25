/**
 * The single rule for "can the editor change this node's PLACE in the source?"
 * — the structural counterpart to `sourceWritability.ts`'s per-prop rule, and
 * the reason a structural gesture on a studio-imported board either writes a
 * file or says why it cannot.
 *
 * Until `struct-01` there was no third option: `StudioEdit` had no `move`,
 * `delete`, `insert` or `reorder` kind, and `saveSite` diffed values only. A
 * user dragged a row in the layers tree, the tree updated, the save reported
 * success, the `.tsx` was untouched, and the move was gone on reload. In
 * Studio the repository IS the document, so an edit the repository never saw
 * did not happen — a silent no-op is exactly the failure the "one honest write
 * target" invariant exists to prevent.
 *
 * Two questions, asked in this order:
 *
 *   1. **Is this ours?** A CMS node (a nanoid id) is not source-backed and
 *      these rules must not narrow what the ordinary editor can do to it.
 *      `isSourceDerivedNodeId` decides.
 *   2. **Does the edit have exactly one honest target?** For a REORDER or a
 *      DELETE of a plain element written at a known `line:col`, it does: the
 *      JSX child moves or goes, and nothing else in the file changes. For
 *      everything else it provably does not, and the answer is a refusal
 *      carrying a sentence a person can act on.
 *
 * What refuses, and why it is not solvable by trying harder:
 *
 *   - **`list-row`** — a `.map` row (`…:70:21#2`). One piece of source JSX
 *     renders every row; there is no position an edit to row 2 could occupy
 *     that would not rewrite all of them.
 *   - **`shared-component`** — an inlined id (`callSite~component:l:c`). The
 *     markup lives in the component's own file, so moving it here moves it for
 *     every instance on the board.
 *   - **`route-chrome`** — a Next `layout`/`template` file, composed into
 *     every route beneath it. Same "one file, many frames" problem.
 *   - **`code-placed`** — the parser recorded a structural `lockReason`: a
 *     spread, a dynamic child, a branch the source chooses at runtime. The
 *     source does not place this element at a fixed position, so neither can
 *     we.
 *   - several elements at once are NOT refused here any more (P3-D). A
 *     multi-element move is planned as single-element moves applied in order
 *     (`moveSequence.ts`) and written as one `/save` sequence; a multi-element
 *     wrap is a group. Each single element is asked this question on its own.
 *   - **`cross-file`** / **`no-sibling-anchor`** — a reorder is written as
 *     "put this element before/after that one", so it needs a sibling that is
 *     itself a plain element in the same file to write against. A reparent
 *     needs its new parent in that same file, for a stronger reason: across
 *     files the markup would land where the values it reads do not exist.
 *
 * **What `insert` taught the other four verbs (`struct-02`, then W4-1).**
 * `reparent`, `duplicate` and `wrap` used to be blanket refusals, on the stated
 * grounds that each "needs a source position that does not exist yet". That was
 * true of a node MINTED ON THE CANVAS, and false of a position the SOURCE is
 * asked to grow: `insertJsxElement` writes the element (and the import that
 * names it) into the user's file, the board re-reads it, and what appears on the
 * canvas is an ordinary parsed node with a real `rel:line:col`. W4-1 generalised
 * that write-then-re-read shape to the other three —
 * `duplicateJsxElement`/`wrapJsxElement`/`moveJsxElement`'s destination-parent
 * form — so the question for all of them is the one this rule was always able to
 * answer: is this an ordinary, singly-placed element (`refusePlacement`), and is
 * the second location it names in the same file?
 *
 * An `insert` is the one asked about a CONTAINER rather than about a node that
 * exists; `planSourceInsert` resolves the container (the synthetic page root
 * becomes the page's returned root element) before asking here.
 *
 * The refusals only a PARSE can answer stay with the codemods and arrive at
 * save time: `not-siblings`, `expression-child`,
 * `no-jsx-parent`, `into-own-descendant`, and — the one W4-1 added —
 * `out-of-scope`, a reparent whose markup reads a binding that does not exist
 * where it would land. See `src/core/ast-codemods/moveJsxElement.ts`.
 *
 * The rule is pure and knows nothing about HTTP: the store's mutation guards
 * consult it BEFORE mutating, `applyTreeOperation` consults it so a plugin or
 * an agent rides the same gate, and the server's codemods re-derive the same
 * facts from the AST. See `src/core/ast-codemods/moveJsxElement.ts` for the
 * residual refusals only the AST can answer (`not-siblings`, `expression-child`).
 */
import {
  INLINE_ID_SEPARATOR,
  decodeSourceNodeId,
  hasWritableSourceLocation,
  isInlinedNodeId,
  isRouteChromeNodeId,
  isSourceDerivedNodeId,
} from './sourceNodeId'

/** The structural gestures the editor offers. One refusal vocabulary for all of them. */
export type StructuralEditKind =
  | 'reorder'
  | 'reparent'
  | 'delete'
  | 'insert'
  | 'duplicate'
  | 'wrap'
  // K3 — ⌘G and ⌘⇧G. `group` is `wrap` widened to a CONTIGUOUS RUN of
  // siblings (one container around one span, `wrapJsxElements`); `ungroup`
  // is its inverse (`unwrapJsxElement`). The contiguity half of the rule
  // needs a live tree and lives in `sourceStructureGroup.ts`; what stays
  // here is the per-node half every gesture shares.
  | 'group'
  | 'ungroup'

/** Why a structural edit has no single honest target in the user's source. */
export type StructuralRefusalReason =
  | 'list-row'
  | 'shared-component'
  | 'route-chrome'
  | 'code-placed'
  | 'reparent'
  | 'insert'
  | 'duplicate'
  | 'wrap'
  | 'group'
  | 'ungroup'
  // K3 — the wrapper is doing more than holding its children (a handler, a
  // ref, a `key`, a spread, or a component tag), so dissolving it would drop
  // behaviour the code relies on. Decided by the AST alone
  // (`unwrapJsxElement`), which is why it arrives at save time like
  // `out-of-scope` rather than from the id.
  | 'has-behaviour'
  // `struct-11` — the container a group would write cannot legally sit where
  // it would land, or cannot legally hold what it would hold: a `<div>` inside
  // a `<p>`, any wrapper inside a `<ul>`, a wrapper around an `<li>`. Decided
  // from the HTML content model (`@core/utils/htmlContentModel`) — by
  // `previewStructuralGroup` when the caller can name the tags, and always by
  // `wrapJsxElement`/`wrapJsxElements` against the real AST.
  | 'content-model'
  | 'multi-select'
  | 'cross-file'
  | 'no-sibling-anchor'

/** A refused structural edit: the machine-readable reason plus the sentence the user reads. */
export interface StructuralRefusal {
  reason: StructuralRefusalReason
  message: string
}

/** The only two fields these rules read — structural, so a `BaseNode` can be asked the question too. */
export interface SourceStructureNode {
  id: string
  lockReason?: string
}

/** Human label for the gesture, used in every refusal sentence. */
const GESTURE: Record<StructuralEditKind, string> = {
  reorder: 'Moved',
  reparent: 'Moved',
  delete: 'Deleted',
  // An insert is asked about the CONTAINER it lands in, not about a node that
  // exists yet, so its refusals read "Added into <what this container is>".
  insert: 'Added into',
  duplicate: 'Duplicated',
  wrap: 'Wrapped',
  group: 'Grouped',
  ungroup: 'Ungrouped',
}

/**
 * Whether this node's PLACE can be written back to the user's source, and if
 * not, why. `null` means the edit may proceed — either because the node is not
 * source-derived at all (an ordinary CMS node), or because it is a plain
 * element the codemods can honestly move, copy, wrap or remove.
 *
 * `anchor` is required for `reorder` only: the sibling the moved element is
 * written against (`moveJsxElement` writes "put A immediately before/after B",
 * never an index, because the editor's child order and the JSX child order
 * disagree wherever an expression child renders more than one node).
 *
 * `destination` is required for `reparent` only: the container the element
 * lands INSIDE. It has to satisfy the same "ordinary, singly-placed element"
 * test the moved node does, and live in the same file.
 */
export function refuseStructuralEdit(input: {
  kind: StructuralEditKind
  node: SourceStructureNode
  anchor?: SourceStructureNode | null
  /** The new parent, for `reparent`. */
  destination?: SourceStructureNode | null
}): StructuralRefusal | null {
  const { kind, node, anchor, destination } = input
  if (!isSourceDerivedNodeId(node.id)) return null

  const gesture = GESTURE[kind]

  const placement = refusePlacement(node, gesture)
  if (placement) return placement

  switch (kind) {
    case 'insert':
      // An insert is asked about the CONTAINER, not about a node that exists —
      // the new element has no id yet, and it never gets a canvas-minted one:
      // `insertJsxElement` writes it to the file and the board re-reads it. So
      // the only question is whether this container is a place the codemod can
      // honestly write a child, which `refusePlacement` just answered.
      //
      // The synthetic page root is the one container with no source location of
      // its own; `planSourceInsert` resolves it to the page's returned root
      // element before asking, so it never reaches here.
      return null
    case 'delete':
      return null
    case 'duplicate':
      // `duplicateJsxElement` writes the element's own source text in again as
      // its next sibling, in the same file and the same scope — so an ordinary
      // element at a known location is the whole requirement. There is no
      // second place to check: no anchor (the copy's position is "right here"),
      // and no import to reconcile (every binding the markup reads was already
      // in scope one line up).
      return null
    case 'wrap':
      // `wrapJsxElement` replaces the element's own range with the same element
      // inside a container it writes. The wrapper is REAL DOM once it is in the
      // file — Studio's "no wrapper divs" rule is about the CANVAS inventing
      // elements the source does not contain, which is the opposite of this.
      return null
    case 'group':
      // K3 — one container around a RUN of siblings (`wrapJsxElements`). Per
      // node this asks exactly what `wrap` asks, which `refusePlacement` has
      // already answered; what group adds is a question about the RUN — are
      // these siblings, and is anything unnamed between them — which needs the
      // tree and is answered by `previewStructuralGroup`
      // (`sourceStructureGroup.ts`) before this is ever reached.
      return null
    case 'ungroup':
      // K3 — the container goes and its children take its place
      // (`unwrapJsxElement`). An ordinary element at a known location is the
      // whole requirement here; whether the wrapper is ONLY a wrapper is a
      // question about its attributes, which only the AST can answer
      // (`has-behaviour`).
      return null
    case 'reparent': {
      if (!destination) {
        return {
          reason: 'reparent',
          message:
            'Studio writes a move into a new parent as "put this element inside that one", so it needs a container that is itself an ordinary element in the code.',
        }
      }
      const destinationPlacement = refusePlacement(destination, 'Moved into')
      if (destinationPlacement) {
        return {
          reason: destinationPlacement.reason,
          message: `The container this would move into is not an ordinary element: ${lowerFirst(destinationPlacement.message)}`,
        }
      }
      const fromFile = decodeSourceNodeId(node.id)?.rel
      const intoFile = decodeSourceNodeId(destination.id)?.rel
      if (fromFile !== intoFile) {
        return {
          reason: 'cross-file',
          message: `This element is written in ${fromFile} and the container is in a different file (${intoFile}). Studio moves an element to a new parent within one file; across files the markup would land where the values it reads do not exist.`,
        }
      }
      return null
    }
    case 'reorder':
      break
  }

  if (!anchor) {
    return {
      reason: 'no-sibling-anchor',
      message:
        'This element has no plain sibling to be written next to. Studio records a reorder as "put this before that one", so it needs a neighbour that is itself an ordinary element in the same file.',
    }
  }
  const anchorPlacement = refusePlacement(anchor, 'Moved')
  if (anchorPlacement) {
    return {
      reason: 'no-sibling-anchor',
      message: `The element this would be written next to is not an ordinary one: ${lowerFirst(anchorPlacement.message)}`,
    }
  }
  const nodeFile = decodeSourceNodeId(node.id)?.rel
  const anchorFile = decodeSourceNodeId(anchor.id)?.rel
  if (nodeFile !== anchorFile) {
    return {
      reason: 'cross-file',
      message: `These two elements come from different files (${nodeFile} and ${anchorFile}), so there is no single place to write the new order.`,
    }
  }
  return null
}

/**
 * The half of the rule that is about the node's own source position rather
 * than the gesture — shared by the moved element and by the sibling a reorder
 * is written against, because "is this an ordinary element at a known line"
 * is the same question for both.
 *
 * **Published contract (E2.1/D2/F2, `STUDIO-FIGMA-PARITY-PLAN.md` §8's
 * Track E).** Originally a private half of `refuseStructuralEdit`; exported
 * because three more verbs — extract-to-component (E2.1), and the two work
 * orders serialized after it (D2, F2) — ask exactly this question ("is this
 * node an ordinary, singly-placed element, or does the parser's own
 * structural verdict rule out ANY single honest writeback target here") for
 * gestures that are not reorder/delete/insert at all. Reusing this function
 * means all of them refuse `list-row` / `shared-component` / `route-chrome` /
 * `code-placed` with the IDENTICAL vocabulary the user already sees on a
 * failed move or delete, rather than each verb inventing its own parallel
 * set of reasons for the same four underlying facts.
 *
 * `gesture` is the only thing a new caller supplies beyond `node` — a past-
 * tense verb (`'Moved'`, `'Extracted'`, …) the four messages below splice in
 * (`` `${gesture} a row of a list…` ``). `node.lockReason` is the parser's
 * OWN structural verdict (`ParsedNode.lockReason`) — this function is pure
 * and has no access to the loaded page tree itself, so a caller that HAS one
 * (the store, a server handler that already parsed the workspace) must pass
 * it through; a caller that only has raw AST coordinates (no parsed tree)
 * gets `route-chrome` for free (`isRouteChromeNodeId` reads the id's
 * filename alone) but not `list-row`/`shared-component`/`code-placed`, which
 * need information only a parse carries. See `extractSubtreeToComponent.ts`'s
 * own module doc for how it threads this through when a caller can supply it,
 * and what it checks independently from the AST when a caller cannot.
 */
export function refusePlacement(node: SourceStructureNode, gesture: string): StructuralRefusal | null {
  if (!hasWritableSourceLocation(node.id)) {
    return {
      reason: 'list-row',
      message: `${gesture} a row of a list that the code generates. One piece of source JSX renders every row, so there is no way to change just this one — edit the array it maps over.`,
    }
  }
  if (isInlinedNodeId(node.id) && !isSoleInstanceNodeId(node.id)) {
    return {
      reason: 'shared-component',
      message: `${gesture} markup that lives in a shared component's own file, so the change would apply to every place that component is used, not just here.`,
    }
  }
  if (isRouteChromeNodeId(node.id)) {
    return {
      reason: 'route-chrome',
      message: `${gesture} markup from a layout file, which every page below it renders — the change would apply to all of them, not just this frame.`,
    }
  }
  if (node.lockReason) {
    return {
      reason: 'code-placed',
      message: `The code decides where this element goes (${node.lockReason}), so its position is not something Studio can write.`,
    }
  }
  return null
}

/**
 * OD-7 — component files Studio made for ONE call site: the copy
 * (`extractComponentCopy`, `Card` → `Card2`) the editor writes when a detach
 * refuses. Markup inlined from such a file has exactly one instance, so a
 * structural edit written into it changes only that instance — an honest
 * single target, not a `shared-component` refusal. Recorded by the store the
 * moment it makes the copy; a board read never forgets it for the session.
 */
const soleInstanceComponentFiles = new Set<string>()

export function markSoleInstanceComponentFile(rel: string): void {
  soleInstanceComponentFiles.add(rel)
}

/** True for markup inlined ONE level deep from a file in {@link markSoleInstanceComponentFile}'s set. */
function isSoleInstanceNodeId(nodeId: string): boolean {
  const segments = nodeId.split(INLINE_ID_SEPARATOR)
  const rel = decodeSourceNodeId(nodeId)?.rel
  return segments.length === 2 && rel !== undefined && soleInstanceComponentFiles.has(rel)
}

/**
 * OD-7 — a `shared-component` refusal is not the end of a gesture in the
 * editor: the store detaches THIS instance and replays the gesture on the
 * markup that replaced it (`instanceOnlyGesture.ts`), as one undo. A surface
 * that PREVIEWS a gesture — a drop line, a context-menu item — asks this so it
 * does not grey out what the commit will do. (When the detach itself refuses,
 * the commit shows the refusal dialog, exactly as before.)
 */
export function isResolvedByInstanceDetach(reason: string): boolean {
  return reason === 'shared-component'
}

/**
 * The refusal for adding an ALREADY-MINTED node to a studio-imported tree, or
 * `null` when the destination is an ordinary CMS tree.
 *
 * This is the other half of `insert`, and the distinction is the node's origin,
 * not the container. The editor's own picker path never mints a node: it asks
 * `insertJsxElement` to write the element into the file and re-reads the board,
 * so what lands is a real parsed node — and `refuseStructuralEdit`'s `insert`
 * case asks only whether the CONTAINER can hold a written child.
 * `applyTreeOperation`'s callers (a plugin, an agent) hand over a node object
 * that already exists, id and all, and that id can never be a source location.
 * Accepting it would put something on the board that no file describes, which
 * is the silent no-op `struct-01` exists to prevent — so it refuses, and points
 * at the path that does work.
 *
 * `studioPageRoot` answers the question for the one container that cannot
 * answer it from its own id: the synthetic `<pageId>:body` root of an imported
 * page, which is where an insert into an EMPTY one lands.
 */
export function refuseMintedNodeInsert(input: {
  parent: SourceStructureNode
  studioPageRoot: boolean
}): StructuralRefusal | null {
  if (!input.studioPageRoot && !isSourceDerivedNodeId(input.parent.id)) return null
  return {
    reason: 'insert',
    message:
      'This element was created in the editor, so it has no markup in your project for Studio to write. Add a component from the canvas picker instead — that one writes the element and its import into the file.',
  }
}

/**
 * The refusal for DUPLICATING, WRAPPING or REPARENTING a studio-imported node
 * through a caller that mutates a tree instead of writing source — or `null` on
 * an ordinary CMS tree, where a canvas mutation is the whole story.
 *
 * The sibling of `refuseMintedNodeInsert`, and W4-1 is why it exists. Those
 * three verbs now WRITE (`duplicateJsxElement`, `wrapJsxElement`,
 * `moveJsxElement`'s destination-parent form), so `refuseStructuralEdit` no
 * longer refuses them — but "the source can take this edit" is only half the
 * question. The other half is whether the CALLER is one that issues the write.
 *
 *   - The editor is: `nodeActions` asks the source to grow the element and the
 *     board re-reads it, so the copy/wrapper on screen is a parsed node with a
 *     real `rel:line:col`.
 *   - `applyTreeOperation`'s callers are not: `mutatePageTree` persists a tree
 *     into a `data_row`, never into a `.tsx`. Duplicating a source-derived node
 *     there mints a nanoid child that no file describes — the silent no-op
 *     `struct-01` exists to prevent, in a new place.
 *
 * A REORDER through that dispatcher is a different case and stays permitted:
 * it mints nothing, and the node ids it rearranges keep meaning exactly what
 * they meant.
 */
export function refuseMintedNodeCopy(input: {
  kind: 'duplicate' | 'wrap' | 'reparent' | 'group' | 'ungroup'
  node: SourceStructureNode
}): StructuralRefusal | null {
  if (!isSourceDerivedNodeId(input.node.id)) return null
  const noun = input.kind === 'reparent' ? 'move' : input.kind
  return {
    reason: input.kind,
    message: `Studio ${noun}s imported markup by editing your project's source and re-reading it. This path changes the canvas tree only, so the ${noun} would never reach the file — do it from the editor, which writes it.`,
  }
}

/**
 * Thrown by `applyTreeOperation` when a structural operation would silently
 * fail to reach a studio-imported node's source. The editor asks
 * `refuseStructuralEdit` before mutating and never sees this; a plugin or an
 * agent driving the dispatcher directly does, so it gets the same reason
 * rather than a mutation nothing will ever persist.
 */
export class SourceStructureError extends Error {
  readonly reason: StructuralRefusalReason

  constructor(refusal: StructuralRefusal, nodeId: string) {
    super(`[page-tree] ${nodeId}: ${refusal.message}`)
    this.name = 'SourceStructureError'
    this.reason = refusal.reason
  }
}

/** Lower-cases the first character so a refusal can be quoted mid-sentence. */
function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text
}
