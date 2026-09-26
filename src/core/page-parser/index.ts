export { parseJsxTree, parsePageFile } from './parsePageFile'
export { getReturnedJsxRoots } from './branchSelection'
export type { ReturnedJsx } from './branchSelection'
export {
  findComponentDeclaration,
  findNamedComponentDeclaration,
  getFunctionLikeNode,
  readPageComponent,
} from './componentDeclaration'
export type { PageComponent } from './componentDeclaration'
export { IMAGE_SPECIFIER_RE, STUDIO_ASSET_SENTINEL, unresolvedRawTextImports } from './assetImports'
export type { ImportSpecifierLocation, UnresolvedAssetImport } from './assetImports'
export type {
  BranchAlternative,
  CssInJsBase,
  CssInJsExtraction,
  CssInJsFinding,
  CssInJsLibrary,
  CssInJsTemplate,
  ComponentBody,
  FunctionLike,
  NodeLoc,
  ParsedNode,
  ParsedPage,
  ParsedPropValue,
  UnreadableExport,
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
  listWorkspaceDirectories,
  listWorkspaceFiles,
} from './workspaceFiles'
export { isWorkspaceSourceFilePath, listWorkspaceSourceFiles } from './workspaceSourceFiles'
export {
  UNWRITABLE_WORKSPACE_DIR_NAMES,
  comparableWorkspaceRel,
  excludedWorkspaceSegment,
  hostExecutedWorkspaceFile,
  isHostConfigFileName,
  isSecretBearingFileName,
  isUnlinkedWorkspacePath,
  resolveWorkspaceReadPath,
  isWorkspaceWritablePath,
  pathEntryExists,
  realWorkspaceRel,
  realpathAllowingMissing,
  stripTrailingDotsAndSpaces,
  studioShellWorkspaceFile,
  unwritableWorkspaceSegment,
} from './workspaceWriteScope'
export { resetParserCaches } from './parserCaches'
export { fileSyntaxError, sourceFileSyntaxError } from './sourceSyntax'
export type { SourceSyntaxError } from './sourceSyntax'
export {
  PROJECT_DESIGN_SYSTEM_DIR,
  designSystemImportSpecifier,
  isDesignSystemPath,
} from './designSystemDir'
export {
  createWorkspaceProject,
  reexportChainFiles,
  resolveComponentSources,
  resolveExportedDeclaration,
} from './componentSources'
export type { ComponentSource, ExportedDeclaration, WorkspaceProjectWarning } from './componentSources'
export { EolPreservingFileSystem, eolFileSystemOf, projectLineEnding } from './eolFileSystem'
export { writeFileAtomic } from './atomicFileWrite'
export { createSourceFileExclusive, withSourceWriteHook, writeSourceFile, type SourceWriteHook } from './sourceWriteHook'
export { LITERAL_FINGERPRINT_LABEL, jsxElementFingerprint, literalFingerprint } from './sourceFingerprint'
export { isLiteralJsxAttribute } from './jsxLiteralAttribute'
export {
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
