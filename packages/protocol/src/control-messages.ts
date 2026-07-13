import { z } from 'zod';
import { FrameMetaSchema } from './frame-meta.js';

/**
 * ADR-0014 — additive control-ws request/reply shapes closing the two P1
 * interface gaps (daemon has no `create-frame`/`get-canvas-json` API yet).
 * Additive only: does NOT touch the frozen `CanvasOp`/`DaemonEvent`/
 * `FrameMeta`/`TreeNode`/`NodeUid` types (ADR-0012/0013).
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

export const ControlRequestSchema = z.discriminatedUnion('kind', [
  CreateFrameRequestSchema,
  GetCanvasJsonRequestSchema,
]);

export type CreateFrameRequest = z.infer<typeof CreateFrameRequestSchema>;
export type GetCanvasJsonRequest = z.infer<typeof GetCanvasJsonRequestSchema>;
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

export const ControlErrorSchema = z
  .object({
    kind: z.literal('control-error'),
    requestId: z.string().min(1),
    reason: z.string(),
  })
  .strict();

export const ControlReplySchema = z.discriminatedUnion('kind', [
  GetCanvasJsonResultSchema,
  ControlErrorSchema,
]);

export type GetCanvasJsonResult = z.infer<typeof GetCanvasJsonResultSchema>;
export type ControlError = z.infer<typeof ControlErrorSchema>;
export type ControlReply = z.infer<typeof ControlReplySchema>;
