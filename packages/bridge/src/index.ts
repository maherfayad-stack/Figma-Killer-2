/**
 * @ccs/bridge — script injected into file-app iframes in studio dev mode
 * (playbook §4/P2, ADR-0016). Communicates with the studio via
 * `window.postMessage`: hit-test, rect reporting/streaming, hover/selection
 * highlight. See `protocol.ts` for the full frozen message contract.
 *
 * Injection is the daemon/canvas's responsibility (this package only
 * exports the runtime + a `<script>`-safe IIFE string is NOT built here —
 * `installBridge()` is meant to be imported by whatever bundles the
 * injected script, e.g. via the daemon's studio-mode Vite config
 * `transformIndexHtml` hook per ADR-0016's addendum).
 */
export { installBridge, type InstallBridgeOptions, type BridgeHandle } from './bridge.js';

export { performHitTest, buildBreadcrumb } from './hit-test.js';
export { reportRects } from './rects.js';
export {
  createRectsSubscription,
  type RectsSubscription,
  type RectsSubscriptionOptions,
} from './subscribe.js';
export { setHover, setSelection } from './highlight.js';
export {
  findByUid,
  nearestUidAncestor,
  rectToPlain,
  DATA_UID_ATTR,
  DATA_DYNAMIC_ATTR,
  DATA_COMPONENT_ATTR,
} from './dom.js';

export {
  StudioToBridgeMessageSchema,
  BridgeToStudioMessageSchema,
  RectSchema,
  HitInfoSchema,
  BreadcrumbEntrySchema,
  type Rect,
  type BreadcrumbEntry,
  type HitInfo,
  type StudioToBridgeMessage,
  type BridgeToStudioMessage,
  type HitTestRequest,
  type ReportRectsRequest,
  type SubscribeRectsRequest,
  type UnsubscribeRectsRequest,
  type SetHoverRequest,
  type SetSelectionRequest,
  type HitTestResult,
  type RectsResult,
  type RectsUpdate,
  type Ready,
} from './protocol.js';
