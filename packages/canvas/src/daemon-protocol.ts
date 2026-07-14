import {
  ControlReplySchema,
  DaemonEventSchema,
  ProjectInfoSchema,
  type ControlReply,
  type CreateFrameRequest,
  type DaemonEvent,
  type DuplicateFrameRequest,
  type GetCanvasJsonRequest,
  type ProjectInfo,
} from '@ccs/protocol';

/**
 * Pure wire-format helpers for the ADR-0013 control-ws protocol (plus the
 * ADR-0014 additive control-request/reply extension). No WebSocket/browser
 * API here — this module is deliberately side-effect free so it can be
 * unit tested without a real socket (the daemon-client module is the thin
 * stateful wrapper around these functions).
 *
 * Wire format (frozen ADR-0013 + additive ADR-0014):
 *   - First message per connection = bare `ProjectInfo` (no `t`, no `kind`).
 *   - Subsequent server→client = bare `DaemonEvent` (always has `t`) OR a
 *     direct (non-broadcast) `ControlReply` (always has `kind`, never `t`)
 *     replying to this client's own `create-frame`/`get-canvas-json`
 *     request.
 *   - Client→server op: `{kind:'canvas-op', opId, op}`.
 *   - Client→server geometry: `{kind:'set-geometry', fileFolder, framePath, x,y,w,h}`.
 *   - Client→server create-frame: `{kind:'create-frame', requestId, fileFolder, name}` (ADR-0014).
 *   - Client→server get-canvas-json: `{kind:'get-canvas-json', requestId, fileFolder}` (ADR-0014).
 *   - Client→server duplicate-frame: `{kind:'duplicate-frame', requestId, fileFolder, sourceName, newName?}` (ADR-0015).
 */

export type IncomingDaemonMessage =
  | { kind: 'project-info'; info: ProjectInfo }
  | { kind: 'daemon-event'; event: DaemonEvent }
  | { kind: 'control-reply'; reply: ControlReply }
  | { kind: 'invalid'; raw: unknown; reason: string };

/**
 * Classify one raw parsed-JSON message from the control ws, in priority
 * order: a `t` field means `DaemonEvent`; a `kind` field (and no `t`) means
 * an ADR-0014 `ControlReply`; neither means the bootstrap `ProjectInfo`.
 * These three shapes are mutually exclusive by construction (ADR-0012's
 * `ProjectInfo` deliberately has neither field; ADR-0014's replies
 * deliberately use `kind` instead of `t` specifically so this stays
 * unambiguous without an envelope), so checking structurally rather than
 * assuming message order is robust to a client reconnecting mid-stream.
 */
export function classifyDaemonMessage(raw: unknown): IncomingDaemonMessage {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'invalid', raw, reason: 'not a JSON object' };
  }
  const record = raw as Record<string, unknown>;

  if ('t' in record) {
    const parsed = DaemonEventSchema.safeParse(raw);
    if (parsed.success) return { kind: 'daemon-event', event: parsed.data };
    return { kind: 'invalid', raw, reason: `invalid DaemonEvent: ${parsed.error.message}` };
  }

  if ('kind' in record) {
    const parsed = ControlReplySchema.safeParse(raw);
    if (parsed.success) return { kind: 'control-reply', reply: parsed.data };
    return { kind: 'invalid', raw, reason: `invalid ControlReply: ${parsed.error.message}` };
  }

  const parsedInfo = ProjectInfoSchema.safeParse(raw);
  if (parsedInfo.success) return { kind: 'project-info', info: parsedInfo.data };
  return { kind: 'invalid', raw, reason: `invalid ProjectInfo: ${parsedInfo.error.message}` };
}

/** Outgoing client→server envelopes (ADR-0013). */
export interface SetGeometryMessage {
  kind: 'set-geometry';
  fileFolder: string;
  framePath: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasOpMessage {
  kind: 'canvas-op';
  opId: string;
  op: unknown;
}

/** ADR-0014 outgoing client→server envelopes. */
export function buildCreateFrameMessage(requestId: string, fileFolder: string, name: string): CreateFrameRequest {
  return { kind: 'create-frame', requestId, fileFolder, name };
}

export function buildGetCanvasJsonMessage(requestId: string, fileFolder: string): GetCanvasJsonRequest {
  return { kind: 'get-canvas-json', requestId, fileFolder };
}

/** ADR-0015. `newName` is an optional caller hint — omitted by
 * `packages/canvas`'s default duplicate handler today (it always lets the
 * daemon pick a unique name), kept here so this builder can express the
 * full wire shape without a future protocol change. */
export function buildDuplicateFrameMessage(
  requestId: string,
  fileFolder: string,
  sourceName: string,
  newName?: string,
): DuplicateFrameRequest {
  return newName === undefined
    ? { kind: 'duplicate-frame', requestId, fileFolder, sourceName }
    : { kind: 'duplicate-frame', requestId, fileFolder, sourceName, newName };
}

export function buildSetGeometryMessage(
  fileFolder: string,
  framePath: string,
  geometry: { x: number; y: number; w: number; h: number },
): SetGeometryMessage {
  return { kind: 'set-geometry', fileFolder, framePath, ...geometry };
}

/**
 * `ProjectInfo.framePath` is PROJECT-ROOT-relative (e.g.
 * "files/demo/src/frames/Hero.tsx" — task brief, ADR-0013 path
 * conventions). `FrameEntry.framePath` inside `.studio/canvas.json` is
 * file-folder-relative (e.g. "src/frames/Hero.tsx"). This derives both the
 * file-folder name and the file-folder-relative path from the project-root-
 * relative one, assuming the fixed `files/<fileFolder>/...` layout the
 * daemon's own `scan.ts` enforces.
 */
export interface DerivedFramePath {
  fileFolder: string;
  relPath: string;
}

export function deriveFileFolderPath(projectRelativeFramePath: string): DerivedFramePath | null {
  const segments = projectRelativeFramePath.split('/').filter((s) => s.length > 0);
  if (segments.length < 3 || segments[0] !== 'files') return null;
  const fileFolder = segments[1];
  const relPath = segments.slice(2).join('/');
  if (!fileFolder || relPath.length === 0) return null;
  return { fileFolder, relPath };
}

/** True when `relPath` (file-folder-relative) is a frame source file under
 * `src/frames/*.tsx` — the convention `scan.ts`/`watcher.ts` enforce on the
 * daemon side (playbook §4/P0 convention). */
export function isFrameSourcePath(relPath: string): boolean {
  return /^src\/frames\/[^/]+\.tsx$/.test(relPath);
}

/** True when `relPath` (file-folder-relative) is the `.studio/canvas.json`
 * spatial-metadata file. */
export function isCanvasJsonPath(relPath: string): boolean {
  return relPath === '.studio/canvas.json';
}

/** Frame name (filename without extension) from a `src/frames/<Name>.tsx`
 * relative path, or `null` if it doesn't match that shape. */
export function frameNameFromPath(relPath: string): string | null {
  const match = /^src\/frames\/([^/]+)\.tsx$/.exec(relPath);
  return match ? (match[1] ?? null) : null;
}
