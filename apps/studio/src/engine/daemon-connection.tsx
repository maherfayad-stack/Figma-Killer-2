import * as React from 'react';
import type { CanvasOp, DaemonEvent, ProjectInfo } from '@ccs/protocol';
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
}

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

    const client = connectOpsClient(daemonUrl, {
      onProjectInfo: handleProjectInfo,
      onEvent: handleEvent,
      onControlReply: () => {},
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
