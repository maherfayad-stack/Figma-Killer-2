import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  CanvasOpSchema,
  DaemonEventSchema,
  type CanvasOp,
  type DaemonEvent,
  type ProjectInfo,
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
 *     { kind: 'canvas-op'; opId: string; op: CanvasOp }
 *     { kind: 'set-geometry'; fileFolder: string; framePath: string;
 *       x: number; y: number; w: number; h: number }
 *
 *   Server → Client:
 *     - first message on every connection: the bare `ProjectInfo`
 *       bootstrap object (no `t` field — structurally distinct from every
 *       `DaemonEvent`, which always has one).
 *     - afterwards: bare `DaemonEvent` objects, broadcast to all
 *       connected clients.
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
  | { kind: 'canvas-op'; opId: string; op: CanvasOp }
  | ({ kind: 'set-geometry' } & SetGeometryRequest);

export interface ControlServerOptions {
  port: number;
  host?: string;
  getBootstrap: () => ProjectInfo;
  onCanvasOp: (op: CanvasOp, opId: string) => void;
  onSetGeometry: (request: SetGeometryRequest) => void;
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
  const wss = new WebSocketServer({ host, port: options.port });
  const clients = new Set<WebSocket>();

  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify(options.getBootstrap()));

    socket.on('message', (data: RawData) => {
      const rejection = rejectIfInvalidCanvasOp(data);
      if (rejection) {
        socket.send(JSON.stringify(DaemonEventSchema.parse(rejection)));
        return;
      }

      const message = parseClientMessage(data);
      if (!message) return;

      if (message.kind === 'canvas-op') {
        options.onCanvasOp(message.op, message.opId);
      } else if (message.kind === 'set-geometry') {
        options.onSetGeometry({
          fileFolder: message.fileFolder,
          framePath: message.framePath,
          x: message.x,
          y: message.y,
          w: message.w,
          h: message.h,
        });
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
    return { kind: 'canvas-op', opId, op: parsedOp.data };
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

  return null;
}
