/**
 * @core/css-codemods/browser — the part of the CSS codemod tier that needs no
 * postcss, and so may be imported statically by `src/admin/`.
 *
 * The writers (`setDeclaration`, `insertRule`, the keyframes mutators, …) parse
 * and re-serialise a CST with postcss, which the editor bundle must not carry
 * (see `index.ts` and `postcss-not-in-admin-bundle.test.ts`). What the editor
 * needs at load — property-name casing, "is this stylesheet hand-authored?",
 * and reading a `@keyframes` block — is pure text work and lives behind this
 * entry; `index.ts` re-exports it so the server sees one barrel.
 */
export { camelToKebabCssProperty } from './cssPropertyCase'
export { classifyStylesheetEditability, type StylesheetEditability } from './classifyStylesheetEditability'
export {
  keyframesBlockText,
  keyframesNameFromSelector,
  readKeyframeSteps,
  type KeyframeStep,
} from './keyframesText'
