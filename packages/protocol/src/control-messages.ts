import { z } from 'zod';
import { FrameMetaSchema } from './frame-meta.js';

/**
 * ADR-0014 — additive control-ws request/reply shapes closing the two P1
 * interface gaps (daemon has no `create-frame`/`get-canvas-json` API yet).
 * Extended by ADR-0015 with `duplicate-frame`/`duplicate-frame-result`
 * (the P1 defect fix: real file-backed frame duplication). Additive only:
 * does NOT touch the frozen `CanvasOp`/`DaemonEvent`/`FrameMeta`/
 * `TreeNode`/`NodeUid` types (ADR-0012/0013).
 *
 * These are control-channel request/reply envelopes, deliberately NOT
 * `DaemonEvent` variants (same rationale as `ProjectInfo` in
 * project-info.ts: `DaemonEvent`s are broadcast state-change notifications,
 * not per-request replies) and NOT part of the existing `ClientMessage`
 * union frozen by ADR-0013 prose — ADR-0012 explicitly leaves room for the
 * control channel to grow "control requests" beyond `canvas-op`/
 * `set-geometry`.
 *
 * Wire discipline, mirroring how a client already tells a bare `DaemonEvent`
 * (always has `t`) apart from the bare `ProjectInfo` bootstrap (has neither
 * `t` nor `kind`): every message defined here carries a `kind` discriminant
 * and no `t` field, so a client can distinguish, in order:
 *   1. has `t` → `DaemonEvent`
 *   2. has `kind` → one of the request/reply shapes below
 *   3. neither → the `ProjectInfo` bootstrap
 *
 * Replies are sent directly to the requesting socket only — never
 * broadcast (unlike `DaemonEvent`s, which every connected client receives).
 * A successful `create-frame` is instead observable via the existing
 * broadcast `{t:'file-changed', file}` events on the new frame's source
 * path and the file-folder's `.studio/canvas.json` (task brief) — no
 * dedicated success reply is defined for it, only the error path, so
 * callers must correlate success via the file-changed path they already
 * know from their own request.
 */

// --- client -> server ---------------------------------------------------

export const CreateFrameRequestSchema = z
  .object({
    kind: z.literal('create-frame'),
    /** Correlates a `control-error` reply back to this request — decision
     * taken alone (not in the task's literal message sketch) so callers
     * don't have to infer failure from silence/timeout alone. */
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const GetCanvasJsonRequestSchema = z
  .object({
    kind: z.literal('get-canvas-json'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
  })
  .strict();

/**
 * ADR-0015 — duplicate-frame request. `newName` is an OPTIONAL caller hint
 * (not currently sent by `packages/canvas`'s default duplicate handler,
 * which always lets the daemon pick a unique `<sourceName>Copy`/`Copy2`/…
 * name — see `duplicate-frame.ts`'s module doc); accepted here so a future
 * "rename while duplicating" UI doesn't need a protocol change. When
 * omitted, the daemon derives a unique name itself.
 */
export const DuplicateFrameRequestSchema = z
  .object({
    kind: z.literal('duplicate-frame'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    sourceName: z.string().min(1),
    newName: z.string().min(1).optional(),
  })
  .strict();

/**
 * P4 (playbook §4/P4, ADR-0022) — additive token-CRUD control-ws requests.
 * The daemon is the SOLE fs-writer (One Rule) — a studio TokensPanel (P5)
 * never writes `design-system/src/tokens/tokens.js` directly, it sends one
 * of these three requests and the daemon applies the edit via
 * `@ccs/tokens`'s pure, format-preserving `setTokenValue`/`createToken`/
 * `deleteToken` (ADR-0010: the Almosafer JS-export shape, not DTCG, is the
 * on-disk source of truth). `group`/`theme` are the STUDIO-facing concept
 * (which token, which theme) — the daemon translates that to the concrete
 * tokens.js `export const` name (`colors`/`colorsDark`/`spacing`/
 * `rounded`/`elevation`) via `@ccs/tokens`'s `resolveExportName`, keeping
 * this wire shape independent of that implementation detail. `typography`
 * is deliberately NOT in `TokenGroupSchema` — nested `scale.field` CRUD is
 * out of v1 scope (see `@ccs/tokens/edit-almosafer-tokens.ts` module doc);
 * widening this enum later is additive, not breaking.
 *
 * A successful write triggers the SAME rebuild pipeline as an external
 * `tokens.js` edit (daemon `design-system/**` watch) — re-emitting the
 * FROZEN `tokens-changed` DaemonEvent (`packages/protocol/src/events.ts`)
 * once the CSS/preset outputs are rebuilt and written to every file-folder.
 * No new DaemonEvent variant needed; `TokenWriteResultSchema` below is the
 * direct (non-broadcast) success/failure reply to the ONE requesting
 * socket, same pattern as `GetCanvasJsonResultSchema` etc.
 */

export const TokenGroupSchema = z.enum(['color', 'spacing', 'rounded', 'elevation']);
export type TokenGroup = z.infer<typeof TokenGroupSchema>;

export const TokenThemeSchema = z.enum(['light', 'dark']);
export type TokenTheme = z.infer<typeof TokenThemeSchema>;

/**
 * CR (AUDIT-7 close-out, back-to-worker on the CSS-injection blocker) —
 * NARROWING-only tightening of the wire schema itself, additive to the
 * P4 `.strict()` shapes below (no field added/removed/renamed). This is
 * intentionally a SUPERSET-COMPATIBLE early filter, not the authoritative
 * gate: the daemon-boundary check in `packages/sync-daemon/src/
 * token-crud.ts` (`validateTokenKey`/`validateTokenValue`) is what actually
 * decides whether a token-CRUD request is safe to apply, including the
 * per-group value shape (color vs dimension vs free-text) that a bare zod
 * union can't express without duplicating that group-conditional logic
 * here too (drift risk explicitly called out in the fix brief). What IS
 * cheap and safe to assert at the wire boundary: the key can only be a
 * CSS-custom-property-safe identifier segment, and a string value can't
 * contain a declaration/rule-terminating sequence. Same class of defect as
 * ADR-0020 (wire string -> sensitive sink, unsanitized) — see emit-css.ts
 * and css-var.ts for the matching sink-side defense-in-depth.
 */
const TOKEN_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CSS_BREAKING_VALUE_PATTERN = /[;{}]|\/\*|\*\/|[\r\n]/;

const TokenKeySchema = z
  .string()
  .regex(TOKEN_KEY_PATTERN, 'token key must be 1-64 chars of letters, digits, "_", or "-"');

const TokenValueSchema = z.union([
  z.number(),
  z
    .string()
    .min(1)
    .refine((v) => !CSS_BREAKING_VALUE_PATTERN.test(v), {
      message: 'token value must not contain ";", "{", "}", "/*", "*/", or a newline',
    }),
]);

export const SetTokenRequestSchema = z
  .object({
    kind: z.literal('set-token'),
    requestId: z.string().min(1),
    group: TokenGroupSchema,
    theme: TokenThemeSchema,
    key: TokenKeySchema,
    value: TokenValueSchema,
  })
  .strict();

export const CreateTokenRequestSchema = z
  .object({
    kind: z.literal('create-token'),
    requestId: z.string().min(1),
    group: TokenGroupSchema,
    theme: TokenThemeSchema,
    key: TokenKeySchema,
    value: TokenValueSchema,
  })
  .strict();

export const DeleteTokenRequestSchema = z
  .object({
    kind: z.literal('delete-token'),
    requestId: z.string().min(1),
    group: TokenGroupSchema,
    theme: TokenThemeSchema,
    key: TokenKeySchema,
  })
  .strict();

export type SetTokenRequest = z.infer<typeof SetTokenRequestSchema>;
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;
export type DeleteTokenRequest = z.infer<typeof DeleteTokenRequestSchema>;

/**
 * ADR-0018/P3 (WS-B) — undo/redo control-ws requests. The daemon owns a
 * per-file-folder undo/redo stack (ADR-0018 item 9: undo/redo lives in the
 * DAEMON, not ast-engine); these are how a client asks it to pop one step.
 * `fileFolder`-scoped (not per-file) because that's the natural unit a
 * studio UI thinks in ("undo my last change in this project"), and because
 * a single canvas op's inverse may need to be replayed against whichever
 * file it targeted without the caller having to track that itself.
 */
export const UndoRequestSchema = z
  .object({
    kind: z.literal('undo'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
  })
  .strict();

export const RedoRequestSchema = z
  .object({
    kind: z.literal('redo'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
  })
  .strict();

export const ControlRequestSchema = z.discriminatedUnion('kind', [
  CreateFrameRequestSchema,
  GetCanvasJsonRequestSchema,
  DuplicateFrameRequestSchema,
  UndoRequestSchema,
  RedoRequestSchema,
  SetTokenRequestSchema,
  CreateTokenRequestSchema,
  DeleteTokenRequestSchema,
]);

export type CreateFrameRequest = z.infer<typeof CreateFrameRequestSchema>;
export type GetCanvasJsonRequest = z.infer<typeof GetCanvasJsonRequestSchema>;
export type DuplicateFrameRequest = z.infer<typeof DuplicateFrameRequestSchema>;
export type UndoRequest = z.infer<typeof UndoRequestSchema>;
export type RedoRequest = z.infer<typeof RedoRequestSchema>;
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

// --- server -> client (direct reply to the requesting socket only) ------

export const GetCanvasJsonResultSchema = z
  .object({
    kind: z.literal('get-canvas-json-result'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    meta: FrameMetaSchema,
  })
  .strict();

/**
 * ADR-0015 — duplicate-frame's dedicated success reply. Deliberately
 * DIFFERENT from `create-frame`'s pattern (which has no success reply and
 * is observed only via the resulting `file-changed` broadcasts): a
 * `create-frame` caller already knows the exact `name`/`framePath` it
 * asked for, so watching `frames` state for that known path is enough to
 * detect success. A `duplicate-frame` caller does NOT know the resulting
 * `newName` in advance (the daemon picks it to guarantee uniqueness), so
 * without a direct reply carrying it back there would be no reliable way
 * to correlate "my duplicate landed" to a specific new frame — decision
 * taken alone, flagged in the P1-defect-fix report.
 */
export const DuplicateFrameResultSchema = z
  .object({
    kind: z.literal('duplicate-frame-result'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    sourceName: z.string().min(1),
    newName: z.string().min(1),
    framePath: z.string().min(1),
  })
  .strict();

/**
 * ADR-0018/P3 (WS-B) — undo/redo replies. `applied: false` (with no
 * `reason`) means "the stack for this file-folder is empty, nothing to
 * undo/redo" — a normal, expected outcome, not an error, so it's a reply
 * field rather than a `control-error`. `applied: false` WITH a `reason`
 * means a real failure (e.g. the concurrent-edit guard: "file changed,
 * retry") — the entry is preserved on the stack so the client can retry.
 * `file` (present only when `applied: true`) is the project-root-relative
 * path that changed, matching every other daemon wire path convention
 * (`paths.ts`) EXCEPT `uid-remap.file`, which stays file-folder-relative
 * per ADR-0018 item 5 — the broadcast `uid-remap` event (if any) carries
 * that separately.
 */
export const UndoResultSchema = z
  .object({
    kind: z.literal('undo-result'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    applied: z.boolean(),
    file: z.string().nullable(),
    reason: z.string().optional(),
  })
  .strict();

export const RedoResultSchema = z
  .object({
    kind: z.literal('redo-result'),
    requestId: z.string().min(1),
    fileFolder: z.string().min(1),
    applied: z.boolean(),
    file: z.string().nullable(),
    reason: z.string().optional(),
  })
  .strict();

/**
 * P4 — direct (non-broadcast) reply to a `set-token`/`create-token`/
 * `delete-token` request. One shared shape for all three (they're
 * structurally identical: did it apply, and if not, why) rather than three
 * near-duplicate `*-result` schemas. `applied: false` with a `reason`
 * covers both validation failures (e.g. "token already exists" from
 * `@ccs/tokens`'s `TokenEditError`) and the concurrent-edit guard, mirroring
 * `undo-result`/`redo-result`'s convention. On `applied: true` the daemon
 * ALSO broadcasts `tokens-changed` (see module doc above) once the rebuilt
 * CSS/preset outputs are written — this reply is just "your write landed",
 * the broadcast is "here's what changed as a result".
 */
export const TokenWriteResultSchema = z
  .object({
    kind: z.literal('token-write-result'),
    requestId: z.string().min(1),
    applied: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export type TokenWriteResult = z.infer<typeof TokenWriteResultSchema>;

export const ControlErrorSchema = z
  .object({
    kind: z.literal('control-error'),
    requestId: z.string().min(1),
    reason: z.string(),
  })
  .strict();

export const ControlReplySchema = z.discriminatedUnion('kind', [
  GetCanvasJsonResultSchema,
  DuplicateFrameResultSchema,
  UndoResultSchema,
  RedoResultSchema,
  TokenWriteResultSchema,
  ControlErrorSchema,
]);

export type GetCanvasJsonResult = z.infer<typeof GetCanvasJsonResultSchema>;
export type DuplicateFrameResult = z.infer<typeof DuplicateFrameResultSchema>;
export type UndoResult = z.infer<typeof UndoResultSchema>;
export type RedoResult = z.infer<typeof RedoResultSchema>;
export type ControlError = z.infer<typeof ControlErrorSchema>;
export type ControlReply = z.infer<typeof ControlReplySchema>;
