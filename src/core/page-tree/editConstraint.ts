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
 * reasons (`reparent` with no destination, `duplicate`, `wrap`,
 * `no-sibling-anchor`, `multi-select`, `insert`) truly have no way forward
 * beyond the sentence — but it must be a deliberate empty array, not a
 * missing one. `route-chrome`/`code-placed` used to be in this list too;
 * R1 gave both a jump-to-source action, since "go look at the file that
 * decided this" is always true for them.
 *
 * W4-1 retired one of this module's own entries rather than reword it:
 * `explainInstanceDuplicateConstraint` existed because duplicate refused every
 * imported node, so a `studio.instance` was offered "duplicate the COMPONENT as
 * a new file" as the nearest true thing. Duplicating a call site is now an
 * ordinary write (`duplicateJsxElement` copies `<SheetShell/>` and the board
 * re-reads it), so that sentence had become false — and a refusal that is no
 * longer true is worse than no refusal at all.
 */
import { isPropWritableToSource, isStyleWritableToSource, styleValueKey, type SourceWritableNode } from './sourceWritability'
import {
  refusePlacement,
  type StructuralRefusalReason,
} from './sourceStructure'
import { bestEffortRowLocation, hasWritableSourceLocation } from './sourceNodeId'


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
  // DET-1/DET-2 (audit 07 §B.7) — detach fails closed rather than writing
  // code that reads the wrong binding or none at all.
  | 'spread-ambiguous'
  | 'body-local'
  | 'unbound-reference'
  // Row 22 — Swap refusal (component shape mismatch, etc).
  | 'swap-refused'
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
  // K6 — a ⌘-drag asked to place an element by coordinates inside a
  // `position: static` container. Not a source-writability question (the file
  // would take the write); a CSS one. See `explainStaticParentConstraint`.
  | 'static-parent'

/** A way forward out of a refusal — the thing that turns a dead end into progress. */
export interface EditConstraintAction {
  /** Button/link label, e.g. "Duplicate as new file", "Edit the array", "Open in code". */
  label: string
  kind:
    | 'jump-to-source'
    | 'edit-array'
    | 'edit-component'
    | 'detach'
    | 'extract'
    | 'select-container'
    | 'promote-tier1'
    | 'style-inline-instead'
    | 'preview-branch'
    | 'choose-stylesheet'
    /**
     * K6 — write `position: relative` onto the container the refusal names, so
     * a ⌘-drag can place its child by coordinates. The only action kind whose
     * handler is a WRITE rather than a navigation, which is why the engine
     * cannot run it: the handler is supplied by the surface that renders the
     * button (`ConstraintActionButtons`), the same way `jump-to-source`'s
     * `openSource` already is.
     */
    | 'position-parent-relative'
    /**
     * D2 G3 — re-issue the cross-frame drop that just refused as a COPY.
     *
     * Offered only when the same gesture with `copy: true` passes the same
     * gate — `planSourceTransplant` re-asks `previewStructuralTransplant` to
     * find out — so it is never a button that leads straight back to the
     * refusal it was offered for. The second action kind whose handler is a
     * WRITE rather than a navigation, and injected for the same reason
     * `position-parent-relative` is; the difference is that the closure it
     * needs carries a whole DESTINATION (which page, which container, which
     * index), which only the store action that refused still holds — so it
     * travels on `StructuralRefusalDialogState` instead of being rebuilt from
     * a node id.
     */
    | 'duplicate-into-frame'
  /**
   * Where this action points, when it points at a file — `origin`'s own
   * shape, so a caller can wire `jump-to-source` without re-deriving it.
   * Absent for actions that are pure instruction ("Drag them one by one") or
   * that need a caller-supplied callback the engine cannot construct
   * (`detach`/`extract`/`preview-branch` all mutate editor state).
   */
  target?: { rel: string; line: number; col: number }
  /**
   * For `choose-stylesheet` (Z8) — the destination this remedy picks.
   *
   * A separate field from `target` because it is a FILE, not a position: an
   * `ambiguous-stylesheet` refusal knows which stylesheets exist but nothing
   * about where in them a rule would land (that is postcss's answer at write
   * time, server-side), and inventing a `1:1` to fit `target`'s shape would
   * claim a location this module cannot honestly name.
   */
  stylesheet?: { ruleId: string; file: string }
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
  resolvedProps?: Record<string, { source: string; note?: string; origin?: { rel: string; line: number; col: number } }>
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
    // Unlike the mirror-image prop-scope branch above (`explainPropConstraint`'s
    // `resolved-expression`, which can NEVER reach this point with a populated
    // `origin` — `isPropWritableToSource` returns early whenever one exists),
    // `isStyleWritableToSource` hardcodes `false` for every `style:`-prefixed
    // `codeProps` entry WITHOUT consulting `origin` at all (see that
    // predicate's own doc comment for why: one element's `color: ACCENT_COLOR`
    // must not silently repaint every other element reading the same const).
    // So a style property genuinely CAN reach here with a real `origin` — this
    // is the one honest way forward for that case, previously discarded.
    actions: resolved?.origin ? [{ label: 'Open it in code', kind: 'jump-to-source', target: resolved.origin }] : [],
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
  // Audit 07 §B.7: a copy of the component has none of these problems — it
  // is repointed, never inlined, so nothing it reads has to rebind.
  'spread-ambiguous',
  'body-local',
  'unbound-reference',
  'name-collision',
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
 *
 * Z8 — `ambiguous-stylesheet` is the one refusal in this family that is a
 * QUESTION: N hand-editable stylesheets exist, every one of them is a real
 * write target, and Studio refuses to pick. Given the candidate list (and the
 * rule to write), it becomes one runnable remedy per file: the user names the
 * destination and the same write is re-issued against it. Without them the
 * function is unchanged and still offers only the inline hatch — a caller that
 * cannot supply a rule id (the `StyleTargetChip` preview, which is explaining
 * a class nobody has asked to write yet) gets exactly what it got before.
 */
export function explainCssRuleConstraint(
  reason: string,
  message: string,
  destination?: { ruleId: string; candidates: readonly string[] },
): EditConstraint {
  const chooseActions: EditConstraintAction[] =
    reason === 'ambiguous-stylesheet' && destination
      ? destination.candidates.map((file) => ({
          label: `Write it into ${file}`,
          kind: 'choose-stylesheet' as const,
          stylesheet: { ruleId: destination.ruleId, file },
        }))
      : []
  const inlineHatch: EditConstraintAction[] =
    reason === 'no-editable-stylesheet' || reason === 'ambiguous-stylesheet' || reason === 'stylesheet-import-shape-mismatch'
      ? [{ label: 'Style the element instead', kind: 'style-inline-instead' }]
      : []
  return {
    reason: reason as ConstraintReason,
    scope: 'node',
    explanation: message,
    actions: [...chooseActions, ...inlineHatch],
  }
}

