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

/**
 * FP-4b (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-4 third bullet,
 * D-EDIT decision in §0/§5) ADDITIVE message: "on pointer-down + drag on a
 * selected element, the bridge reports the parent's layout mode (flex/grid
 * vs not), detected LIVE from the parent's computed style". The studio
 * names a `uid` it already knows (the current selection); the bridge reads
 * that node's REAL DOM `.parentElement` (not necessarily itself a
 * `data-uid` node — a component-instance boundary or a JSX fragment can sit
 * in between, see `parent-layout.ts`'s module doc) and reports its
 * `display`, so the caller can pick the reorder-vs-free-drag branch. New
 * member of the existing `StudioToBridgeMessageSchema` discriminated union
 * — every previously-frozen member is unchanged (verbatim).
 */
export const ReportParentLayoutRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('report-parent-layout'),
    requestId: z.string(),
    uid: z.string(),
  })
  .strict();
export type ReportParentLayoutRequest = z.infer<typeof ReportParentLayoutRequestSchema>;

/**
 * FP-4b — the FREE-DRAG branch's commit-time request: "on drop, commit
 * absolute positioning into source". The studio computes the intended
 * final on-screen position (via its own existing camera/geometry math —
 * unchanged, no new geometry primitive) and converts it to IFRAME-space
 * pixel coordinates (same space `hit-test`/`report-rects` already use)
 * before sending — the bridge then does the CSS-computed-style-dependent
 * part (logical inline-start/RTL resolution, which class strings to
 * add/remove) since only it has `getComputedStyle` access, per `free-
 * drop.ts`'s module doc.
 */
export const ResolveFreeDropRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('resolve-free-drop'),
    requestId: z.string(),
    uid: z.string(),
    /** Intended top-left of the dragged element, in IFRAME CSS-pixel space
     * (same convention as `HitInfo.rect`). */
    targetX: z.number(),
    targetY: z.number(),
  })
  .strict();
export type ResolveFreeDropRequest = z.infer<typeof ResolveFreeDropRequestSchema>;

/**
 * FP-INS-b (`.orchestrator/FEATURE-PARITY-PLAN.md` "Inspect / code tab") —
 * ADDITIVE bridge message, mirroring `report-parent-layout`'s exact pattern
 * (FP-4b): the Inspect tab's "CSS" section needs a node's COMPUTED style,
 * which only the bridge (running INSIDE the file-app iframe) can read via
 * `getComputedStyle` — the studio itself has no DOM access across the
 * cross-origin iframe boundary. New member of the existing
 * `StudioToBridgeMessageSchema` discriminated union — every previously-
 * frozen member is unchanged (verbatim).
 */
export const ReportComputedStyleRequestSchema = z
  .object({
    source: z.literal('ccs-studio'),
    type: z.literal('report-computed-style'),
    requestId: z.string(),
    uid: z.string(),
  })
  .strict();
export type ReportComputedStyleRequest = z.infer<typeof ReportComputedStyleRequestSchema>;

export const StudioToBridgeMessageSchema = z.discriminatedUnion('type', [
  HitTestRequestSchema,
  ReportRectsRequestSchema,
  SubscribeRectsRequestSchema,
  UnsubscribeRectsRequestSchema,
  SetHoverRequestSchema,
  SetSelectionRequestSchema,
  EnterTextEditRequestSchema,
  ReportParentLayoutRequestSchema,
  ResolveFreeDropRequestSchema,
  ReportComputedStyleRequestSchema,
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

/**
 * FP-4b: `report-parent-layout`'s reply. `LayoutModeSchema`'s `'none'`
 * means the parent is neither flex nor grid (`display` is anything else —
 * `block`, `inline`, `grid`... wait: NOT grid — plain block/inline/etc.) —
 * the FREE-DRAG branch. `'flex'`/`'grid'` cover the standard AND
 * `inline-*` variants (an `inline-flex`/`inline-grid` container still lays
 * its children out on flex/grid rules — the REORDER branch). `axis` is only
 * meaningful when `mode !== 'none'` (still always populated for schema
 * simplicity — see `parent-layout.ts`'s doc for how it's derived: computed
 * `flex-direction` for flex, computed `grid-auto-flow` for grid).
 *
 * `ok:false` mirrors `text-edit-rejected`'s pattern (defense-in-depth,
 * same editable-surface contract as `text-edit.ts`): `'not-found'` (unknown
 * uid), `'no-parent'` (the uid'd node has no real DOM parent element at
 * all — practically unreachable but defensive), `'dynamic-locked'` (the
 * DRAGGED node itself is `.map()`-generated — matches this task's hard
 * constraint "a dynamic node must NOT be draggable/committable", enforced
 * bridge-side too, not just by the studio never starting a drag on one).
 */
export const LayoutModeSchema = z.enum(['flex', 'grid', 'none']);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

export const LayoutAxisSchema = z.enum(['row', 'column']);
export type LayoutAxis = z.infer<typeof LayoutAxisSchema>;

export const ParentLayoutInfoSchema = z
  .object({
    mode: LayoutModeSchema,
    axis: LayoutAxisSchema,
    /** The parent element's own `data-uid`, or `null` if the real DOM
     * parent isn't itself an addressable tagged node (component-instance
     * boundary / fragment ancestor — see `parent-layout.ts`'s doc). A
     * `null` parentUid means `move-node` has no valid `newParentUid` to
     * target, so the caller cannot commit a reorder here even if `mode` is
     * `flex`/`grid` — disclosed carry-forward, see worker report. */
    parentUid: z.string().nullable(),
    /** Whether the parent's OWN computed `position` is already non-static
     * (`relative`/`absolute`/`fixed`/`sticky`) — the FREE-DRAG branch uses
     * this to decide whether it also needs to add `relative` to the parent
     * so the dropped element's `absolute` positioning is actually contained
     * within it (else it'd position against a further, unrelated ancestor). */
    parentPositioned: z.boolean(),
    parentRect: RectSchema,
    /** This uid's own index within `siblingUids` (DOM order) — lets the
     * caller compute a "dropped back in its original slot" no-op without a
     * second round trip. */
    index: z.number().int().nonnegative(),
    /** Every DIRECT CHILD of the parent that carries `data-uid`, in real
     * DOM order, INCLUDING this uid itself. Feeds `report-rects` (existing,
     * reused verbatim) so the caller can compute sibling positions for the
     * drop-indicator line / target index without a new rect primitive. */
    siblingUids: z.array(z.string()),
  })
  .strict();
export type ParentLayoutInfo = z.infer<typeof ParentLayoutInfoSchema>;

export const ParentLayoutResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), info: ParentLayoutInfoSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['not-found', 'no-parent', 'dynamic-locked']),
    })
    .strict(),
]);
export type ParentLayoutResult = z.infer<typeof ParentLayoutResultSchema>;

export const ParentLayoutResultReplySchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('parent-layout-result'),
    requestId: z.string(),
    uid: z.string(),
    result: ParentLayoutResultSchema,
  })
  .strict();
export type ParentLayoutResultReply = z.infer<typeof ParentLayoutResultReplySchema>;

/**
 * FP-4b: `resolve-free-drop`'s reply — the bridge-computed positioning
 * classes (RTL-aware, see `free-drop.ts`'s doc) for the studio to write
 * back via the EXISTING `set-classes` `CanvasOp` (never a new op). `ok:false`
 * mirrors `ParentLayoutResult`'s reasons (same editable-surface contract).
 */
export const FreeDropInfoSchema = z
  .object({
    /** Classes to ADD to the dragged node itself (e.g. `['absolute',
     * 'start-[120px]', 'top-[48px]']` — Tailwind logical inset utilities,
     * RTL-correct: `start`/`end` map to `inset-inline-start`/`-end`, which
     * the browser itself flips under `dir="rtl"`, not a manual left/right
     * swap). */
    addClasses: z.array(z.string()),
    /** Classes to REMOVE from the dragged node — any position-managing
     * class this feature itself previously wrote (a prior free-drag drop),
     * so re-dragging doesn't accumulate stale `top-[..]`/`start-[..]`
     * classes. Never touches any OTHER class the node already had. */
    removeClasses: z.array(z.string()),
    /** The parent's own `data-uid`, or `null` if unaddressable (see
     * `ParentLayoutInfo.parentUid`'s doc) — `parentAddClasses` is only
     * ever non-empty when this is non-null. */
    parentUid: z.string().nullable(),
    /** `['relative']` when the parent's computed position was static (so
     * the new `absolute` child is actually contained within it), else `[]`. */
    parentAddClasses: z.array(z.string()),
  })
  .strict();
export type FreeDropInfo = z.infer<typeof FreeDropInfoSchema>;

export const FreeDropResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), info: FreeDropInfoSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(['not-found', 'no-parent', 'dynamic-locked']),
    })
    .strict(),
]);
export type FreeDropResult = z.infer<typeof FreeDropResultSchema>;

export const FreeDropResultReplySchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('free-drop-result'),
    requestId: z.string(),
    uid: z.string(),
    result: FreeDropResultSchema,
  })
  .strict();
export type FreeDropResultReply = z.infer<typeof FreeDropResultReplySchema>;

/**
 * FP-INS-b: `report-computed-style`'s reply payload — a CURATED set of CSS
 * properties (Penpot's own dev-mode inspect view, `inspect/attributes/
 * layout.cljs`/`geometry.cljs`/`text.cljs`, likewise shows a fixed property
 * list per attribute section, never the full ~300-prop `CSSStyleDeclaration`
 * dump). `group` mirrors that same section split so the studio can render
 * Penpot-style grouped attribute rows: `layout` (display/flex/grid),
 * `geometry` (box: size/position/radius/shadow/opacity), `typography`
 * (font/line/letter/text-align), `color` (text/background/border color).
 * Rows are OMITTED when `getComputedStyle` returns an empty string for that
 * property (rare — most browsers always resolve a value) rather than
 * included as a blank row.
 */
export const ComputedStyleGroupSchema = z.enum(['layout', 'geometry', 'typography', 'color']);
export type ComputedStyleGroup = z.infer<typeof ComputedStyleGroupSchema>;

export const ComputedStyleRowSchema = z
  .object({
    group: ComputedStyleGroupSchema,
    /** kebab-case CSS property name, e.g. `"font-size"` — matches what a
     * caller would actually write in a stylesheet/inline style. */
    prop: z.string(),
    value: z.string(),
  })
  .strict();
export type ComputedStyleRow = z.infer<typeof ComputedStyleRowSchema>;

export const ComputedStyleInfoSchema = z
  .object({
    /** Ordered rows, grouped (see `ComputedStyleGroupSchema`'s doc) —
     * document order within each group matches the curated property list's
     * own order, not alphabetical. */
    rows: z.array(ComputedStyleRowSchema),
  })
  .strict();
export type ComputedStyleInfo = z.infer<typeof ComputedStyleInfoSchema>;

/** `ok:false` mirrors `ParentLayoutResult`/`FreeDropResult`'s pattern
 * (defense-in-depth, same editable-surface contract as `parent-layout.ts`):
 * `'not-found'` is the only reason needed here — reading computed style is
 * safe for ANY node (including a `dynamic`-locked one; Penpot's own inspect
 * view shows CSS for any shape, editable or not), so there is no
 * `dynamic-locked` refusal for this READ-ONLY request. */
export const ComputedStyleResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), info: ComputedStyleInfoSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['not-found']) }).strict(),
]);
export type ComputedStyleResult = z.infer<typeof ComputedStyleResultSchema>;

export const ComputedStyleResultReplySchema = z
  .object({
    source: z.literal('ccs-bridge'),
    type: z.literal('computed-style-result'),
    requestId: z.string(),
    uid: z.string(),
    result: ComputedStyleResultSchema,
  })
  .strict();
export type ComputedStyleResultReply = z.infer<typeof ComputedStyleResultReplySchema>;

export const BridgeToStudioMessageSchema = z.discriminatedUnion('type', [
  HitTestResultSchema,
  RectsResultSchema,
  RectsUpdateSchema,
  ReadySchema,
  TextEditEnteredSchema,
  TextEditRejectedSchema,
  TextEditExitSchema,
  ParentLayoutResultReplySchema,
  FreeDropResultReplySchema,
  ComputedStyleResultReplySchema,
]);
export type BridgeToStudioMessage = z.infer<typeof BridgeToStudioMessageSchema>;
