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
 * the first match behind `analyzeDeclarationTarget`'s refusals, which now
 * guards only a styled-component template. `style-03` added the removal half:
 * a cleared declaration used to reach no code path at all, so it was silently
 * restored on the next reload. `cssAtRuleScope.ts` (WB-31) names the
 * `@media`/`@container`/`@supports` block a declaration is written inside.
 */
export {
  setDeclaration,
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
  keyframesNameFromSelector,
  readKeyframeSteps,
  removeDeclarationAtKeyframe,
  setDeclarationAtKeyframe,
  type KeyframeStep,
  type KeyframesTargetAnalysis,
  type KeyframesTargetRefusal,
} from './keyframes'
export {
  analyzeDeclarationTarget,
  type DeclarationTargetAnalysis,
  type DeclarationTargetRefusal,
} from './analyzeDeclarationTarget'
export { classifyStylesheetEditability, type StylesheetEditability } from './classifyStylesheetEditability'
export {
  listCustomPropertyDeclarations,
  setCustomPropertyValueAtLine,
  type CustomPropertyDeclaration,
  type CustomPropertyEditResult,
} from './customProperty'
export { camelToKebabCssProperty } from './cssPropertyCase'
