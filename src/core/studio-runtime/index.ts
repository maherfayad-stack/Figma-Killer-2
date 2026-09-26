/**
 * `@core/studio-runtime` — canonical entrypoint. Everything outside this
 * module imports from here; files inside it import each other by relative
 * path (see CLAUDE.md → "Barrel imports").
 *
 * Three halves:
 *   - the in-frame runtime bridge (`runtime.ts`) + its wire contract
 *     (`messages.ts`) + HMR state survival (`hmrState.ts`) — built into one
 *     ESM file served from the live origin (L2), consumed by nothing inside
 *     the admin app itself.
 *   - the five shared "one implementation" rule modules, consumed BOTH by
 *     `runtime.ts` above and by the portal-mode canvas injectors under
 *     `src/admin/pages/site/canvas/` (hover suppression, scroll unroll,
 *     animation freeze, selection-chrome CSS, and — Z5 — the runtime-error
 *     classification predicates in `runtimeErrorRules.ts`).
 *   - the live-frame node-id resolution helpers (`liveNodeResolve.ts`,
 *     `runtimeConfig.ts`) the canvas/adapter layer consumes to map a live
 *     DOM element back to a real tree node id.
 *
 * Deliberately does NOT re-export `vitePlugin.ts` or `idStamp.ts`. Both pull
 * in `@babel/core`, which is fine inside the server-only sync script
 * (`scripts/sync-studio-runtime.ts`) that bundles them into a workspace
 * artifact, but would silently balloon the ADMIN bundle if this barrel ever
 * re-exported them and admin code imported the barrel for something else.
 * `liveNodeResolve.ts` mirrors `idStamp.ts`'s `STUDIO_NODE_ID_ATTR` literal
 * rather than importing it for the identical reason — see that file's header.
 *
 * Gated by `src/__tests__/architecture/babel-not-in-admin-bundle.test.ts`.
 */

export {
  buildStampIndex,
  resolveLiveNode,
  toStampId,
  STUDIO_NODE_ID_ATTR,
} from './liveNodeResolve'
export type { LiveElementLike, LiveNodeMatch, ResolveLiveNodeOptions } from './liveNodeResolve'

export { findNthNodeById, occurrenceIndexOf } from './nodeIdIndexing'
export type { NodeIdOccurrence } from './nodeIdIndexing'

export {
  STUDIO_PARENT_ORIGINS_ENV,
  STUDIO_PROJECT_KEY_ENV,
  StudioRuntimeConfigSchema,
  readStudioRuntimeConfigFromEnv,
} from './runtimeConfig'
export type { StudioRuntimeConfig } from './runtimeConfig'

export {
  createStudioRuntimeBridge,
  type StudioRuntimeBridge,
  type StudioRuntimeBridgeOptions,
} from './runtime'

export {
  RUNTIME_MESSAGE_SOURCE,
  DANGEROUS_OPTIMISTIC_INSERT_TAG_NAMES,
  InboundRuntimeMessageSchema,
  OutboundRuntimeMessageSchema,
  InboundEnvelopeSchema,
  OutboundEnvelopeSchema,
  ApplyOverlayMessageSchema,
  RemoveOverlayMessageSchema,
  SelectMessageSchema,
  HoverMessageSchema,
  MeasureMessageSchema,
  SetAxesMessageSchema,
  SetModeMessageSchema,
  OptimisticInsertMessageSchema,
  OptimisticDeleteMessageSchema,
  OptimisticMoveMessageSchema,
  OptimisticStyleMessageSchema,
  OptimisticStyleClearMessageSchema,
  OptimisticStylePatchSchema,
  OptimisticRevertMessageSchema,
  OPTIMISTIC_REVERT_MAX,
  RESIZE_SNAP_SIBLINGS_MAX,
  ResizeCommitMessageSchema,
  ResizeCommitPatchSchema,
  ResizeGuidesMessageSchema,
  ResizeSizingMarkersSchema,
  ResizeSnapContextSchema,
  SetResizeTargetMessageSchema,
  OptimisticMessageSchema,
  RuntimeModeSchema,
  ReadyMessageSchema,
  HmrBeforeMessageSchema,
  HmrAfterMessageSchema,
  PointerMessageSchema,
  TEXT_EDIT_MAX_LENGTH,
  TextEditReplyMessageSchema,
  TextEditStartMessageSchema,
  TextCommitMessageSchema,
  TextCancelMessageSchema,
  MeasureResultMessageSchema,
  FrameResizeMessageSchema,
  ErrorMessageSchema,
  RuntimeErrorKindSchema,
  RUNTIME_ERROR_MESSAGE_MAX,
  RUNTIME_ERROR_STACK_MAX,
  RUNTIME_ERROR_SOURCE_MAX,
  DropCandidatesMessageSchema,
  DropCandidatesResultMessageSchema,
  DROP_CANDIDATES_MAX,
  DROP_CANDIDATE_CHILD_RECTS_MAX,
  toInboundEnvelope,
  toOutboundEnvelope,
  type InboundRuntimeMessage,
  type OutboundRuntimeMessage,
  type InboundEnvelope,
  type OutboundEnvelope,
  type OptimisticMessage,
  type RuntimeErrorKind,
  type RuntimeMode,
  type NodeRect,
  type NodeMeasurement,
  type TextEditReplyMessage,
  type DropCandidateWire,
  type ResizeCommitPatch,
  type ResizeSizingMarkers,
  type ResizeSnapContext,
} from './messages'

export { installInlineTextEdit, type InlineTextEditController, type InlineTextEditOptions } from './inlineTextEdit'

export {
  RESOURCE_ERROR_TAGS,
  asErrorEventLike,
  boundDiagnosticText,
  describeErrorValue,
  errorStackOf,
  isElementTarget,
  isModuleResolutionMessage,
  requestUrlOf,
  resourceElementUrl,
} from './runtimeErrorRules'

export {
  snapshotFrameState,
  restoreFrameState,
  emptyFrameStateSnapshot,
  wireHmrStateAcrossUpdates,
  type FrameStateSnapshot,
  type ViteHotContext,
} from './hmrState'

export {
  HOVER_DISABLED_CLASS,
  disableHoverInSelector,
  suppressHoverInDocument,
  startHoverSuppression,
  planHoverRewrites,
  type HoverRewrite,
  type HoverSuppressionController,
} from './hoverSuppressionRules'

export {
  SCROLL_UNROLL_ATTR,
  SCROLL_UNROLL_ORIGINAL_OVERFLOW_ATTR,
  SCROLL_UNROLL_MIN_HEIGHT_VAR,
  SCROLL_UNROLL_FLOOR_ATTR,
  SCROLL_UNROLL_AUTHORED_MIN_HEIGHT_VAR,
  MAX_UNROLL_PASSES,
  authoredMinHeightFloor,
  classifyUnrollElement,
  buildScrollUnrollRules,
  runUnrollPasses,
  startScrollUnroll,
  type ScrollUnrollTag,
  type UnrollElementMetrics,
  type ScrollUnrollController,
} from './scrollUnrollRules'

export {
  animationFreezeDeclarations,
  buildAnimationRules,
  MEDIA_SELECTOR,
  freezeMediaElement,
  freezeAllMedia,
  watchMediaInsertions,
  patchReducedMotionMatchMedia,
  applyAnimationFreezeStylesheet,
  removeAnimationFreezeStylesheet,
  startMediaFreeze,
  startAnimationFreeze,
  type AnimationPlayPhase,
  type CanvasAnimationFreezePoint,
  type MediaFreezeController,
  type AnimationFreezeController,
} from './animationFreezeRules'

export {
  SELECTION_STYLE_TAG_ID,
  SELECTION_OVERLAY_ROOT_ID,
  SELECTION_CHROME_TOKENS,
  SELECTION_CHROME_RULES,
  buildSelectionChromeTokenBlock,
  buildSelectionChromeStylesheet,
} from './selectionChromeCss'

export { isSelectionChromeMutation, isSelectionChromeNode } from './selectionChromeMutation'

export {
  FRAME_FIT_TEXT_MUTATION_DEBOUNCE_MS,
  LIVE_FRAME_FIT_STRUCTURAL_DEBOUNCE_MS,
  createFrameFitMutationScheduler,
  type FrameFitMutationScheduler,
  type FrameFitMutationSchedulerOptions,
} from './frameFitMutationScheduler'

export {
  MAX_FRAME_FIT_HEIGHT,
  MAX_FRAME_FIT_PASSES,
  DEFAULT_FRAME_FIT_HEIGHT,
  resolveFrameFitHeight,
  collectScrollDeficits,
  type FrameFitMetrics,
} from './frameFitRules'

export { OVERLAY_ID_ATTR } from './overlayStyleAttr'

export {
  RESIZE_HANDLES,
  MIN_ELEMENT_SIZE,
  isSizeableDisplay,
  resizeAxes,
  resizeElementBox,
  resizeModifiersOf,
  resizeStartStep,
  resizeStylePatch,
  type ResizeHandle,
  type ResizeModifiers,
  type ResizeBoxStart,
  type ResizeOffsets,
  type ResizeStep,
  type InlineOffsetProperty,
  type ElementResizePatch,
} from './elementResizeRules'

export { inlineOffsetProperty, isPositionedFreely, readResizeBoxStart } from './elementResizeMeasure'

export {
  SIZING_OPTIONS,
  currentSizingMode,
  sizingAxisRole,
  sizingPatch,
  sizingUnavailableReason,
  FLEX_MAIN_FIXED_VALUE,
  type SizingAxis,
  type SizingAxisRole,
  type SizingFlexCascade,
  type SizingMode,
  type SizingModeOption,
  type SizingParentLayout,
  type SizingPatch,
} from './elementSizingRules'

export {
  cssPropertyName,
  planResizeSizing,
  readClearedValues,
  readSizingParentLayout,
  resizeInlinePatch,
  stylesheetPreviewDeclarations,
  hugPatchForHandle,
  type ResizeInlinePatch,
  type ResizeSizingPlan,
} from './elementResizeSizing'

export {
  ALL_SNAP_SOURCES,
  SNAP_THRESHOLD_SCREEN_PX,
  computeEdgeSnap,
  computeSnap,
  snapGuidesEqual,
  snapSourcesFor,
  snapThresholdAtZoom,
  type EdgeSnap,
  type SnapGuide,
  type SnapLine,
  type SnapOptions,
  type SnapRect,
  type SnapResult,
  type SnapSourceToggles,
  type SnapSpacing,
} from './snapRules'

export { findSpacingSnap, formatSpacing, snapSpacingsEqual, spacingSegments } from './snapSpacingRules'

export {
  guideLinesInSpace,
  parentSnapRects,
  readBoxInsets,
  type BoxInsets,
  type ScreenSpace,
  type SideLengths,
} from './snapPeerRules'

export {
  flowStartAnchored,
  readResizeSnapInput,
  resizeSnapEdges,
  snapRectOf,
  snapResizeDelta,
  type FlowLayoutInput,
  type RectSource,
  type ResizeSnapEdges,
  type ResizeSnapInput,
  type ResizeSnapStep,
} from './elementResizeSnapRules'

export { PRIMARY_BUTTON_MASK, guardDragSession, type DragSessionGuardOptions } from './dragSessionGuard'

export {
  RESIZE_ACTIVE_ATTR,
  RESIZE_SIZE_BADGE_ATTR,
  writeSizeBadge,
  RESIZE_FRAME_ATTR,
  RESIZE_HANDLE_ATTR,
  RESIZE_PREVIEW_ATTR,
  RESIZE_PREVIEW_STYLE_ID,
  ROTATE_ACTIVE_ATTR,
  ROTATE_CORNERS,
  ROTATE_HANDLE_ATTR,
  installResizeHandles,
  type ResizeHandlesController,
  type ResizeHandlesOptions,
  type ResizeTargetContext,
  type ResizeTargetRef,
} from './resizeHandles'

export { presentedElementOf, rectRelativeToBody } from './nodeDom'

export {
  resolveCanvasAxisFromStyle,
  resolveCanvasInsertionAxis,
  type CanvasDropAxis,
  type CanvasAxisResolution,
  type CanvasAxisStyleInput,
} from './dropAxisRules'

export {
  collectDropCandidates,
  MAX_DROP_CANDIDATES,
  MAX_DROP_CANDIDATE_CHILD_RECTS,
  type DropCandidateGeometry,
} from './dropCandidates'

export { measureNodes, DEFAULT_MEASURED_PROPERTIES } from './measureNodes'
