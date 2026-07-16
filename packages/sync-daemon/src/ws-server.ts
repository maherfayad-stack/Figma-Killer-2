import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  CanvasOpSchema,
  ControlReplySchema,
  CreateFrameRequestSchema,
  CreateTokenRequestSchema,
  DaemonEventSchema,
  DeleteTokenRequestSchema,
  DuplicateFrameRequestSchema,
  GetCanvasJsonRequestSchema,
  RedoRequestSchema,
  SetTokenRequestSchema,
  UndoRequestSchema,
  type CanvasOp,
  type ControlReply,
  type CreateFrameRequest,
  type CreateTokenRequest,
  type DaemonEvent,
  type DeleteTokenRequest,
  type DuplicateFrameRequest,
  type GetCanvasJsonRequest,
  type ProjectInfo,
  type RedoRequest,
  type SetTokenRequest,
  type UndoRequest,
} from '@ccs/protocol';

/**
 * Control WebSocket — ADR-0012, playbook §4/P1 step 3.
 *
 * Bind is 127.0.0.1 ONLY (playbook §5.8 + BOUNDARIES). Server→client
 * carries `DaemonEvent` (frozen union) as bare JSON (always has a `t`
 * discriminant). Client→server carries an envelope distinguishing a
 * queued `CanvasOp` from other control requests — ADR-0012 explicitly
 * allows this ("plus control requests"), since only the high-level shapes
 * (DaemonEvent / CanvasOp / the ProjectInfo bootstrap) are frozen, not the
 * full control-channel wire format:
 *
 *   Client → Server:
 *     { kind: 'canvas-op'; opId: string; op: CanvasOp; fileFolder?: string }
 *     { kind: 'set-geometry'; fileFolder: string; framePath: string;
 *       x: number; y: number; w: number; h: number }
 *     { kind: 'create-frame'; requestId: string; fileFolder: string; name: string }   (ADR-0014)
 *     { kind: 'get-canvas-json'; requestId: string; fileFolder: string }              (ADR-0014)
 *     { kind: 'duplicate-frame'; requestId: string; fileFolder: string;
 *       sourceName: string; newName?: string }                                        (ADR-0015)
 *     { kind: 'undo'; requestId: string; fileFolder: string }                         (P3, ADR-0018 item 9)
 *     { kind: 'redo'; requestId: string; fileFolder: string }                         (P3, ADR-0018 item 9)
 *     { kind: 'set-token'|'create-token'; requestId: string; group; theme; key: string;
 *       value: string|number }                                                        (P4, ADR-0022)
 *     { kind: 'delete-token'; requestId: string; group; theme; key: string }           (P4, ADR-0022)
 *
 *   CR (P3, flagged): `canvas-op.fileFolder` is a NEW optional field on
 *   the ADR-0013-frozen envelope. `NodeUid` (and therefore `CanvasOp`) is
 *   only FILE-FOLDER-relative (ADR-0013's own path-conventions note:
 *   "Canvas maps between them via the fileFolder segment / devServerUrl")
 *   — the frozen envelope itself never carried that segment, which is
 *   invisible with exactly one file-folder (every P1/P2 fixture) but
 *   genuinely ambiguous once two file-folders can contain a same-named
 *   frame path. When omitted, the daemon falls back to a best-effort
 *   on-disk lookup (`resolveFileFolderForOp` in `daemon.ts`) and rejects
 *   with a clear "ambiguous file-folder" reason if more than one
 *   candidate matches — additive/optional, so no existing caller breaks.
 *
 *   Server → Client:
 *     - first message on every connection: the bare `ProjectInfo`
 *       bootstrap object (no `t` field — structurally distinct from every
 *       `DaemonEvent`, which always has one).
 *     - immediately after: zero or more `getInitialEvents` replays (P5,
 *       `tree-snapshot.ts`) — currently every known frame's cached
 *       tree-snapshot — sent to THAT connection only.
 *     - afterwards: bare `DaemonEvent` objects, broadcast to all
 *       connected clients.
 *     - ADR-0014/0015 control replies (`ControlReply` —
 *       `get-canvas-json-result`, `duplicate-frame-result`, or
 *       `control-error`) are sent directly to the ONE requesting socket,
 *       never broadcast — distinct from `DaemonEvent` in having a `kind`
 *       field instead of `t`. A successful `create-frame` has no dedicated
 *       reply; it's observed via the ordinary broadcast `file-changed`
 *       events on the new frame's source path and canvas.json (below).
 *       `duplicate-frame` DOES get a dedicated success reply
 *       (`duplicate-frame-result`) — unlike `create-frame`, the caller
 *       doesn't know the resulting unique name in advance (ADR-0015).
 *
 * AUDIT-6 BLOCKER finding (playbook §5.8): binding to 127.0.0.1 only
 * blocks OFF-machine attackers, but NOT an in-browser attacker — any
 * malicious webpage the user has open in a normal browser tab can still
 * open a `ws://127.0.0.1:<port>` connection to this server, because
 * browsers don't sandbox loopback WebSocket connections the way they
 * sandbox cross-origin HTTP. `verifyOrigin` below closes that gap: a
 * connection whose `Origin` header is PRESENT and NOT a localhost origin
 * is rejected at the handshake. A connection with NO `Origin` header at
 * all (native/non-browser clients — this package's own tests, the CLI dev
 * harness, `ws` Node clients that never set `origin` in `ClientOptions`)
 * is allowed, since only browsers are required to send it.
 */

export interface SetGeometryRequest {
  fileFolder: string;
  framePath: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ClientMessage =
  | { kind: 'canvas-op'; opId: string; op: CanvasOp; fileFolder?: string }
  | ({ kind: 'set-geometry' } & SetGeometryRequest)
  | CreateFrameRequest
  | GetCanvasJsonRequest
  | DuplicateFrameRequest
  | UndoRequest
  | RedoRequest
  | SetTokenRequest
  | CreateTokenRequest
  | DeleteTokenRequest;

const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * AUDIT-6 BLOCKER fix (playbook §5.8): true for "no Origin header at all"
 * (native/non-browser clients) OR an `http(s)://127.0.0.1[:port]` /
 * `http(s)://localhost[:port]` origin. False for anything else — in
 * particular, any REAL webpage origin a browser would send, which is
 * exactly the malicious-webpage-drives-the-daemon threat this closes.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  return LOCALHOST_ORIGIN_PATTERN.test(origin);
}

/** `ws`'s synchronous `verifyClient` hook — runs before the handshake
 * completes, so a rejected connection never reaches the `connection`
 * handler at all (no bootstrap sent, no messages processed). */
function verifyOrigin(info: { origin: string; secure: boolean; req: unknown }): boolean {
  return isAllowedOrigin(info.origin);
}

/** Sends a `ControlReply` to the ONE socket that made the request —
 * validated against the frozen-shape-additive `ControlReplySchema` first,
 * same safety-net discipline as `broadcast`'s `DaemonEventSchema.parse`. */
export type ReplyFn = (reply: ControlReply) => void;

export interface ControlServerOptions {
  port: number;
  host?: string;
  getBootstrap: () => ProjectInfo;
  /**
   * Additive (P5, `tree-snapshot.ts`): events replayed to a NEWLY
   * connecting client ONLY (never broadcast to existing clients), sent
   * immediately after the bootstrap `ProjectInfo` — e.g. every currently-
   * known frame's live tree-snapshot, so a fresh connection's LayersPanel
   * has data to render before the next edit/HMR event would otherwise
   * trigger a broadcast. Validated the same way `broadcast` is. Optional
   * so every pre-existing caller/test needs no change.
   */
  getInitialEvents?: () => DaemonEvent[];
  /** `fileFolder` is the P3 CR above — optional, undefined for any caller
   * that predates it. */
  onCanvasOp: (op: CanvasOp, opId: string, fileFolder?: string) => void;
  onSetGeometry: (request: SetGeometryRequest) => void;
  /** ADR-0014. */
  onCreateFrame: (request: CreateFrameRequest, reply: ReplyFn) => void;
  /** ADR-0014. */
  onGetCanvasJson: (request: GetCanvasJsonRequest, reply: ReplyFn) => void;
  /** P3, ADR-0018 item 9. */
  onUndo: (request: UndoRequest, reply: ReplyFn) => void;
  /** P3, ADR-0018 item 9. */
  onRedo: (request: RedoRequest, reply: ReplyFn) => void;
  /** ADR-0015. */
  onDuplicateFrame: (request: DuplicateFrameRequest, reply: ReplyFn) => void;
  /** P4, ADR-0022. */
  onSetToken: (request: SetTokenRequest, reply: ReplyFn) => void;
  /** P4, ADR-0022. */
  onCreateToken: (request: CreateTokenRequest, reply: ReplyFn) => void;
  /** P4, ADR-0022. */
  onDeleteToken: (request: DeleteTokenRequest, reply: ReplyFn) => void;
}

export interface ControlServerHandle {
  port: number;
  host: string;
  /** Validates against the frozen `DaemonEvent` schema before sending —
   * a safety net so this module can never emit a malformed event. */
  broadcast(event: DaemonEvent): void;
  clientCount(): number;
  close(): Promise<void>;
}

export function createControlServer(options: ControlServerOptions): ControlServerHandle {
  const host = options.host ?? '127.0.0.1';
  const wss = new WebSocketServer({ host, port: options.port, verifyClient: verifyOrigin });
  const clients = new Set<WebSocket>();

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify(options.getBootstrap()));
    for (const event of options.getInitialEvents?.() ?? []) {
      socket.send(JSON.stringify(DaemonEventSchema.parse(event)));
    }

    socket.on('message', (data: RawData) => {
      const rejection = rejectIfInvalidCanvasOp(data);
      if (rejection) {
        socket.send(JSON.stringify(DaemonEventSchema.parse(rejection)));
        return;
      }

      const message = parseClientMessage(data);
      if (!message) return;

      if (message.kind === 'canvas-op') {
        options.onCanvasOp(message.op, message.opId, message.fileFolder);
      } else if (message.kind === 'set-geometry') {
        options.onSetGeometry({
          fileFolder: message.fileFolder,
          framePath: message.framePath,
          x: message.x,
          y: message.y,
          w: message.w,
          h: message.h,
        });
      } else if (message.kind === 'create-frame') {
        options.onCreateFrame(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'get-canvas-json') {
        options.onGetCanvasJson(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'duplicate-frame') {
        options.onDuplicateFrame(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'undo') {
        options.onUndo(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'redo') {
        options.onRedo(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'set-token') {
        options.onSetToken(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'create-token') {
        options.onCreateToken(message, (reply) => sendReply(socket, reply));
      } else if (message.kind === 'delete-token') {
        options.onDeleteToken(message, (reply) => sendReply(socket, reply));
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
    });
    socket.on('error', () => {
      clients.delete(socket);
    });
  });

  return {
    port: options.port,
    host,
    broadcast(event) {
      const validated = DaemonEventSchema.parse(event);
      const payload = JSON.stringify(validated);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    },
    clientCount() {
      return clients.size;
    },
    async close() {
      for (const client of clients) client.terminate();
      clients.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** ADR-0014: direct, non-broadcast reply to the one socket that made a
 * `create-frame`/`get-canvas-json` request — validated against
 * `ControlReplySchema` first so this module can never emit a malformed
 * reply (same discipline as `broadcast`). */
function sendReply(socket: WebSocket, reply: ControlReply): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(ControlReplySchema.parse(reply)));
}

/** Detects a `{kind:'canvas-op', ...}` envelope whose `op` fails the frozen
 * `CanvasOpSchema` and returns the `op-rejected` DaemonEvent that should be
 * sent straight back — distinct from `parseClientMessage` returning `null`
 * for messages that aren't even shaped like a known request (those are
 * silently dropped, not rejected, since we can't be sure they were meant
 * for us at all). */
function rejectIfInvalidCanvasOp(data: RawData): DaemonEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind !== 'canvas-op') return null;

  const parsedOp = CanvasOpSchema.safeParse(record.op);
  if (parsedOp.success) return null;

  const opId = typeof record.opId === 'string' ? record.opId : 'unknown';
  return { t: 'op-rejected', opId, reason: `invalid CanvasOp: ${parsedOp.error.message}` };
}

function parseClientMessage(data: RawData): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (record.kind === 'canvas-op') {
    const opId = typeof record.opId === 'string' ? record.opId : null;
    const parsedOp = CanvasOpSchema.safeParse(record.op);
    if (!opId || !parsedOp.success) return null;
    // P3 CR (see module doc): optional fileFolder disambiguator.
    const fileFolder = typeof record.fileFolder === 'string' ? record.fileFolder : undefined;
    return { kind: 'canvas-op', opId, op: parsedOp.data, ...(fileFolder !== undefined ? { fileFolder } : {}) };
  }

  if (record.kind === 'set-geometry') {
    const { fileFolder, framePath, x, y, w, h } = record;
    if (
      typeof fileFolder === 'string' &&
      typeof framePath === 'string' &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof w === 'number' &&
      typeof h === 'number'
    ) {
      return { kind: 'set-geometry', fileFolder, framePath, x, y, w, h };
    }
    return null;
  }

  if (record.kind === 'create-frame') {
    const parsed = CreateFrameRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'get-canvas-json') {
    const parsed = GetCanvasJsonRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'duplicate-frame') {
    const parsed = DuplicateFrameRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'undo') {
    const parsed = UndoRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'redo') {
    const parsed = RedoRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'set-token') {
    const parsed = SetTokenRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'create-token') {
    const parsed = CreateTokenRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  if (record.kind === 'delete-token') {
    const parsed = DeleteTokenRequestSchema.safeParse(record);
    return parsed.success ? parsed.data : null;
  }

  return null;
}
