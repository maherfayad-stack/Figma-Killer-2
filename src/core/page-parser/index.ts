export {
  findComponentDeclaration,
  getFunctionLikeNode,
  getReturnedJsxRoots,
  parseJsxTree,
  parsePageFile,
} from './parsePageFile'
export type { ReturnedJsx } from './parsePageFile'
export { IMAGE_SPECIFIER_RE, STUDIO_ASSET_SENTINEL, unresolvedRawTextImports } from './assetImports'
export type { ImportSpecifierLocation, UnresolvedAssetImport } from './assetImports'
export type {
  BranchAlternative,
  CssInJsBase,
  CssInJsExtraction,
  CssInJsFinding,
  CssInJsLibrary,
  CssInJsTemplate,
  FunctionLike,
  NodeLoc,
  ParsedNode,
  ParsedPage,
  ParsedPropValue,
} from './types'
export { cssInJsStylesheet, extractCssInJs, mergeCssInJs } from './cssInJsExtract'
export type { CssInJsFile, StyledBinding } from './cssInJsExtract'
// W4-4 Phase B — the write side reads the SAME flattening the read side does,
// so a value edit lands in the rule the canvas actually showed. See
// `cssInJsTemplate.ts`'s "Two readers of one walk".
export {
  containsUnresolvedSentinel,
  flattenTemplateDeclarations,
  isStatementPosition,
  sentinelDeclaration,
  unresolvedSentinel,
} from './cssInJsTemplate'
export type { TemplateDeclarationSpan, TemplateSentinel } from './cssInJsTemplate'
export {
  EXCLUDED_WORKSPACE_DIR_NAMES,
  PROTOTYPE_SHELL_DIR,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILES,
  isPrototypeShellPath,
  listWorkspaceFiles,
} from './workspaceFiles'
export { createWorkspaceProject, resolveComponentSources, resolveExportedDeclaration } from './componentSources'
export type { ComponentSource } from './componentSources'
export {
  findNamedComponentDeclaration,
  inlineLocalComponents,
  resolveCallTarget,
  INLINE_ID_SEPARATOR,
} from './inlineLocalComponents'
export type { CallTarget, InlineOptions } from './inlineLocalComponents'
export { applyAsyncServerComponentFinding, composeAppRouterRoute } from './nextAppLayout'
export type { ComposeAppRouterRouteOptions, ComposeAppRouterRouteResult } from './nextAppLayout'
export { createEvalScope, createPageEvalBudget, evaluateExpression } from './staticEval'
export type { EvalScope, PageEvalBudget, StaticEvalOptions, StaticValue, ValueOrigin } from './staticEval'
export { CLASS_NAME_JOIN_BUILTIN_NAMES } from './staticEvalCalls'
export { CANONICAL_JSX_RULES, canonicalRuleDef, checkCanonicalJsx, summarizeCanonicalFindings } from './canonicalCheck'
export type {
  CanonicalCheckInput,
  CanonicalFinding,
  CanonicalRuleDef,
  CanonicalRuleId,
  CanonicalSummary,
  CanonicalTier,
} from './canonicalCheck'
