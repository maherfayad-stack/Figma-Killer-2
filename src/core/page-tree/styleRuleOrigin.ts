/**
 * styleRuleOrigin — the shared vocabulary for telling an IMPORTED `StyleRule`
 * (parsed off a project's own `.css`/compiled output by
 * `server/handlers/studioCss.ts`) apart from an EDITOR-AUTHORED one (created
 * in the CSS Classes panel, a bare `nanoid()` id).
 *
 * Two call sites independently re-derived the same two facts before this
 * module existed: `studioCss.ts`'s `styleRuleId` (the `sc-` prefix every
 * imported rule's id starts with) and `styleRuleWriteback.ts`'s
 * `isEditorAuthoredRuleId` (its inverse, `!ruleId.startsWith('sc-')`). A
 * third fact — `IMPORTED_RULE_TIMESTAMP`, the fixed `createdAt`/`updatedAt`
 * every imported rule gets at parse time — lived only in `studioCss.ts`, with
 * a doc comment that claimed it matched `parseTimestamp`'s fallback. That
 * claim was wrong: `parseTimestamp` (`./parseHelpers.ts`) falls back to
 * `Date.now()` on a missing/invalid value, not `0`. Harmless while nothing
 * read it that way, but worth fixing once this became the one place that
 * says so.
 *
 * `board-27`'s canvas overlay filter (`canvasClassCss.ts`'s
 * `styleRuleNeedsCanvasOverlay`) needs a THIRD consumer of the same two
 * facts, so all three now share this one source instead of a third
 * independent reimplementation.
 */

/**
 * Every imported `StyleRule.id` starts with this — see `studioCss.ts`'s
 * "Stable ids". An editor-authored rule uses a bare `nanoid()` id instead,
 * which never collides with this prefix (nanoid's alphabet excludes `-` as a
 * leading character convention only by chance, not by contract — the actual
 * guarantee is that `studioCss.ts` is the only writer of `sc-`-prefixed ids).
 */
export const IMPORTED_RULE_ID_PREFIX = 'sc-'

/**
 * Imported rules are not user-authored — the `.css` file on disk is the
 * record of change — so a real timestamp would differ on every reload and
 * churn the document for no reason. Every imported rule gets this fixed
 * value for both `createdAt` and `updatedAt` at parse time. An imported
 * rule's `updatedAt` moves off `0` the moment a user edits it in the editor
 * (every edit action on an existing rule bumps `updatedAt` — see
 * `propertyActions.ts`/`conditionActions.ts`/`crudActions.ts`), which is
 * exactly the signal `styleRuleNeedsCanvasOverlay` reads.
 */
export const IMPORTED_RULE_TIMESTAMP = 0

/**
 * True for a `StyleRule.id` `studioCss.ts` minted while parsing a project's
 * own CSS — false for one the user created in the editor (`createClass`/
 * `applyCssRules`, a bare `nanoid()` id).
 */
export function isImportedStyleRuleId(ruleId: string): boolean {
  return ruleId.startsWith(IMPORTED_RULE_ID_PREFIX)
}
