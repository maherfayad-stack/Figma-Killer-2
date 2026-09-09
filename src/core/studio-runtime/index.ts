/**
 * `@core/studio-runtime` — canonical entrypoint. Everything outside this
 * module imports from here; files inside it import each other by relative
 * path (see CLAUDE.md → "Barrel imports").
 *
 * Two halves:
 *   - the in-frame runtime bridge (`runtime.ts`) + its wire contract
 *     (`messages.ts`) + HMR state survival (`hmrState.ts`) — built into one
 *     ESM file served from the live origin (L2), consumed by nothing inside
 *     the admin app itself.
 *   - the four shared "one implementation" rule modules, consumed BOTH by
 *     `runtime.ts` above and by the portal-mode canvas injectors under
 *     `src/admin/pages/site/canvas/`.
 */
export {
  createStudioRuntimeBridge,
  type StudioRuntimeBridge,
  type StudioRuntimeBridgeOptions,
} from './runtime'

export {
  RUNTIME_MESSAGE_SOURCE,
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
  toInboundEnvelope,
  toOutboundEnvelope,
  type InboundRuntimeMessage,
  type OutboundRuntimeMessage,
  type InboundEnvelope,
  type OutboundEnvelope,
  type OptimisticMessage,
  type RuntimeMode,
  type NodeRect,
  type NodeMeasurement,
} from './messages'

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
