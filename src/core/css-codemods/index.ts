/**
 * @core/css-codemods — WS-6.3's plain-CSS write-back tier.
 *
 * Parallel to `@core/ast-codemods` (JSX/TS source edits): a small set of
 * pure, text-in/text-out functions that mutate a CSS file's CST and
 * re-serialize it, preserving everything they didn't touch. See
 * `setDeclaration.ts`'s module doc for the full scope and honest gaps.
 *
 * `panel-02` (WS-6.3) wired these to disk: `server/handlers/studioCssWriteback.ts`
 * is the consumer, reached from a `kind: 'css'` `StudioEdit` through
 * `POST /admin/api/studio/save`. `classifyStylesheetEditability` (is this file
 * hand-authored at all?) runs first; then `setDeclaration`/`removeDeclaration`
 * write the declaration the cascade reads (P3-C, WB-16) — they used to write
 * the first match behind a refusing analyzer, and G-5 deleted it: a style edit
 * lands on a ladder (the declaration, an override, the element) instead of
 * refusing. `style-03` added the removal half:
 * a cleared declaration used to reach no code path at all, so it was silently
 * restored on the next reload. `cssAtRuleScope.ts` (WB-31) names the
 * `@media`/`@container`/`@supports` block a declaration is written inside.
 *
 * ## Two entries: this server barrel and `./browser`
 *
 * Everything above that edits a stylesheet does it through postcss, which the
 * browser must not load (it drags `path`/`fs`/`url`/`source-map-js` shims and a
 * console warning per access). The editor imports `@core/css-codemods/browser`
 * — the pure half this barrel re-exports — and reaches the postcss writers only
 * through a dynamic `import('@core/css-codemods')`. Gate:
 * `postcss-not-in-admin-bundle.test.ts`.
 */
export {
  setDeclaration,
  type DeclarationLanding,
  type DeclarationSetResult,
  type DeclarationWriteOptions,
  type DeclarationWriteRefusal,
  type DeclarationWriteResult,
} from './setDeclaration'
export { removeDeclaration } from './removeDeclaration'
export {
  AT_RULE_SCOPE_PATTERN,
  formatAtRuleScope,
  parseAtRuleScope,
  type AtRuleScope,
  type WritableAtRuleName,
} from './cssAtRuleScope'
export { insertRule, type InsertRuleResult, type InsertRuleOptions } from './insertRule'
export {
  analyzeKeyframesTarget,
  insertKeyframes,
  removeDeclarationAtKeyframe,
  setDeclarationAtKeyframe,
  type KeyframesTargetAnalysis,
  type KeyframesTargetRefusal,
} from './keyframes'
export * from './browser'
export { expandShorthandSide, shorthandCovers } from './shorthandCoverage'
export {
  insertCustomProperty,
  listCustomPropertyDeclarations,
  removeCustomPropertyDeclarations,
  setCustomPropertyValueAtLine,
  type CustomPropertyDeclaration,
  type CustomPropertyEditResult,
  type CustomPropertyInsertResult,
  type CustomPropertyRemoveResult,
  type InsertCustomPropertyOptions,
} from './customProperty'
