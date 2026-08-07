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
 * `POST /admin/api/studio/save`. Three checks compose, in this order, before
 * a single byte is written — `classifyStylesheetEditability` (is this file
 * hand-authored at all?), `analyzeDeclarationTarget` (would the write land on
 * exactly one honest target?), then `setDeclaration` (do it).
 */
export { setDeclaration, setDeclarationAtMedia, type SetDeclarationResult } from './setDeclaration'
export { insertRule, type InsertRuleResult, type InsertRuleOptions } from './insertRule'
export {
  analyzeDeclarationTarget,
  type DeclarationTargetAnalysis,
  type DeclarationTargetRefusal,
} from './analyzeDeclarationTarget'
export { classifyStylesheetEditability, type StylesheetEditability } from './classifyStylesheetEditability'
export { camelToKebabCssProperty } from './cssPropertyCase'
