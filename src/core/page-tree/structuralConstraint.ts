/**
 * structuralConstraint — why a STRUCTURAL gesture was refused, and what the
 * user can do about it. Rows 7-18 of the taxonomy, plus the drag-preview
 * seam (D2).
 *
 * Split out of `editConstraint.ts` when that file passed the 700-line
 * ceiling, along the seam that file already drew in its own section
 * comments: this half is about moving, duplicating, wrapping and inserting
 * ELEMENTS (the `StructuralRefusalReason` vocabulary `sourceStructure.ts`
 * owns), while `editConstraint.ts` keeps the prop / style / className / CSS
 * half and the shared `EditConstraint` shape both produce.
 *
 * Like its parent it is a read-only TRANSLATION layer: it re-decides
 * nothing, it only turns a refusal that has already happened into a reason,
 * a sentence and a way forward. `@core/page-tree`'s barrel is the front door
 * for all of it.
 */
import { bestEffortRowLocation, decodeSourceNodeId } from './sourceNodeId'
import {
  refuseMintedNodeInsert,
  refuseStructuralEdit,
  type SourceStructureNode,
  type StructuralEditKind,
  type StructuralRefusal,
  type StructuralRefusalReason,
} from './sourceStructure'
import type { StructuralMovePreview } from './sourceStructurePreview'
import type { EditConstraint, EditConstraintAction } from './editConstraint'

/**
 * Jump to wherever `node`'s own id decodes to — shared by every reason whose
 * only honest way forward is "go look at the source", so `cross-file` /
 * `route-chrome` / `code-placed` don't each reimplement the same three lines.
 * For `shared-component`'s composite id this resolves to the COMPONENT's
 * file, not the call site's page — `decodeSourceNodeId` splits on `~` and
 * keeps the tail on purpose (see `sourceNodeId.ts`), and that tail is exactly
 * the file `edit-component` means to open.
 */
function jumpToSourceAction(node?: SourceStructureNode): EditConstraintAction[] {
  const target = node ? decodeSourceNodeId(node.id) : null
  return target ? [{ label: 'Open it in code', kind: 'jump-to-source', target }] : []
}

/**
 * Which `EditConstraintAction`s make sense for a given structural reason —
 * a compile-time-exhaustive table (`Record<StructuralRefusalReason, ...>`,
 * no `default` branch): a new reason added to `sourceStructure.ts` without a
 * matching entry here fails `tsc`, rather than silently falling through to an
 * unreviewed `default: []`.
 *
 * `node` is optional because a refusal does not always name one: the store
 * synthesises a handful of `insert` refusals about a CONTAINER it could not
 * resolve at all ("this page has several top-level elements…"), which have a
 * reason and a sentence but no element to point at.
 */
const STRUCTURAL_ACTIONS: Record<StructuralRefusalReason, (node?: SourceStructureNode) => EditConstraintAction[]> = {
  'list-row': (node) => {
    if (!node) return []
    // Row 3/7 — "edit the array it maps over", made actionable: jump to the
    // row's own source position (best-effort — `decodeSourceNodeId` cannot
    // match a `.map`-row id at all, see `bestEffortRowLocation`), which
    // sits inside or immediately beside the `.map()` call the taxonomy
    // names as the real target.
    const rowLocation = bestEffortRowLocation(node.id)
    return rowLocation ? [{ label: 'Open the array in code', kind: 'edit-array', target: rowLocation }] : []
  },
  'shared-component': (node) => {
    // Row 8 — three real ways forward, not one: look at the definition,
    // detach this one call site, or duplicate the definition as a new file
    // and edit that instead. `detach`/`extract` mutate editor state this
    // pure module cannot reach (`InstanceCallSiteView`'s own codemods,
    // wired by `constraintActions.ts`) — named here as action KINDS so the
    // caller that DOES have store access can wire the `run` handler.
    const editComponent = node ? decodeSourceNodeId(node.id) : null
    return [
      ...(editComponent ? [{ label: 'Open the component definition', kind: 'edit-component' as const, target: editComponent }] : []),
      { label: 'Detach this instance', kind: 'detach' },
      { label: 'Duplicate as a new file and edit that', kind: 'extract' },
    ]
  },
  // Rows 9-10 — a layout/template file or a code-placed element: the one
  // honest next step is looking at the source that decided this, not a dead
  // `select-container` action (R8's fix — see `bestEffortRowLocation`'s
  // sibling doc above for why the identical action wasn't wired for these
  // two before).
  'route-chrome': jumpToSourceAction,
  'code-placed': jumpToSourceAction,
  // W4-1 — a reparent refused for crossing files, or a reorder whose anchor
  // is in another file. The one useful next step is to look at where the
  // element actually lives, which `origin` already names.
  'cross-file': jumpToSourceAction,
  // `multi-select` and `insert` used to carry a `select-container` action
  // that `constraintActions.ts` itself documents as permanently unwired
  // dead code (three different refusals share that kind and only one of
  // them — `explainMintedInsertConstraint`'s own, unrelated, `insert`
  // reason — actually means "select something"). An honest empty array,
  // not a button that does nothing.
  'multi-select': () => [],
  'insert': () => [],
  // `reparent` (no destination named at all), `duplicate`, `wrap`, and
  // `no-sibling-anchor` are the residual gesture-only refusals W4-1 left
  // behind for ordinary elements: a gesture with no second location to
  // write against, and nothing on disk to jump to. Empty on purpose.
  'reparent': () => [],
  'duplicate': () => [],
  'wrap': () => [],
  'no-sibling-anchor': () => [],
  // K3 — the two ⌘G/⌘⇧G members of the same family: a gesture this caller
  // cannot write (the plugin/agent dispatcher), or a selection that is not a
  // run. Nothing on disk to jump to, so the sentence is the whole answer.
  'group': () => [],
  'ungroup': () => [],
  // K3 — the container carries behaviour (a handler, a ref, a `key`, a
  // spread, or it is a component). Dissolving it would drop that, and the one
  // honest way forward is to look at what it is doing: `origin` is the
  // wrapper's own `rel:line:col`, so this is the R1 jump every other
  // "the code decides this" refusal already offers.
  'has-behaviour': jumpToSourceAction,
  // `struct-11` — the wrapper would be invalid HTML where it lands. `node` is
  // the CONTAINER whose content model forbids it (the `<p>`, the `<ul>`), so
  // "go and look at it" is both true and the fastest way to the fix: the user
  // either moves the elements out of it or adds the container by hand.
  'content-model': jumpToSourceAction,
}

function structuralActions(
  reason: StructuralRefusalReason,
  node?: SourceStructureNode,
): EditConstraintAction[] {
  return STRUCTURAL_ACTIONS[reason](node)
}

/**
 * Dresses a refusal SOMEONE ELSE already computed — `refuseStructuralEdit`'s
 * own return value, `previewStructuralMove`'s in-flight verdict, or one of the
 * store's synthesised `insert` refusals — as the `EditConstraint` every
 * surface renders. The single place `origin` and `actions` are derived, so a
 * refusal reaching the UI through a plan object and one reaching it through a
 * direct `explain*` call cannot disagree about the way forward.
 *
 * Deliberately takes the refusal rather than re-asking for it: the plan
 * functions in `structuralSourceEdits.ts` do real work (simulating a reorder,
 * resolving an anchor) to reach theirs, and re-deriving it here would be a
 * second copy of that rule — exactly what this module's doc forbids.
 */
export function describeStructuralRefusal(input: {
  refusal: StructuralRefusal
  /** The element the refusal is about, when there is one. Supplies `origin`. */
  node?: SourceStructureNode
  /** `'gesture'` for a drag still in flight; `'node'` (the default) for a committed gesture. */
  scope?: 'node' | 'gesture'
}): EditConstraint {
  const decoded = input.node ? decodeSourceNodeId(input.node.id) : null
  return {
    reason: input.refusal.reason,
    scope: input.scope ?? 'node',
    explanation: input.refusal.message,
    ...(decoded ? { origin: { rel: decoded.rel, line: decoded.line, col: decoded.col } } : {}),
    actions: structuralActions(input.refusal.reason, input.node),
  }
}

/**
 * Explains a refused STRUCTURAL gesture (reorder/reparent/delete/insert/
 * duplicate/wrap), or `null` when it may proceed. Thin wrapper over
 * `refuseStructuralEdit` — same input shape, same refusal, now carrying an
 * explanation + actions instead of a bare `{reason, message}`.
 */
export function explainStructuralConstraint(input: {
  kind: StructuralEditKind
  node: SourceStructureNode
  anchor?: SourceStructureNode | null
}): EditConstraint | null {
  const refusal = refuseStructuralEdit(input)
  if (!refusal) return null
  return describeStructuralRefusal({ refusal, node: input.node })
}

/**
 * Explains dropping an already-minted (canvas-only) node into a source-backed
 * container — row 18's insert family, `refuseMintedNodeInsert`'s own case.
 */
export function explainMintedInsertConstraint(input: {
  parent: SourceStructureNode
  studioPageRoot: boolean
}): EditConstraint | null {
  const refusal = refuseMintedNodeInsert(input)
  if (!refusal) return null
  return {
    reason: refusal.reason,
    scope: 'node',
    explanation: refusal.message,
    actions: [{ label: 'Add from the picker instead', kind: 'select-container' }],
  }
}

/**
 * `scope: 'gesture'` — the drag-in-progress preview D2's `previewStructuralMove`
 * (`sourceStructure.ts`, published contract D2 → F2, see that function's own
 * doc) computes WHILE THE POINTER IS STILL DOWN. This wrapper is the typed
 * seam this track owns: translate `StructuralMovePreview`'s refusal into the
 * same `EditConstraint` shape every other structural refusal uses, so a drop
 * indicator and a context-menu item read one type.
 *
 * `previewStructuralMove` is D2's published export (`@core/page-tree`) — this
 * track does not edit `sourceStructure.ts` and did not need to: the function
 * already lands with the exact signature this wrapper expects. If a future
 * change to that signature breaks this file, `tsc` catches it at the call
 * site below, not silently.
 */
export function explainGestureConstraint(preview: StructuralMovePreview, node: SourceStructureNode): EditConstraint | null {
  if (preview.ok) return null
  return describeStructuralRefusal({ refusal: preview.refusal, node, scope: 'gesture' })
}

/**
 * K6 — `scope: 'gesture'`. A ⌘-drag asked to place an element by coordinates
 * inside a container that is `position: static`.
 *
 * This is the one refusal in this module that is NOT a source-writability
 * question: the file could take the write perfectly well. It is a CSS
 * question. Absolutely positioning an element inside a static parent does not
 * place it in that parent at all — the browser hands it to the nearest
 * POSITIONED ancestor, or to the viewport — so writing `position: absolute;
 * left: …; top: …` here would put the element somewhere the user did not
 * point at, which is the silent-wrong-target failure the whole refusal
 * vocabulary exists to prevent.
 *
 * It is also the one refusal whose remedy is a WRITE rather than a
 * navigation, and the write is small, reversible and exactly what the user
 * would type: one `position: relative` on the container. `parentLabel` is in
 * the sentence because "the container" is not something a person can find on
 * a busy page.
 */
export function explainStaticParentConstraint(parentLabel: string): EditConstraint {
  return {
    reason: 'static-parent',
    scope: 'gesture',
    explanation: `\`<${parentLabel}>\` is \`position: static\`, so placing this element by coordinates inside it would hand it to a different ancestor instead — it would not land where you dropped it.`,
    actions: [{ label: `Make <${parentLabel}> position: relative`, kind: 'position-parent-relative' }],
  }
}
