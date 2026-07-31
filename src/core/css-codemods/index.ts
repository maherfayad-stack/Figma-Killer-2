/**
 * @core/css-codemods — WS-6.3's plain-CSS write-back tier.
 *
 * Parallel to `@core/ast-codemods` (JSX/TS source edits): a small set of
 * pure, text-in/text-out functions that mutate a CSS file's CST and
 * re-serialize it, preserving everything they didn't touch. See
 * `setDeclaration.ts`'s module doc for the full scope and honest gaps
 * (this is the write PRIMITIVE — it is not yet wired to any HTTP route, the
 * studio save pipeline, or a `StyleRule.id → file` lookup).
 */
export { setDeclaration, setDeclarationAtMedia, type SetDeclarationResult } from './setDeclaration'
export { classifyStylesheetEditability, type StylesheetEditability } from './classifyStylesheetEditability'
export { camelToKebabCssProperty } from './cssPropertyCase'
