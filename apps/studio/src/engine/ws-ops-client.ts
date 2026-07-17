import {
  CanvasOpSchema,
  ControlReplySchema,
  DaemonEventSchema,
  ProjectInfoSchema,
  type CanvasOp,
  type ControlReply,
  type DaemonEvent,
  type ProjectInfo,
} from '@ccs/protocol';

/**
 * The studio chrome's OWN control-ws connection (ADR-0012/0013's frozen
 * wire format), independent of `@ccs/canvas`'s internal one.
 *
 * CR (daemon/canvas interface gap, flagged per this task's brief):
 * `packages/canvas`'s `StudioCanvas` owns exactly one control-ws connection
 * internally (`daemon-client.ts`) but exposes NO way for a host app to (a)
 * send a `CanvasOp` through it, (b) read the live `CanvasFrameRecord[]`
 * list, or (c) subscribe to the P2 selection store (`useSelectionStore`/
 * `onUidRemap` exist in `packages/canvas/src/selection-store.ts` but are
 * NOT re-exported from `packages/canvas/src/index.ts` — verified by
 * reading the file). Given the STRICT "import-only, do not modify
 * `packages/canvas`" rule for this phase, P5 cannot reach into that
 * internal store. The daemon's control-ws is explicitly a multi-client
 * channel (ADR-0012 design: broadcasts `DaemonEvent`s to every connected
 * client), so opening a SECOND connection here — speaking the exact same
 * FROZEN wire protocol, validated against the same `@ccs/protocol` zod
 * schemas — is the correct, sanctioned way to add op-sending without
 * touching `@ccs/canvas`. Ideal fix for a later pass: `@ccs/canvas` grows
 * an exported `useSelectionStore`/`sendCanvasOp` surface so chrome and
 * canvas share one socket; tracked as a CR in the phase report, not solved
 * silently here.
 */

export interface OpsClientHandlers {
  onProjectInfo: (info: ProjectInfo) => void;
  onEvent: (event: DaemonEvent) => void;
  onControlReply: (reply: ControlReply) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
}

export interface OpsClient {
  /** Sends a `CanvasOp` over the control-ws (ADR-0013 wire format:
   * `{kind:'canvas-op', opId, op}`). Returns the generated `opId` so the
   * caller can correlate a later `op-applied`/`op-rejected` broadcast. */
  sendOp: (op: CanvasOp) => string;
  sendUndo: (fileFolder: string) => string;
  sendRedo: (fileFolder: string) => string;
  /** FP-INS-b (Inspect / code tab) — additive, READ-ONLY: requests either
   * the whole frame's source (`uid` omitted) or one node's JSX slice (`uid`
   * present). Returns the generated `requestId` so the caller can correlate
   * the eventual `read-source-result`/`control-error` reply, same pattern as
   * `sendUndo`/`sendRedo`. */
  sendReadSource: (fileFolder: string, framePath: string, uid?: string) => string;
  close: () => void;
}

type ClassifiedMessage =
  | { kind: 'project-info'; info: ProjectInfo }
  | { kind: 'daemon-event'; event: DaemonEvent }
  | { kind: 'control-reply'; reply: ControlReply }
  | { kind: 'invalid'; reason: string };

/** Mirrors `@ccs/canvas`'s `classifyDaemonMessage` discipline (documented
 * in `control-messages.ts`): `t` -> DaemonEvent, `kind` -> control
 * request/reply, neither -> the bare `ProjectInfo` bootstrap. Re-derived
 * here (not imported — `daemon-protocol.ts` isn't part of `@ccs/canvas`'s
 * public exports) validated against the same frozen `@ccs/protocol`
 * schemas, so it can never silently drift into accepting a shape the real
 * daemon wouldn't send. */
function classify(raw: unknown): ClassifiedMessage {
  if (raw && typeof raw === 'object' && 't' in raw) {
    const parsed = DaemonEventSchema.safeParse(raw);
    return parsed.success ? { kind: 'daemon-event', event: parsed.data } : { kind: 'invalid', reason: 'bad DaemonEvent' };
  }
  if (raw && typeof raw === 'object' && 'kind' in raw) {
    const parsed = ControlReplySchema.safeParse(raw);
    return parsed.success ? { kind: 'control-reply', reply: parsed.data } : { kind: 'invalid', reason: 'bad ControlReply' };
  }
  const parsed = ProjectInfoSchema.safeParse(raw);
  return parsed.success ? { kind: 'project-info', info: parsed.data } : { kind: 'invalid', reason: 'unrecognized message' };
}

let opIdCounter = 0;
function nextOpId(): string {
  opIdCounter += 1;
  return `studio-op-${opIdCounter}`;
}

let requestIdCounter = 0;
function nextRequestId(prefix: string): string {
  requestIdCounter += 1;
  return `${prefix}-${requestIdCounter}`;
}

/** Dev-only emitted-ops log (`window.__ccsOpsLog`) — read by the P5
 * Playwright acceptance suite so op-shape assertions don't depend on the
 * real daemon accepting/rejecting a mock-P4-sourced op (e.g. a `{token}`
 * `set-prop`, which P3 may legitimately answer `op-rejected: unsupported`
 * per ADR-0019 decision 6 — the CLIENT still emitted the correct shape,
 * which is what this phase's acceptance actually needs to prove). Capped
 * so a long dev session can't leak memory. */
const OPS_LOG_CAP = 500;
declare global {
  interface Window {
    __ccsOpsLog?: Array<{ opId: string; op: CanvasOp }>;
  }
}
function logOp(opId: string, op: CanvasOp): void {
  if (typeof window === 'undefined') return;
  const log = (window.__ccsOpsLog ??= []);
  log.push({ opId, op });
  if (log.length > OPS_LOG_CAP) log.splice(0, log.length - OPS_LOG_CAP);
}

/** Minimal `WebSocket` surface this module needs — matches
 * `@ccs/canvas`'s `daemon-client.ts` `MinimalSocket`/`SocketFactory`
 * pattern so this client is unit-testable with a fake socket, no real
 * network involved (see `ws-ops-client.test.ts`). */
export interface MinimalSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => MinimalSocket;

function defaultSocketFactory(url: string): MinimalSocket {
  return new WebSocket(url) as unknown as MinimalSocket;
}

export function connectOpsClient(
  url: string,
  handlers: OpsClientHandlers,
  socketFactory: SocketFactory = defaultSocketFactory,
): OpsClient {
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
    const message = classify(raw);
    if (message.kind === 'project-info') handlers.onProjectInfo(message.info);
    else if (message.kind === 'daemon-event') handlers.onEvent(message.event);
    else if (message.kind === 'control-reply') handlers.onControlReply(message.reply);
    else handlers.onError?.(new Error(`@ccs/studio ops-client: ${message.reason}`));
  };

  return {
    sendOp(op: CanvasOp): string {
      CanvasOpSchema.parse(op); // fail fast on a malformed op, never send garbage over the wire
      const opId = nextOpId();
      socket.send(JSON.stringify({ kind: 'canvas-op', opId, op }));
      logOp(opId, op);
      return opId;
    },
    sendUndo(fileFolder: string): string {
      const requestId = nextRequestId('undo');
      socket.send(JSON.stringify({ kind: 'undo', requestId, fileFolder }));
      return requestId;
    },
    sendRedo(fileFolder: string): string {
      const requestId = nextRequestId('redo');
      socket.send(JSON.stringify({ kind: 'redo', requestId, fileFolder }));
      return requestId;
    },
    sendReadSource(fileFolder: string, framePath: string, uid?: string): string {
      const requestId = nextRequestId('read-source');
      socket.send(
        JSON.stringify({ kind: 'read-source', requestId, fileFolder, framePath, ...(uid !== undefined ? { uid } : {}) }),
      );
      return requestId;
    },
    close() {
      socket.close();
    },
  };
}
