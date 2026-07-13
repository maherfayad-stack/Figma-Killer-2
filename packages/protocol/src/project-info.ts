import { z } from 'zod';

/**
 * ProjectInfo — the sync-daemon's ws bootstrap/handshake message (ADR-0012).
 *
 * This is an ADDITIVE extension to the frozen P0 protocol surface, approved
 * explicitly by ADR-0012: "the sync-daemon worker MAY add a `ProjectInfo`/
 * bootstrap-message zod schema + type to `packages/protocol` additively.
 * The frozen types (CanvasOp, DaemonEvent, FrameMeta, TreeNode, NodeUid)
 * MUST NOT change."
 *
 * Wire shape matches ADR-0012 exactly: on ws connect, the daemon sends this
 * object (no envelope) as the very first message on the socket:
 *   { frames: [{ framePath, name, devServerUrl }], daemonPort }
 *
 * Deliberately NOT a `DaemonEvent` variant (ADR-0012: "a control/handshake
 * message, deliberately NOT a DaemonEvent variant — events = state changes
 * only"). Because it carries no `t` discriminant field, a client can always
 * distinguish a bootstrap message from a `DaemonEvent` (which always has
 * `t`) structurally, without a wrapper envelope.
 *
 * `framePath` here is a sync-daemon design choice (not specified by
 * ADR-0012 beyond the field name): it is the frame's source path relative
 * to the PROJECT root (e.g. "files/demo/src/frames/Hero.tsx"), NOT relative
 * to the file-folder root like `FrameEntry.framePath` in `.studio/
 * canvas.json`. A single daemon manages multiple file-folders, so a
 * project-root-relative path is required to stay unambiguous across them.
 * See sync-daemon CHANGE-REQUEST notes for the canvas-worker-facing detail.
 */
export const ProjectInfoFrameSchema = z
  .object({
    /** Frame source path, relative to the PROJECT root. */
    framePath: z.string().min(1),
    /** Frame name (filename without extension), e.g. "Hero". */
    name: z.string().min(1),
    /** Fully-qualified URL the canvas should load in an iframe, already
     * including the `?frame=<Name>` query (e.g.
     * "http://127.0.0.1:5200/?frame=Hero"). Direct HMR connection — never
     * proxied through the daemon (ADR-0012, playbook §1/P1 pitfall). */
    devServerUrl: z.string().min(1),
  })
  .strict();

export const ProjectInfoSchema = z
  .object({
    frames: z.array(ProjectInfoFrameSchema),
    /** Port the control websocket itself is bound to (127.0.0.1 only). */
    daemonPort: z.number().int().positive(),
  })
  .strict();

export type ProjectInfoFrame = z.infer<typeof ProjectInfoFrameSchema>;
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;
