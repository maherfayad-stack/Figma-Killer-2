import type { CanvasOp, ControlReply, DaemonEvent, ProjectInfo } from '@ccs/protocol';
import {
  buildCreateFrameMessage,
  buildGetCanvasJsonMessage,
  buildSetGeometryMessage,
  classifyDaemonMessage,
} from './daemon-protocol.js';

/**
 * Thin, stateful wrapper around the ADR-0013 control-ws — the only place
 * in `packages/canvas` that touches a real `WebSocket`. All wire-format
 * decisions live in the pure `daemon-protocol.ts` (unit tested there
 * without a socket); this module just plumbs bytes to/from it, hence
 * `SocketFactory` injection so `daemon-client.test.ts` can exercise the
 * open/message/close routing with a fake socket, no network involved.
 */

/** The minimal subset of the browser `WebSocket` surface this module
 * needs — structurally compatible with the real thing, small enough to
 * fake in tests. */
export interface MinimalSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => MinimalSocket;

export interface DaemonClientHandlers {
  onProjectInfo: (info: ProjectInfo) => void;
  onEvent: (event: DaemonEvent) => void;
  /** ADR-0014: a direct (non-broadcast) reply to this client's own
   * `create-frame`/`get-canvas-json` request. */
  onControlReply: (reply: ControlReply) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Invalid/unparseable message, or a transport error — never thrown,
   * always routed here so the caller decides whether it's fatal. */
  onError?: (err: unknown) => void;
}

export interface DaemonClient {
  sendSetGeometry(
    fileFolder: string,
    framePath: string,
    geometry: { x: number; y: number; w: number; h: number },
  ): void;
  /** P1 scope: the daemon answers every op with `op-rejected` (ADR-0012 —
   * real AST apply is Phase 3). Wired now so P2/P3 don't need a new
   * client entry point, per playbook §5.4's "keep the abstraction cheap
   * to extend" spirit. */
  sendCanvasOp(op: CanvasOp, opId: string): void;
  /** ADR-0014. Success is observed via the resulting `file-changed`
   * broadcast(s), not a direct reply; failure arrives via
   * `onControlReply` as a `control-error` with this `requestId`. */
  sendCreateFrame(fileFolder: string, name: string, requestId: string): void;
  /** ADR-0014. Reply arrives via `onControlReply` (`get-canvas-json-result`
   * or `control-error`) with this `requestId`. */
  sendGetCanvasJson(fileFolder: string, requestId: string): void;
  close(): void;
}

function defaultSocketFactory(url: string): MinimalSocket {
  return new WebSocket(url) as unknown as MinimalSocket;
}

export function connectDaemon(
  url: string,
  handlers: DaemonClientHandlers,
  socketFactory: SocketFactory = defaultSocketFactory,
): DaemonClient {
  const socket = socketFactory(url);

  socket.onopen = () => handlers.onOpen?.();
  socket.onclose = () => handlers.onClose?.();
  socket.onerror = (err) => handlers.onError?.(err);
  socket.onmessage = (event) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch (err) {
      handlers.onError?.(err);
      return;
    }
    const message = classifyDaemonMessage(raw);
    if (message.kind === 'project-info') {
      handlers.onProjectInfo(message.info);
    } else if (message.kind === 'daemon-event') {
      handlers.onEvent(message.event);
    } else if (message.kind === 'control-reply') {
      handlers.onControlReply(message.reply);
    } else {
      handlers.onError?.(new Error(`@ccs/canvas: ${message.reason}`));
    }
  };

  return {
    sendSetGeometry(fileFolder, framePath, geometry) {
      socket.send(JSON.stringify(buildSetGeometryMessage(fileFolder, framePath, geometry)));
    },
    sendCanvasOp(op, opId) {
      socket.send(JSON.stringify({ kind: 'canvas-op', opId, op }));
    },
    sendCreateFrame(fileFolder, name, requestId) {
      socket.send(JSON.stringify(buildCreateFrameMessage(requestId, fileFolder, name)));
    },
    sendGetCanvasJson(fileFolder, requestId) {
      socket.send(JSON.stringify(buildGetCanvasJsonMessage(requestId, fileFolder)));
    },
    close() {
      socket.close();
    },
  };
}
