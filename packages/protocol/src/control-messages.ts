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
  ControlErrorSchema,
]);

export type GetCanvasJsonResult = z.infer<typeof GetCanvasJsonResultSchema>;
export type DuplicateFrameResult = z.infer<typeof DuplicateFrameResultSchema>;
export type UndoResult = z.infer<typeof UndoResultSchema>;
export type RedoResult = z.infer<typeof RedoResultSchema>;
export type ControlError = z.infer<typeof ControlErrorSchema>;
export type ControlReply = z.infer<typeof ControlReplySchema>;
