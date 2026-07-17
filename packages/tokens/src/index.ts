/**
 * @ccs/tokens — Design-token parse/validate/emit + the component catalog
 * (playbook §4/P4, ADR-0006/0010/0021/0022). PRIMARY format: the Almosafer
 * DS's `design-system/src/tokens/tokens.js` JS-export shape (ADR-0010);
 * DTCG (`dtcg.ts`) is a layered-on interop format, not the storage model.
 *
 * ============================================================================
 * FROZEN engine API (ADR-0022) — P5 codes to this; changing a signature
 * here is a CHANGE-REQUEST, not a silent edit:
 *   - `TokenModel` (type) + a loader (`parseAlmosaferTokensJs`)
 *   - `emitCss(model, theme)`
 *   - `emitTailwindPreset(model)`
 *   - `listComponents(): {name,category,description}[]`
 *   - `getPropSchema(name): {props: Record<string,PropSchema>}`
 *   - `tokensForProperty(cssProp): {token,value}[]`
 * ============================================================================
 */

export type { ThemeName, TokenType, TokenGroup, Token, TokenModel } from './types.js';
export { THEME_NAMES, findToken, tokensByGroup } from './types.js';

export { kebabCase } from './kebab.js';
export { cssVarForFlatToken, cssVarForTypographyField } from './css-var.js';

export { parseAlmosaferTokensJs } from './parse-almosafer.js';
export { emitCss } from './emit-css.js';
export { emitTailwindPreset, serializePresetModule, type TailwindPreset } from './emit-tailwind-preset.js';
export { buildTokenOutputs, type TokenOutputs } from './build-outputs.js';

export {
  tokenModelToDtcg,
  dtcgToTokenModel,
  type DtcgDocument,
  type DtcgTree,
  type DtcgTokenNode,
} from './dtcg.js';

export {
  setTokenValue,
  createToken,
  deleteToken,
  resolveExportName,
  TokenEditError,
  type TokenEditTarget,
  type FlatExportName,
} from './edit-almosafer-tokens.js';

export {
  PropTypeSchema,
  ControlKindSchema,
  PropSchemaSchema,
  ComponentMetaSchema,
  type PropType,
  type ControlKind,
  type PropSchema,
  type ComponentMeta,
} from './component-meta.js';
export { parseComponentMeta } from './parse-component-meta.js';
export { extractDestructuredProps, extractDestructuredPropDefaults, type DestructuredPropDefault } from './jsx-props.js';
export { generateComponentMeta, serializeComponentMeta, type GenerateMetaInput, type GenerateMetaResult } from './generate-meta.js';

export {
  listComponents,
  getPropSchema,
  tokensForProperty,
  configureComponentCatalog,
  configureTokenSource,
  resetCatalogCache,
  type TokenRef,
} from './catalog.js';

export { evaluateExpressionToJson, type JsonValue } from './parse-literal.js';
