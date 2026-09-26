export { setJsxProp, JsxPropTargetError } from './setJsxProp'
export type { SetJsxPropParams } from './setJsxProp'
export { readJsxProps } from './readJsxProps'
export type { JsxLiteralProps, ReadJsxPropsParams } from './readJsxProps'
export { setJsxText, JsxTextTargetError } from './setJsxText'
export type { SetJsxTextParams } from './setJsxText'
export { setJsxStyle, JsxStyleTargetError } from './setJsxStyle'
export type { SetJsxStyleParams } from './setJsxStyle'
export { setJsxClassName } from './setJsxClassName'
export { createModuleImportPlan } from './cssModuleImportPlan'
export type { ModuleImportPlan, PendingModuleImports } from './cssModuleImportPlan'
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
export { rewriteImportSpecifier } from './rewriteImportSpecifier'
export type { RewriteImportSpecifierParams, RewriteImportSpecifierResult } from './rewriteImportSpecifier'
export { setSvgPartAttributes } from './setSvgPartAttributes'
export type {
  SetSvgPartAttributesParams,
  SetSvgPartAttributesResult,
  SvgPartAttributesRefusalReason,
} from './setSvgPartAttributes'
export { setJsxTagName, JsxTagNameTargetError } from './setJsxTagName'
export type { SetJsxTagNameParams } from './setJsxTagName'
export { moveJsxElement } from './moveJsxElement'
export type { MoveJsxElementParams, MoveJsxElementResult, MoveJsxRefusal, MoveJsxRefusalReason } from './moveJsxElement'
// D2 G3 — the cross-FILE move `moveJsxElement` deliberately refuses.
export {
  transplantJsxElement,
  // P5-G — the free canvas's two endpoints: a loose layer placed into a frame,
  // and an element lifted out of one onto the board.
  placeCanvasLayerRoot,
  liftJsxElementToCanvasModule,
  canvasLayerModuleRoot,
} from './transplantJsxElement'
export { buildCanvasLayerModule, canvasLayerModuleFromSpec, type CanvasLayerModule } from './canvasLayerModule'
export type {
  LiftJsxElementParams,
  LiftJsxElementResult,
  PlaceCanvasLayerRootParams,
  TransplantJsxElementParams,
  TransplantJsxElementResult,
  TransplantJsxRefusal,
  TransplantJsxRefusalReason,
} from './transplantJsxElement'
export { duplicateJsxElement } from './duplicateJsxElement'
export type {
  DuplicateJsxElementParams,
  DuplicateJsxElementResult,
  DuplicateJsxRefusal,
  DuplicateJsxRefusalReason,
} from './duplicateJsxElement'
export { wrapJsxElement } from './wrapJsxElement'
export type {
  WrapJsxElementParams,
  WrapJsxElementResult,
  WrapJsxRefusal,
  WrapJsxRefusalReason,
} from './wrapJsxElement'
export { wrapJsxElements } from './wrapJsxElements'
export type {
  WrapJsxElementsParams,
  WrapJsxElementsRefusal,
  WrapJsxElementsRefusalReason,
  WrapJsxElementsResult,
} from './wrapJsxElements'
export { unwrapJsxElement } from './unwrapJsxElement'
export type {
  UnwrapJsxElementParams,
  UnwrapJsxElementResult,
  UnwrapJsxRefusal,
  UnwrapJsxRefusalReason,
} from './unwrapJsxElement'
export { deleteJsxElement } from './deleteJsxElement'
export { createImportPruneSession, isPrunableSourceFile } from './pruneOrphanedImports'
export type { ImportPruneSession, PrunedImportsResult } from './pruneOrphanedImports'
export type {
  DeleteJsxElementParams,
  DeleteJsxElementResult,
  DeleteJsxRefusal,
  DeleteJsxRefusalReason,
} from './deleteJsxElement'
export { editListItems } from './editListItems'
export type { EditListItemsParams, EditListItemsResult, ListItemRefusal, ListItemRefusalReason } from './editListItems'
export type { CreatedJsxLocation } from './createdJsxLocation'
export { insertJsxElement } from './insertJsxElement'
export type { InsertJsxElementParams, InsertJsxElementResult } from './insertJsxElement'
export type {
  InsertJsxChildren,
  InsertJsxNode,
  InsertJsxRefusal,
  InsertJsxRefusalReason,
  InsertableJsxPropValue,
} from './jsxSubtree'
export { isAssetImportRef, assetImportBindingName, type AssetImportRef } from './jsxAssetImports'
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
// P5-C (DET-7) — "Expose as prop": a literal in a component becomes an optional prop whose default is that literal.
export { exposeLiteralAsProp } from './exposeLiteralAsProp'
export type { ExposeLiteralAsPropParams, ExposeLiteralAsPropResult, ExposeLiteralRefusalReason, ExposeTarget } from './exposeLiteralAsProp'
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
export {
  createProject,
  findJsxElementAtLocation,
  JsxElementNotFoundError,
  loadSourceFile,
  resolveJsxWholeElement,
  syncProjectWithDisk,
} from './locateJsxElement'
export type { JsxLocation, JsxOpeningLikeElement } from './locateJsxElement'
export { readSourceFingerprintAt } from './sourceFingerprintAt'
/**
 * The unit a structural codemod acts on at a `line:col` — exported for the
 * server's edit SEQUENCE (`studioEditSequence.ts`, P3-D), which has to know
 * exactly which elements a step moved, removed or created to follow every
 * other element it names through that step.
 */
export { resolveJsxChildRange } from './jsxChildRange'
export type { JsxChildRange, JsxChildUnit } from './jsxChildRange'
