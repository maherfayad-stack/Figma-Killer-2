export { setJsxProp } from './setJsxProp'
export type { SetJsxPropParams } from './setJsxProp'
export { readJsxProps } from './readJsxProps'
export type { JsxLiteralProps, ReadJsxPropsParams } from './readJsxProps'
export { setJsxText, JsxTextTargetError } from './setJsxText'
export type { SetJsxTextParams } from './setJsxText'
export { setJsxStyle, JsxStyleTargetError } from './setJsxStyle'
export type { SetJsxStyleParams } from './setJsxStyle'
export { setJsxClassName } from './setJsxClassName'
export type {
  ClassNameRefusal,
  ClassNameRefusalReason,
  ClassNameToken,
  SetJsxClassNameFailure,
  SetJsxClassNameParams,
  SetJsxClassNameResult,
  SetJsxClassNameSuccess,
} from './setJsxClassName'
export { setStringLiteral, StringLiteralTargetError } from './setStringLiteral'
export type { SetStringLiteralParams } from './setStringLiteral'
export { setStyledDeclaration } from './setStyledDeclaration'
export type {
  SetStyledDeclarationParams,
  SetStyledDeclarationResult,
  StyledDeclarationRefusalReason,
} from './setStyledDeclaration'
export { setImportSpecifier, ImportSpecifierTargetError } from './setImportSpecifier'
export type { SetImportSpecifierParams } from './setImportSpecifier'
export { setJsxTagName, JsxTagNameTargetError } from './setJsxTagName'
export type { SetJsxTagNameParams } from './setJsxTagName'
export { moveJsxElement } from './moveJsxElement'
export type { MoveJsxElementParams, MoveJsxElementResult, MoveJsxRefusal, MoveJsxRefusalReason } from './moveJsxElement'
export { duplicateJsxElement } from './duplicateJsxElement'
export type {
  DuplicateJsxElementParams,
  DuplicateJsxElementResult,
  DuplicateJsxRefusal,
  DuplicateJsxRefusalReason,
} from './duplicateJsxElement'
export { wrapJsxElement } from './wrapJsxElement'
export type { WrapJsxElementParams, WrapJsxElementResult } from './wrapJsxElement'
export { deleteJsxElement } from './deleteJsxElement'
export { createImportPruneSession, isPrunableSourceFile } from './pruneOrphanedImports'
export type { ImportPruneSession } from './pruneOrphanedImports'
export type {
  DeleteJsxElementParams,
  DeleteJsxElementResult,
  DeleteJsxRefusal,
  DeleteJsxRefusalReason,
} from './deleteJsxElement'
export { insertJsxElement } from './insertJsxElement'
export type { InsertJsxElementParams, InsertJsxElementResult } from './insertJsxElement'
export type {
  InsertJsxChildren,
  InsertJsxNode,
  InsertJsxRefusal,
  InsertJsxRefusalReason,
  InsertableJsxPropValue,
} from './jsxSubtree'
export { insertJsxIntoSlotProp } from './insertJsxIntoSlotProp'
export type {
  InsertJsxIntoSlotPropNode,
  InsertJsxIntoSlotPropParams,
  InsertJsxIntoSlotPropResult,
  InsertSlotRefusal,
  InsertSlotRefusalReason,
} from './insertJsxIntoSlotProp'
export { detachComponentInstance } from './detachComponent'
export type {
  DetachComponentParams,
  DetachFailure,
  DetachRefusal,
  DetachRefusalReason,
  DetachResult,
  DetachSuccess,
} from './detachComponent'
export { extractComponentCopy } from './extractComponentCopy'
export type {
  ExtractComponentCopyFailure,
  ExtractComponentCopyParams,
  ExtractComponentCopyRefusal,
  ExtractComponentCopyRefusalReason,
  ExtractComponentCopyResult,
  ExtractComponentCopySuccess,
} from './extractComponentCopy'
export { swapComponentInstance } from './swapComponentInstance'
export type {
  SwapComponentInstanceParams,
  SwapFailure,
  SwapRefusal,
  SwapRefusalReason,
  SwapResult,
  SwapSuccess,
} from './swapComponentInstance'
export { extractSubtreeToComponent } from './extractSubtreeToComponent'
export type {
  ExtractSubtreeRefusal,
  ExtractSubtreeRefusalReason,
  ExtractSubtreeToComponentFailure,
  ExtractSubtreeToComponentParams,
  ExtractSubtreeToComponentResult,
  ExtractSubtreeToComponentSuccess,
  SlotChildDecision,
} from './extractSubtreeToComponent'
export { analyzeFreeVariables } from './subtreeFreeVariables'
export type { FreeVariable, FreeVariableKind } from './subtreeFreeVariables'
export { addReconciledImports, relativeSpecifier, removeImportIfLastUsage, topLevelBindingNames } from './importReconcile'
export { extractStringsToDictionary } from './extractStringsToDictionary'
export type {
  ExtractStringsParams,
  ExtractStringsResult,
  ExtractionRefusal,
  ExtractionRefusalReason,
  StringExtraction,
} from './extractStringsToDictionary'
export { collectSlotChildCandidates, listSlotChildCandidates, suggestSlotNames, SOLE_SLOT_DEFAULT_NAME } from './subtreeSlotChildren'
export type { ListSlotChildCandidatesParams, ResolvedSlotChildCandidate, SlotChildCandidate, SlotChildCandidateKind } from './subtreeSlotChildren'
export { addSlotPropToComponent } from './addSlotPropToComponent'
export type {
  AddSlotPropRefusal,
  AddSlotPropRefusalReason,
  AddSlotPropToComponentFailure,
  AddSlotPropToComponentParams,
  AddSlotPropToComponentResult,
  AddSlotPropToComponentSuccess,
} from './addSlotPropToComponent'
export { findComponentCallSites } from './componentCallSites'
export type { ComponentCallSite } from './componentCallSites'

/**
 * The shared JSX locator every codemod above resolves its target with, also
 * exported for READERS: `server/handlers/studio/nodeJsxSource.ts` ("Copy JSX")
 * has to find the exact same span a write would land on, and a second locator
 * there could drift from this one.
 */
export { createProject, findJsxElementAtLocation, loadSourceFile, resolveJsxWholeElement } from './locateJsxElement'
export type { JsxLocation, JsxOpeningLikeElement } from './locateJsxElement'
