import { z } from 'zod';

/**
 * Bridge <-> Studio postMessage protocol — FROZEN by
 * `.orchestrator/DECISIONS.md` ADR-0016 ("P2 kickoff... Bridge <-> Studio
 * postMessage protocol"). This is a SEPARATE contract from
 * `packages/protocol` (which covers daemon<->studio only) — ADR-0016
 * deliberately scopes it to the iframe boundary, not the frozen
 * `NodeUid`/`CanvasOp`/`DaemonEvent` union. Defined here (not in
 * `packages/protocol`) because this package IS its owner per the playbook
 * §6 topology table ("ast" owns `vite-plugin-source-uid` + `bridge` for
 * P2) and per this worker's task scope (packages/protocol is frozen/other
 * team's to extend).
 *
 * Every message carries a `source` tag so each side can reject anything
 * that isn't from its counterpart even if it slipped through the
 * `event.source`/`window.parent` identity check (§5.8 origin validation —
 * see `bridge.ts` for the actual origin check, which validates BOTH the
 * real `MessageEvent.source` window identity AND this payload tag).
 */

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

export const BreadcrumbEntrySchema = z.object({
  uid: z.string(),
  name: z.string(),
});
export type BreadcrumbEntry = z.infer<typeof BreadcrumbEntrySchema>;

export const HitInfoSchema = z.object({
  uid: z.string(),
  rect: RectSchema,
  dynamic: z.boolean(),
  component: z.string().nullable(),
  /** Ordered OUTERMOST -> INNERMOST, ending with the hit node itself (same
   * `uid` as the top-level `uid` field). Documented order per ADR-0016
   * ("breadcrumb:[...ancestor uids+names]"), which left the exact order to
   * the worker. */
  breadcrumb: z.array(BreadcrumbEntrySchema),
});
export type HitInfo = z.infer<typeof HitInfoSchema>;

// --- studio -> bridge -----------------------------------------------------

export const HitTestRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('hit-test'),
    requestId: z.string(),
    x: z.number(),
    y: z.number(),
  })
  .strict();
export type HitTestRequest = z.infer<typeof HitTestRequestSchema>;

export const ReportRectsRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('report-rects'),
    requestId: z.string(),
    uids: z.array(z.string()),
  })
  .strict();
export type ReportRectsRequest = z.infer<typeof ReportRectsRequestSchema>;

export const SubscribeRectsRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('subscribe-rects'),
    uids: z.array(z.string()),
  })
  .strict();
export type SubscribeRectsRequest = z.infer<typeof SubscribeRectsRequestSchema>;

export const UnsubscribeRectsRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('unsubscribe-rects'),
  })
  .strict();
export type UnsubscribeRectsRequest = z.infer<typeof UnsubscribeRectsRequestSchema>;

export const SetHoverRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('set-hover'),
    uid: z.string().nullable(),
  })
  .strict();
export type SetHoverRequest = z.infer<typeof SetHoverRequestSchema>;

export const SetSelectionRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('set-selection'),
    uids: z.array(z.string()),
  })
  .strict();
export type SetSelectionRequest = z.infer<typeof SetSelectionRequestSchema>;

/**
 * FP-4a (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4, first two bullets)
 * ADDITIVE message: "double-click a text element -> the bridge turns that
 * node contentEditable in the iframe". The studio never touches the
 * iframe's DOM directly (cross-origin) — it only names the target `uid`
 * (already known from a prior `hit-test`/`set-selection`) and the bridge
 * decides locally whether that node is actually a safe contentEditable
 * target (non-`dynamic`, a text-bearing leaf, not a component-instance
 * usage site — see `@ccs/bridge`'s `text-edit.ts`), replying with either
 * `text-edit-entered` or `text-edit-rejected`. This is a NEW message kind
 * added to the existing `StudioToBridgeMessageSchema` discriminated union —
 * every previously-frozen member (`hit-test`, `report-rects`, etc.) is
 * unchanged (verbatim), per ADR-0016's additive-only amendment for P3+.
 */
export const EnterTextEditRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('enter-text-edit'),
    requestId: z.string(),
    uid: z.string(),
  })
  .strict();
export type EnterTextEditRequest = z.infer<typeof EnterTextEditRequestSchema>;

export const StudioToBridgeMessageSchema = z.discriminatedUnion('type', [
  HitTestRequestSchema,
  ReportRectsRequestSchema,
  SubscribeRectsRequestSchema,
  UnsubscribeRectsRequestSchema,
  SetHoverRequestSchema,
  SetSelectionRequestSchema,
  EnterTextEditRequestSchema,
]);
export type StudioToBridgeMessage = z.infer<typeof StudioToBridgeMessageSchema>;

// --- bridge -> studio -------------------------------------------------------

export const HitTestResultSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('hit-test-result'),
    requestId: z.string(),
    hit: HitInfoSchema.nullable(),
  })
  .strict();
export type HitTestResult = z.infer<typeof HitTestResultSchema>;

export const RectsResultSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('rects-result'),
    requestId: z.string(),
    rects: z.record(z.string(), RectSchema.nullable()),
  })
  .strict();
export type RectsResult = z.infer<typeof RectsResultSchema>;

export const RectsUpdateSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('rects-update'),
    rects: z.record(z.string(), RectSchema.nullable()),
  })
  .strict();
export type RectsUpdate = z.infer<typeof RectsUpdateSchema>;

export const ReadySchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('ready'),
    frame: z.string(),
  })
  .strict();
export type Ready = z.infer<typeof ReadySchema>;

/**
 * FP-4a — bridge's reply to a successful `enter-text-edit`: the node is now
 * `contentEditable` and focused inside the iframe; `text` is its original
 * text content at the moment editing began (the studio doesn't need it for
 * correctness — the bridge itself restores on Esc-cancel — but it's useful
 * for callers that want to show/log the pre-edit value).
 */
export const TextEditEnteredSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('text-edit-entered'),
    requestId: z.string(),
    uid: z.string(),
    text: z.string(),
  })
  .strict();
export type TextEditEntered = z.infer<typeof TextEditEnteredSchema>;

/** FP-4a — bridge's reply when `uid` isn't a safe contentEditable target
 * (dynamic-locked, a component-instance usage site, not a text leaf, a
 * void element, unknown uid, or an edit already in progress). */
export const TextEditRejectedSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('text-edit-rejected'),
    requestId: z.string(),
    uid: z.string(),
    reason: z.string(),
  })
  .strict();
export type TextEditRejected = z.infer<typeof TextEditRejectedSchema>;

/**
 * FP-4a — an UNSOLICITED event (no `requestId`; not a reply to any one
 * studio request) the bridge sends the instant an in-progress text edit
 * ends, however it ended: Enter or blur (`committed: true`, `text` = the
 * final content to write back via the existing `set-text` `CanvasOp`) or
 * Esc (`committed: false`, `text: null` — the bridge already restored the
 * original content in the iframe's DOM itself; the studio must NOT emit any
 * op). The studio uses this to know when it's safe to resume normal
 * hit-test capture over that frame (see `edit-mode-layer.tsx`).
 */
export const TextEditExitSchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('text-edit-exit'),
    uid: z.string(),
    committed: z.boolean(),
    text: z.string().nullable(),
  })
  .strict();
export type TextEditExit = z.infer<typeof TextEditExitSchema>;

export const BridgeToStudioMessageSchema = z.discriminatedUnion('type', [
  HitTestResultSchema,
  RectsResultSchema,
  RectsUpdateSchema,
  ReadySchema,
  TextEditEnteredSchema,
  TextEditRejectedSchema,
  TextEditExitSchema,
]);
export type BridgeToStudioMessage = z.infer<typeof BridgeToStudioMessageSchema>;
