/**
 * editConstraint — the ONE typed shape a refused edit surface renders,
 * wrapping the existing pure predicates (`isPropWritableToSource`,
 * `isStyleWritableToSource`, `refuseStructuralEdit`, `refusePlacement`,
 * `previewStructuralMove`, `refuseMintedNodeInsert`) that already decide
 * whether an edit lands. Those predicates keep their existing boolean/refusal
 * return shapes UNCHANGED — this module is a read-only, additive translation
 * layer for UI consumption, not a new source of truth. If you find yourself
 * changing what gets refused, you are editing the wrong file: that logic
 * lives in `sourceWritability.ts` / `sourceStructure.ts`, and this module
 * must not duplicate it.
 *
 * Track F2 (`STUDIO-FIGMA-PARITY-PLAN.md` §9), taxonomy in
 * `docs/audits/2026-08-06/09-refusal-states.md`. The problem this fixes is
 * not the ENGINE (sound) but the TRANSPORT: today a refusal is a bare string
 * or a toast fired after the gesture, with no structured "why" and no "way
 * forward". `EditConstraint` is engine-authored (the `explanation` sentence is
 * built here, once, from the same facts the refusing predicate already
 * computed) so every surface reads the identical wording instead of
 * re-deriving it three files later from a fallback string (the R2 bug this
 * plan fixes at the parser layer — see `nodeResolution.ts`'s `resolvedProps`).
 *
 * **The §2 invariant this whole module exists to enforce:** every edit
 * surface either WRITES, REFUSES with a reason and a way forward, or IS NOT
 * OFFERED. A refusal with an empty `actions` array is still honest — some
 * reasons (`route-chrome`, `wrap`, `code-placed`) truly have no way forward
 * yet — but it must be a deliberate empty array, not a missing one.
 */
import { isPropWritableToSource, isStyleWritableToSource, styleValueKey, type SourceWritableNode } from './sourceWritability'
import {
  refuseMintedNodeInsert,
  refusePlacement,
  refuseStructuralEdit,
  type SourceStructureNode,
  type StructuralEditKind,
  type StructuralMovePreview,
  type StructuralRefusalReason,
} from './sourceStructure'
import { decodeSourceNodeId, hasWritableSourceLocation } from './sourceNodeId'

/**
 * Best-effort location for a `.map`-row id (`…:70:21#2`). `decodeSourceNodeId`
 * deliberately refuses to match this shape at all (`hasWritableSourceLocation`
 * is what that non-match means — see `sourceNodeId.ts`'s own doc), because
 * there is no SINGLE honest writeback target for the row. But there IS a real
 * `rel:line:col` sitting right there in the id — the row's own rendered
 * position, one syntactic hop from the `.map()` call the taxonomy names as
 * the real edit target. Not precise enough to claim as `origin` (this module
 * only sets `origin` when a location is the honest single truth), but precise
 * enough to open the right FILE near the right LINE — the R8 fix for a
 * refusal family the audit otherwise correctly says has no jump-to-source at
 * all today.
 */
function bestEffortRowLocation(nodeId: string): { rel: string; line: number; col: number } | undefined {
  const target = nodeId.split('~').pop() ?? nodeId
  const match = /^(.+):(\d+):(\d+)(?:#\d+)+$/.exec(target)
  return match ? { rel: match[1]!, line: Number(match[2]), col: Number(match[3]) } : undefined
}

// ---------------------------------------------------------------------------
// The discriminated union — the taxonomy's 30 rows, absorbed rather than
// re-invented. Every member below cites the taxonomy row(s) it covers.
// ---------------------------------------------------------------------------

/** What KIND of edit is being described. Drives which control renders the constraint. */
export type ConstraintScope = 'prop' | 'style-property' | 'node' | 'gesture'

/**
 * A single, nameable reason a value or gesture is refused. `StructuralRefusalReason`
 * (rows 7-18) is absorbed directly — see `sourceStructure.ts` for that union's
 * own doc. Everything else is this module's own vocabulary, one branch per
 * taxonomy row/family, or absorbed verbatim from a sibling track's own
 * refusal union (B2's `className` vocabulary, B1/B1b's CSS vocabulary,
 * `detachComponent.ts`'s `DetachRefusalReason`) — named here as PLAIN STRING
 * LITERALS matching those unions' own values, not type-imported, because
 * importing from `@core/ast-codemods`/`@core/css-codemods` into `@core/page-tree`
 * would create an import cycle (`ast-codemods` already depends on
 * `page-tree` for `refusePlacement`/`LOOP_ID_SEPARATOR`).
 */
export type ConstraintReason =
  // Rows 1-2 — prop-scope: value backed by a resolved expression, or a
  // structured/JSX value with no scalar source form at all.
  | 'resolved-expression'
  | 'structured-value'
  // Row 5 — style-scope: an inline-style property resolved from an expression.
  | 'resolved-style-expression'
  // Row 6 — style-scope: the whole node has no writable source location for
  // ANY inline style (a `.map` row) — distinct from row 1/6's `list-row`,
  // which is node/gesture-scope; this is the style surface's OWN question.
  | 'no-inline-style-target'
  // Rows 7-18 — structural, absorbed verbatim.
  | StructuralRefusalReason
  // Rows 19-21 — Detach, absorbed from `DetachRefusalReason`
  // (`src/core/ast-codemods/detachComponent.ts`) by string value — UNPREFIXED,
  // matching that union's own literal values exactly (the caller passes its
  // `DetachFailure.refusal.reason` straight through).
  | 'not-a-component'
  | 'package-component'
  | 'unresolvable'
  | 'uses-hooks'
  | 'maps-over-props'
  | 'unsupported-params'
  | 'no-renderable-jsx'
  | 'name-collision'
  // Row 22 — Swap refusal (component shape mismatch, etc).
  | 'swap-refused'
  // Row 23 — save-time prop/text/style edit reached no writable location, only
  // ever known in aggregate today (`unexplainedSkips`) — see this module's
  // `explainUnexplainedSkip` doc for why it stays informational-only.
  | 'unexplained-skip'
  // Row 25-26 — CSS class/breakpoint has no hand-editable source, absorbed
  // from B1/B1b's `classifyStylesheetEditability` vocabulary.
  | 'no-editable-stylesheet'
  | 'ambiguous-stylesheet'
  | 'stylesheet-import-shape-mismatch'
  | 'breakpoint-override-unsupported'
  // Row 27 — inline text edit blocked before it starts. RESERVED, not
  // currently produced: text is an ordinary prop key to `explainPropConstraint`
  // (its resolvedProps entry is keyed `'text'`, remapped to the module's own
  // text prop by `parsedPageToSitePage`), so a caller wiring row 27's actual
  // site (`inlineEditSlice.ts`'s pre-edit-mode check — store territory, not
  // touched by this additive-wrapper track) gets `resolved-expression` or
  // `list-row` from that same function, not a bespoke reason. Kept in the
  // union as the taxonomy's own name for the row, not as a promise this
  // module emits it.
  | 'inline-text-locked'
  // Row 28 — the whole `htmlAttributes` bag locked as one JSX prop/object.
  // RESERVED for the same reason as row 27: `explainPropConstraint(node,
  // 'htmlAttributes')` already answers this generically (today's real gate,
  // `PropertiesPanelBody.tsx`'s `isPropWritableToSource(selectedNode,
  // 'htmlAttributes')`, is untouched and correct — see R7 scope notes).
  | 'html-attributes-locked'
  // Row 29 — a branch the parser did not select. NOT produced by this module
  // on purpose: `BranchChoiceNotice` is not a REFUSAL (nothing is blocked —
  // the alternative is simply not the default view), so it is handled
  // directly by that component (R6's switcher) rather than routed through
  // `EditConstraint`, which exists for things an edit surface refuses.
  | 'branch-not-shown'
  // Row 30 — package-sourced instance: detach/swap/duplicate not offered yet.
  // RESERVED: already correctly handled today, before interaction, by
  // `InstanceCallSiteView.tsx`'s own `source === 'package'` check + `Button`
  // `disabled`/`tooltip` (E2.5-owned, not touched by this track).
  | 'package-component-locked'
  // B2's `className` vocabulary (`src/core/ast-codemods/setJsxClassName.ts`),
  // absorbed by string value for the same import-cycle reason as Detach above.
  | 'css-module-binding'
  | 'template-dynamic'
  | 'unsupported-call'
  | 'unsupported-expression'
  | 'spread-attribute'

/** A way forward out of a refusal — the thing that turns a dead end into progress. */
export interface EditConstraintAction {
  /** Button/link label, e.g. "Duplicate as new file", "Edit the array", "Open in code". */
  label: string
  kind:
    | 'jump-to-source'
    | 'edit-array'
    | 'detach'
    | 'extract'
    | 'select-container'
    | 'promote-tier1'
    | 'style-inline-instead'
    | 'preview-branch'
  /**
   * Where this action points, when it points at a file — `origin`'s own
   * shape, so a caller can wire `jump-to-source` without re-deriving it.
   * Absent for actions that are pure instruction ("Drag them one by one") or
   * that need a caller-supplied callback the engine cannot construct
   * (`detach`/`extract`/`preview-branch` all mutate editor state).
   */
  target?: { rel: string; line: number; col: number }
}

export interface EditConstraint {
  reason: ConstraintReason
  scope: ConstraintScope
  /** The one sentence a person reads. Always concrete — names the file/expression/component when known. */
  explanation: string
  /** Where in source this traces to, when there is one. Powers `jump-to-source` (R8). */
  origin?: { rel: string; line: number; col: number }
  /** Zero or more legitimate ways forward. An empty array is an honest terminal refusal, not a bug. */
  actions: EditConstraintAction[]
}

// ---------------------------------------------------------------------------
// Prop scope — rows 1, 2, 28. R2's fix (`resolvedProps`, per-prop not
// per-node) is what makes `explanation` here name the RIGHT source.
// ---------------------------------------------------------------------------

/** The extra per-prop facts `sourceWritability.ts`'s bare `{lockReason, codeProps}` doesn't carry. */
export interface ConstraintPropSource extends SourceWritableNode {
  id?: string
  /** R2 — `PageNode.resolvedProps`, keyed like `codeProps`. See `nodeResolution.ts`. */
  resolvedProps?: Record<string, { source: string; note?: string }>
}

/**
 * Explains a refused PROP, or `null` when it is writable. `value` — the
 * prop's current resolved value — decides row 1 vs. row 2: a structured
 * value (array/object) has no scalar source form and is refused for a
 * different, more final reason (mirrors `isStructuredValue` in
 * `PropertyControlRenderer.tsx`, which callers should keep using for the
 * disabled-row-vs-editable decision; this function is for the EXPLANATION).
 */
export function explainPropConstraint(
  node: ConstraintPropSource,
  propKey: string,
  value?: unknown,
): EditConstraint | null {
  if (isPropWritableToSource(node, propKey)) return null

  // Row 3/17-ish via row 1's mechanism: a `.map` row has no writable source
  // location at ALL, so every prop is refused for the SAME structural reason
  // — reuse the identical wording a failed move/delete already shows instead
  // of inventing a value-shaped explanation for a fact that is really
  // structural. `node.id` is optional (a caller with only a bare prop bag has
  // no id to ask) — falls through to the ordinary value-shaped explanation.
  if (node.id !== undefined && !hasWritableSourceLocation(node.id)) {
    const placement = refusePlacement({ id: node.id, lockReason: node.lockReason }, 'Edited')
    if (placement) {
      // No `origin` — `decodeSourceNodeId` deliberately refuses to match a
      // `.map`-row id (that IS what "no writable source location" means), so
      // there is no single honest location to claim as the truth. There is a
      // real, useful-but-imprecise one for the ACTION — see `bestEffortRowLocation`.
      const rowLocation = bestEffortRowLocation(node.id)
      return {
        reason: placement.reason,
        scope: 'prop',
        explanation: placement.message,
        actions: rowLocation
          ? [{ label: 'Open the file', kind: 'edit-array', target: rowLocation }]
          : [],
      }
    }
  }

  const isStructured = value !== undefined && typeof value === 'object' && value !== null
  if (isStructured) {
    return {
      reason: 'structured-value',
      scope: 'prop',
      explanation: 'This value is an array or object set in code — there is no single line to write a scalar edit onto.',
      actions: [],
    }
  }

  const resolved = node.resolvedProps?.[propKey]
  if (resolved) {
    return {
      reason: 'resolved-expression',
      scope: 'prop',
      explanation: resolved.note
        ? `Reads \`${resolved.source}\` — ${resolved.note}.`
        : `Reads \`${resolved.source}\` from code. Writing here would replace the binding with a fixed value.`,
      actions: [],
    }
  }

  // No per-prop resolution recorded (a structural lock covers this prop, or
  // the parser only recorded the node-level `lockReason`) — the one honest
  // thing left to say.
  return {
    reason: 'resolved-expression',
    scope: 'prop',
    explanation: node.lockReason ? `The code decides this value (${node.lockReason}).` : 'Set in code.',
    actions: [],
  }
}

// ---------------------------------------------------------------------------
// Style scope — rows 5, 6.
// ---------------------------------------------------------------------------

/**
 * Explains a refused inline-style PROPERTY, or `null` when it is writable.
 * Mirrors `explainPropConstraint` exactly, keyed through `styleValueKey`.
 *
 * **Integration seam for F1** (`StyleSectionsEditor.tsx` / `InlineStyleComposer.tsx`
 * / `ClassPropertyRow.tsx` — not touched by this track). F1 independently
 * landed R1's core fix (the lock itself, disabled-before-interaction) directly
 * in `InlineStyleComposer.tsx` off `codeProps`/`styleValueKey`, in parallel
 * with this track — so the "silent no-op" bug this row exists to fix is
 * already closed. What THIS function adds, not yet consumed anywhere: the
 * PER-SOURCE explanation (R2 for styles — "reads `\`${pct}%\`` from code",
 * not just "locked"), now available as `PageNode.resolvedProps['style:<prop>']`
 * as of this track's parser change. A future pass threading this into
 * `InlineStyleComposer`'s row renderer gets the same richer message
 * `CodeValueControl` shows for props, for free.
 */
export function explainStyleConstraint(node: ConstraintPropSource, property: string): EditConstraint | null {
  if (isStyleWritableToSource(node, property)) return null

  if (node.id !== undefined && !hasWritableSourceLocation(node.id)) {
    return {
      reason: 'no-inline-style-target',
      scope: 'style-property',
      explanation:
        'One piece of source renders every row of this list, so a style change here would apply to all of them. Assign a class instead.',
      actions: [],
    }
  }

  const resolved = node.resolvedProps?.[styleValueKey(property)]
  return {
    reason: 'resolved-style-expression',
    scope: 'style-property',
    explanation: resolved
      ? resolved.note
        ? `Reads \`${resolved.source}\` — ${resolved.note}.`
        : `Reads \`${resolved.source}\` from code.`
      : 'Set in code.',
    actions: [],
  }
}

// ---------------------------------------------------------------------------
// Structural / gesture scope — rows 7-18, plus the drag-preview seam (D2).
// ---------------------------------------------------------------------------

/** Which `EditConstraintAction`s make sense for a given structural reason — one small, honest table. */
function structuralActions(
  reason: StructuralRefusalReason,
  node: SourceStructureNode,
): EditConstraintAction[] {
  switch (reason) {
    case 'list-row': {
      // Row 3/7 — "edit the array it maps over", made actionable: jump to the
      // row's own source position (best-effort — `decodeSourceNodeId` cannot
      // match a `.map`-row id at all, see `bestEffortRowLocation`), which
      // sits inside or immediately beside the `.map()` call the taxonomy
      // names as the real target.
      const rowLocation = bestEffortRowLocation(node.id)
      return rowLocation ? [{ label: 'Open the array in code', kind: 'edit-array', target: rowLocation }] : []
    }
    case 'shared-component':
      // Row 8 — the real escape hatch lives in `InstanceCallSiteView`
      // (Detach/Swap/Duplicate), which this pure module cannot dispatch to
      // (it would need editor-store access). Named here as an action KIND so
      // the caller (which DOES have store access) can wire the `run` handler.
      return [{ label: 'Detach or edit the component definition', kind: 'detach' }]
    case 'multi-select':
      return [{ label: 'Drag them one by one', kind: 'select-container' }]
    case 'insert':
      return [{ label: 'Select the container to insert into', kind: 'select-container' }]
    // Rows 9-16 — `route-chrome`, `code-placed`, `reparent`, `duplicate`,
    // `wrap`, `cross-file`, `no-sibling-anchor` genuinely have no way forward
    // today (per `sourceStructure.ts`'s own doc: "deliberately NOT built
    // rather than approximated"). An empty array here is the honest answer,
    // not a gap.
    default:
      return []
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
  multi?: boolean
}): EditConstraint | null {
  const refusal = refuseStructuralEdit(input)
  if (!refusal) return null
  const decoded = decodeSourceNodeId(input.node.id)
  return {
    reason: refusal.reason,
    scope: 'node',
    explanation: refusal.message,
    ...(decoded ? { origin: { rel: decoded.rel, line: decoded.line, col: decoded.col } } : {}),
    actions: structuralActions(refusal.reason, input.node),
  }
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
  const decoded = decodeSourceNodeId(node.id)
  return {
    reason: preview.refusal.reason,
    scope: 'gesture',
    explanation: preview.refusal.message,
    ...(decoded ? { origin: { rel: decoded.rel, line: decoded.line, col: decoded.col } } : {}),
    actions: structuralActions(preview.refusal.reason, node),
  }
}

// ---------------------------------------------------------------------------
// Absorbed vocabularies — Detach (rows 19-21), className (B2), CSS (B1/B1b).
// Each of these tracks already produces a `{reason, message}`-shaped refusal
// of its own; these wrappers translate that INTO `EditConstraint` without
// re-deciding anything, and without importing the owning module (see the
// `ConstraintReason` doc comment for the cycle reason).
// ---------------------------------------------------------------------------

const DETACH_ACTIONS: ReadonlySet<string> = new Set([
  'uses-hooks',
  'maps-over-props',
  'unsupported-params',
  'no-renderable-jsx',
])

/**
 * Explains a Detach refusal. `reason` is `DetachRefusalReason` by VALUE
 * (`src/core/ast-codemods/detachComponent.ts`) — pass it through as a plain
 * string; TypeScript's structural typing accepts any of that union's members
 * here without a type import. Row 20's real "duplicate as new file" hatch
 * (`extractInstanceCopy`) is offered for exactly the four reasons
 * `EXTRACT_OFFER_REASONS` already gates it on (R5's fix: reachable from BOTH
 * a failed Detach AND — once the caller wires it — an attempted Duplicate on
 * a `studio.instance`, since the reason set is identical either way).
 */
export function explainDetachConstraint(reason: string, message: string): EditConstraint {
  const offersExtract = DETACH_ACTIONS.has(reason)
  return {
    reason: reason as ConstraintReason,
    scope: 'node',
    explanation: message,
    actions: offersExtract ? [{ label: 'Duplicate as a new file and edit that', kind: 'extract' }] : [],
  }
}

/**
 * R5's fix — the SAME explanation `explainDetachConstraint` would give for a
 * Detach failure, offered from an attempted DUPLICATE gesture on a
 * `studio.instance` node instead. `sourceStructure.ts`'s generic `duplicate`
 * refusal ("copy the JSX in the file instead") is accurate but blanket; a
 * `studio.instance` has a real, working duplicate-as-new-component-file
 * escape hatch (`extractInstanceCopy`) that the generic message never
 * mentions. Callers on a canvas/layers-tree Duplicate gesture: check
 * `moduleId === 'studio.instance'` first and call this instead of
 * `explainStructuralConstraint({kind:'duplicate', …})`.
 */
export function explainInstanceDuplicateConstraint(): EditConstraint {
  return {
    reason: 'duplicate',
    scope: 'node',
    explanation:
      'This is a component instance — Studio cannot duplicate the call site itself, but it can duplicate the COMPONENT as a new file you can edit independently.',
    actions: [{ label: 'Duplicate as a new file', kind: 'extract' }],
  }
}

/**
 * Row 22 — a Swap refusal (`swapComponentInstance.ts` — component shape
 * mismatch, etc). No dedicated reason union of its own exists there today
 * (the audit itself notes this: "not read in depth"); `reason`/`message` are
 * whatever that codemod's own refusal carries, passed through unchanged, same
 * pattern as `explainDetachConstraint`. No action beyond "retry with a
 * different candidate" — the swap picker itself IS that retry, so there is
 * nothing further this module can offer.
 */
export function explainSwapConstraint(reason: string, message: string): EditConstraint {
  return {
    reason: (reason || 'swap-refused') as ConstraintReason,
    scope: 'node',
    explanation: message,
    actions: [],
  }
}

/**
 * Explains a `className` edit refusal — B2's `ClassNameRefusalReason`
 * (`src/core/ast-codemods/setJsxClassName.ts`) passed through by value, same
 * pattern as `explainDetachConstraint`.
 */
export function explainClassNameConstraint(reason: string, message: string): EditConstraint {
  return {
    reason: reason as ConstraintReason,
    scope: 'prop',
    explanation: message,
    actions:
      reason === 'css-module-binding'
        ? [{ label: 'Edit the class definition instead', kind: 'select-container' }]
        : [],
  }
}

/**
 * Explains a CSS rule/breakpoint-override save-time refusal — B1/B1b's
 * `classifyStylesheetEditability` vocabulary, passed through by value.
 */
export function explainCssRuleConstraint(reason: string, message: string): EditConstraint {
  return {
    reason: reason as ConstraintReason,
    scope: 'node',
    explanation: message,
    actions:
      reason === 'no-editable-stylesheet' || reason === 'ambiguous-stylesheet' || reason === 'stylesheet-import-shape-mismatch'
        ? [{ label: 'Style the element instead', kind: 'style-inline-instead' }]
        : [],
  }
}

/**
 * Row 23 — `unexplainedSkips`: a save-time prop/text/style edit reached no
 * writable location, known server-side only as an AGGREGATE COUNT
 * (`fsCodemodAdapter.ts`'s `unexplainedSkips`, per `StudioSaveResponseSchema`
 * — `detach`/`swap`/`css` carry a per-node `refusals` entry, but the far more
 * common prop/text/style path does not). Deliberately NOT given a jump-to-
 * source action or a real `origin`: this track cannot manufacture per-node
 * identification the server response does not carry. Extending
 * `StudioSaveResponseSchema` to add `{nodeId, kind, reason}` for this path is
 * a SERVER change (`server/handlers/studioWriteback.ts` — E2.4's territory
 * this wave) — flagged in the handoff, not built here.
 */
export function explainUnexplainedSkip(count: number): EditConstraint {
  return {
    reason: 'unexplained-skip',
    scope: 'node',
    explanation:
      count === 1
        ? '1 edit had no writable location in the code and was not saved.'
        : `${count} edits had no writable location in the code and were not saved.`,
    actions: [],
  }
}
