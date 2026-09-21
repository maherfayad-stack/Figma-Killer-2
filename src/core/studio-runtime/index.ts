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
  OptimisticTextMessageSchema,
  OptimisticMessageSchema,
  RuntimeModeSchema,
  ReadyMessageSchema,
  HmrBeforeMessageSchema,
  HmrAfterMessageSchema,
  PointerMessageSchema,
  TextEditMessageSchema,
  MeasureResultMessageSchema,
  FrameResizeMessageSchema,
  ErrorMessageSchema,
  RuntimeErrorKindSchema,
  RUNTIME_ERROR_MESSAGE_MAX,
  RUNTIME_ERROR_STACK_MAX,
  RUNTIME_ERROR_SOURCE_MAX,
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
} from './messages'

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
  resizeElementSize,
  resizeStylePatch,
  type ResizeHandle,
  type ElementSize,
  type ElementSizePatch,
} from './elementResizeRules'

export {
  RESIZE_FRAME_ATTR,
  RESIZE_HANDLE_ATTR,
  RESIZE_PREVIEW_ATTR,
  RESIZE_PREVIEW_STYLE_ID,
  installResizeHandles,
  type ResizeHandlesController,
  type ResizeHandlesOptions,
  type ResizeTargetRef,
} from './resizeHandles'

export { presentedElementOf } from './nodeDom'
