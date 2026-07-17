import * as React from 'react';
import type { CanvasOp, ControlReply, DaemonEvent, ProjectInfo } from '@ccs/protocol';
import { connectOpsClient, type OpsClient } from './ws-ops-client.js';

/**
 * Studio-chrome-side daemon connection (see `ws-ops-client.ts`'s module doc
 * for why this is a SECOND control-ws connection, not `@ccs/canvas`'s
 * internal one). Provides:
 *   - `sendOp` — the P3 op-emission path every chrome control writes
 *     through (Inspector, ComponentsPanel, ContextMenu, keyboard map).
 *   - a best-effort live frame list for `PagesPanel` (playbook §2.2
 *     `sitemap.cljs`), derived from the `ProjectInfo` bootstrap +
 *     `file-changed` broadcasts. CR: without `@ccs/canvas` exporting its
 *     `CanvasFrameRecord[]` state, this is a small INDEPENDENT tracker
 *     (not a re-implementation of P1/P2's iframe/hit-test machinery) —
 *     good enough for a page list, not authoritative for canvas geometry.
 */

export interface FrameSummary {
  fileFolder: string;
  framePath: string;
  name: string;
}

/** FP-INS-b: `requestReadSource`'s resolved outcome — a plain discriminated
 * result (mirrors `@ccs/canvas`'s `EnterTextEditResult` pattern) rather than
 * a rejected promise, since "the daemon said no" (unknown file-folder,
 * containment-rejected path, uid not found, timeout) is an ordinary,
 * expected outcome for the Inspect tab to render as "unavailable", not an
 * exceptional one. */
export type ReadSourceOutcome = { ok: true; source: string } | { ok: false; reason: string };

export interface DaemonConnectionValue {
  connected: boolean;
  daemonPort: number | null;
  frames: FrameSummary[];
  sendOp: (op: CanvasOp) => string;
  sendUndo: (fileFolder: string) => void;
  sendRedo: (fileFolder: string) => void;
  /** Subscribes to every classified `DaemonEvent` broadcast on this
   * connection (e.g. so a panel can react to `op-rejected`). Returns an
   * unsubscribe function. */
  onEvent: (listener: (event: DaemonEvent) => void) => () => void;
  /** FP-INS-b (Inspect / code tab) — additive, READ-ONLY: requests the whole
   * frame's source (`uid` omitted) or one node's JSX slice (`uid` present)
   * from the daemon's `read-source` control message, resolving once the
   * matching `read-source-result`/`control-error` reply arrives (or a local
   * timeout elapses, so a stuck/disconnected daemon can never hang the
   * Inspect tab forever). */
  requestReadSource: (fileFolder: string, framePath: string, uid?: string) => Promise<ReadSourceOutcome>;
}

/** Bound on how long `requestReadSource` waits for a daemon reply — mirrors
 * `@ccs/canvas`'s `CREATE_FRAME_TIMEOUT_MS` bound for the same reason (a
 * stuck daemon/connection should surface as an error, not hang forever). */
const READ_SOURCE_TIMEOUT_MS = 10_000;

const DaemonConnectionContext = React.createContext<DaemonConnectionValue | null>(null);

function deriveFileFolder(projectRelativePath: string): string | null {
  // Matches the convention every other package in this monorepo uses:
  // "files/<folder>/..." — the daemon always roots frame paths there.
  const match = /^files\/([^/]+)\//.exec(projectRelativePath);
  return match?.[1] ?? null;
}

function frameNameFromPath(path: string): string | null {
  const match = /\/([^/]+)\.tsx$/.exec(path);
  return match?.[1] ?? null;
}

/** Strips the `files/<fileFolder>/` prefix so `FrameSummary.framePath`
 * matches the FILE-FOLDER-relative convention every other path in this
 * codebase uses (`FrameEntry.framePath`, `NodeUid`'s relPath half — ADR-
 * 0012/0013), NOT the project-root-relative shape `ProjectInfo.frames[]`
 * arrives in (`project-info.ts`'s own doc: "files/demo/src/frames/Hero.tsx"
 * — project-root-relative because one daemon spans multiple file-folders). */
function toFileFolderRelative(fileFolder: string, projectRelativePath: string): string {
  const prefix = `files/${fileFolder}/`;
  return projectRelativePath.startsWith(prefix) ? projectRelativePath.slice(prefix.length) : projectRelativePath;
}

export function DaemonConnectionProvider({
  daemonUrl,
  children,
}: {
  daemonUrl: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [connected, setConnected] = React.useState(false);
  const [daemonPort, setDaemonPort] = React.useState<number | null>(null);
  const [frames, setFrames] = React.useState<FrameSummary[]>([]);
  const clientRef = React.useRef<OpsClient | null>(null);
  const listenersRef = React.useRef<Set<(event: DaemonEvent) => void>>(new Set());
  // FP-INS-b: pending `read-source` requests, keyed by `requestId` —
  // resolved from `handleControlReply` below (`read-source-result` on
  // success, `control-error` on failure), same correlation pattern
  // `@ccs/canvas`'s `pendingGetCanvasJsonRef` uses for `get-canvas-json`.
  const pendingReadSourceRef = React.useRef<Map<string, (result: ReadSourceOutcome) => void>>(new Map());

  React.useEffect(() => {
    let cancelled = false;

    function handleProjectInfo(info: ProjectInfo): void {
      if (cancelled) return;
      setDaemonPort(info.daemonPort);
      setFrames(
        info.frames.flatMap((f) => {
          const fileFolder = deriveFileFolder(f.framePath);
          return fileFolder
            ? [{ fileFolder, framePath: toFileFolderRelative(fileFolder, f.framePath), name: f.name }]
            : [];
        }),
      );
    }

    function handleEvent(event: DaemonEvent): void {
      if (cancelled) return;
      for (const listener of listenersRef.current) listener(event);
      if (event.t !== 'file-changed') return;
      const fileFolder = deriveFileFolder(event.file);
      const name = frameNameFromPath(event.file);
      if (!fileFolder || !name || !event.file.includes('/frames/')) return;
      setFrames((prev) => {
        if (prev.some((f) => f.fileFolder === fileFolder && f.name === name)) return prev;
        const relPath = toFileFolderRelative(fileFolder, event.file);
        return [...prev, { fileFolder, framePath: relPath, name }];
      });
    }

    function handleControlReply(reply: ControlReply): void {
      if (reply.kind === 'read-source-result') {
        const resolve = pendingReadSourceRef.current.get(reply.requestId);
        if (!resolve) return; // stale/unmatched reply (e.g. after unmount) — ignore
        pendingReadSourceRef.current.delete(reply.requestId);
        resolve({ ok: true, source: reply.source });
        return;
      }
      if (reply.kind === 'control-error') {
        const resolve = pendingReadSourceRef.current.get(reply.requestId);
        if (!resolve) return; // could be some OTHER pending request kind this connection doesn't track yet
        pendingReadSourceRef.current.delete(reply.requestId);
        resolve({ ok: false, reason: reply.reason });
      }
    }

    const client = connectOpsClient(daemonUrl, {
      onProjectInfo: handleProjectInfo,
      onEvent: handleEvent,
      onControlReply: handleControlReply,
      onOpen: () => !cancelled && setConnected(true),
      onClose: () => !cancelled && setConnected(false),
    });
    clientRef.current = client;

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
    };
  }, [daemonUrl]);

  const value = React.useMemo<DaemonConnectionValue>(
    () => ({
      connected,
      daemonPort,
      frames,
      sendOp: (op) => {
        if (!clientRef.current) throw new Error('@ccs/studio: not connected to the daemon yet');
        return clientRef.current.sendOp(op);
      },
      sendUndo: (fileFolder) => clientRef.current?.sendUndo(fileFolder),
      sendRedo: (fileFolder) => clientRef.current?.sendRedo(fileFolder),
      onEvent: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      requestReadSource: (fileFolder, framePath, uid) => {
        const client = clientRef.current;
        if (!client) return Promise.resolve({ ok: false, reason: 'not connected to the daemon yet' });
        const requestId = client.sendReadSource(fileFolder, framePath, uid);
        return new Promise<ReadSourceOutcome>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingReadSourceRef.current.delete(requestId)) {
              resolve({ ok: false, reason: 'timed out waiting for the daemon' });
            }
          }, READ_SOURCE_TIMEOUT_MS);
          pendingReadSourceRef.current.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
        });
      },
    }),
    [connected, daemonPort, frames],
  );

  return <DaemonConnectionContext.Provider value={value}>{children}</DaemonConnectionContext.Provider>;
}

export function useDaemonConnection(): DaemonConnectionValue {
  const ctx = React.useContext(DaemonConnectionContext);
  if (!ctx) throw new Error('@ccs/studio: useDaemonConnection must be used within a DaemonConnectionProvider');
  return ctx;
}
