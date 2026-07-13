import { join } from 'node:path';
import type { CanvasOp, DaemonEvent, ProjectInfo } from '@ccs/protocol';
import { reconcileCanvasJson } from './canvas-json.js';
import { createGeometryWriter, type GeometryUpdate } from './geometry.js';
import { FileOpQueue } from './file-op-queue.js';
import { toProjectRelative } from './paths.js';
import { allocatePort } from './port-pool.js';
import { scanProject, type FileFolder } from './scan.js';
import { createControlServer, type ControlServerHandle, type SetGeometryRequest } from './ws-server.js';
import { startViteServer, type ViteServerHandle } from './vite-orchestrator.js';
import { watchCanvasJson, watchDesignSystem, watchFrameFiles, type WatchHandle } from './watcher.js';
import {
  removeDaemonCoordFile,
  writeDaemonCoordFile,
  type DaemonCoordFileFileFolder,
} from './coord-file.js';

/**
 * `openProject` — the sync-daemon entry point (playbook §4/P1, ADR-0012).
 * Scans `files/*\/src/frames/*.tsx`, reconciles each file-folder's
 * `.studio/canvas.json`, boots one Vite dev server per file-folder from a
 * 5200+ port pool, starts the localhost-only control websocket, wires up
 * chokidar watchers, and writes the `.studio/daemon.json` runtime
 * coordination file. Returns a `DaemonHandle` the caller (studio app, or
 * this package's own tests/demo) uses to drive geometry writes and to shut
 * everything down cleanly.
 */

const DEFAULT_FRAME_SERVER_PORT_START = 5200;
const DEFAULT_DAEMON_PORT_START = 4700;
const DEFAULT_GEOMETRY_DEBOUNCE_MS = 250;

export interface StartViteServerFn {
  (options: { cwd: string; port: number }): Promise<ViteServerHandle>;
}

export interface OpenProjectOptions {
  projectRoot: string;
  /** Fixed control-ws port; if omitted, allocated from
   * `daemonPortStart` (default 4700). */
  daemonPort?: number;
  daemonPortStart?: number;
  /** Fixed starting point for the per-file-folder Vite server port pool
   * (default 5200, per playbook §4/P1). */
  frameServerPortStart?: number;
  /** Injectable Vite starter — tests substitute a lightweight fake so
   * wiring can be verified without spawning real dev servers. Defaults to
   * the real `startViteServer`. */
  startVite?: StartViteServerFn;
  geometryDebounceMs?: number;
}

export interface DaemonFileFolder {
  name: string;
  root: string;
  port: number;
  devServerUrl: string;
  frameNames: string[];
}

export interface DaemonHandle {
  projectRoot: string;
  daemonPort: number;
  fileFolders: DaemonFileFolder[];
  /** Send a `DaemonEvent` to every connected control-ws client. Exposed
   * mainly for tests/tools; the daemon itself broadcasts on FS events. */
  broadcast(event: DaemonEvent): void;
  connectedClientCount(): number;
  /** The debounced geometry write API (playbook §4/P1 step 6), callable
   * directly (in-process) in addition to over the control ws. */
  writeGeometry(fileFolderName: string, framePath: string, geometry: GeometryUpdate): Promise<void>;
  /** Clean shutdown: stops watchers, closes the control ws, kills every
   * child Vite process, flushes pending geometry writes, and removes the
   * `.studio/daemon.json` coordination file. */
  close(): Promise<void>;
}

export async function openProject(options: OpenProjectOptions): Promise<DaemonHandle> {
  const projectRoot = options.projectRoot;
  const scanned = await scanProject(projectRoot);

  for (const fileFolder of scanned) {
    await reconcileCanvasJson(fileFolder.root, fileFolder.frames);
  }

  const takenPorts = new Set<number>();
  const daemonPort =
    options.daemonPort ?? (await allocatePort(options.daemonPortStart ?? DEFAULT_DAEMON_PORT_START, takenPorts));
  takenPorts.add(daemonPort);

  const startVite: StartViteServerFn =
    options.startVite ?? ((o) => startViteServer({ cwd: o.cwd, port: o.port }));

  const viteHandles: ViteServerHandle[] = [];
  const fileFolders: DaemonFileFolder[] = [];
  let portCursor = options.frameServerPortStart ?? DEFAULT_FRAME_SERVER_PORT_START;

  for (const fileFolder of scanned) {
    const port = await allocatePort(portCursor, takenPorts);
    takenPorts.add(port);
    portCursor = port + 1;

    const handle = await startVite({ cwd: fileFolder.root, port });
    viteHandles.push(handle);
    fileFolders.push({
      name: fileFolder.name,
      root: fileFolder.root,
      port,
      devServerUrl: handle.url,
      frameNames: fileFolder.frames.map((f) => f.name),
    });
  }

  const scannedByName = new Map(scanned.map((f) => [f.name, f] as const));

  function buildBootstrap(): ProjectInfo {
    const frames: ProjectInfo['frames'] = [];
    for (const ff of fileFolders) {
      const scannedFileFolder = scannedByName.get(ff.name);
      if (!scannedFileFolder) continue;
      for (const frame of scannedFileFolder.frames) {
        frames.push({
          framePath: toProjectRelative(projectRoot, frame.absPath),
          name: frame.name,
          devServerUrl: `${ff.devServerUrl}/?frame=${encodeURIComponent(frame.name)}`,
        });
      }
    }
    return { frames, daemonPort };
  }

  const fileOpQueue = new FileOpQueue();
  const geometryWriter = createGeometryWriter({
    debounceMs: options.geometryDebounceMs ?? DEFAULT_GEOMETRY_DEBOUNCE_MS,
    onWritten: (fileFolderRoot) => {
      control.broadcast({
        t: 'file-changed',
        file: toProjectRelative(projectRoot, join(fileFolderRoot, '.studio', 'canvas.json')),
      });
    },
  });

  function resolveFileFolder(name: string): DaemonFileFolder | undefined {
    return fileFolders.find((f) => f.name === name);
  }

  function handleCanvasOp(op: CanvasOp, opId: string): void {
    const file = fileFromCanvasOp(op);
    void fileOpQueue.enqueue(file, async () => {
      // P1 scope: AST write-back is Phase 3 (playbook §4/P3). The daemon
      // queues + serializes per file (real, load-bearing behavior) but
      // does not touch source files yet — it answers every op with the
      // explicitly-sanctioned stub rejection (ADR-0012 / playbook §4/P1
      // step 3: "in P1 the daemon may no-op/echo ops").
      control.broadcast({ t: 'op-rejected', opId, reason: 'ast-engine P3' });
    });
  }

  function handleSetGeometry(request: SetGeometryRequest): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) return;
    void geometryWriter.schedule(fileFolder.root, request.framePath, {
      x: request.x,
      y: request.y,
      w: request.w,
      h: request.h,
    });
  }

  const control: ControlServerHandle = createControlServer({
    port: daemonPort,
    getBootstrap: buildBootstrap,
    onCanvasOp: handleCanvasOp,
    onSetGeometry: handleSetGeometry,
  });

  const watchHandles: WatchHandle[] = [];
  for (const fileFolder of fileFolders) {
    watchHandles.push(watchFrameFiles(projectRoot, fileFolder.root, (e) => control.broadcast(e)));
    watchHandles.push(watchCanvasJson(projectRoot, fileFolder.root, (e) => control.broadcast(e)));
  }
  watchHandles.push(watchDesignSystem(projectRoot, (e) => control.broadcast(e)));

  const coordFileFolders: DaemonCoordFileFileFolder[] = fileFolders.map((ff, i) => {
    const viteHandle = viteHandles[i];
    return { name: ff.name, port: ff.port, pid: viteHandle ? viteHandle.pid : -1 };
  });
  await writeDaemonCoordFile(projectRoot, {
    daemonPort,
    pid: process.pid,
    fileFolders: coordFileFolders,
    startedAt: new Date().toISOString(),
  });

  return {
    projectRoot,
    daemonPort,
    fileFolders,
    broadcast: (event) => control.broadcast(event),
    connectedClientCount: () => control.clientCount(),
    async writeGeometry(fileFolderName, framePath, geometry) {
      const fileFolder = resolveFileFolder(fileFolderName);
      if (!fileFolder) {
        throw new Error(`@ccs/sync-daemon: unknown file-folder "${fileFolderName}"`);
      }
      await geometryWriter.schedule(fileFolder.root, framePath, geometry);
    },
    async close() {
      await geometryWriter.flushAll();
      for (const watchHandle of watchHandles) await watchHandle.close();
      await control.close();
      for (const viteHandle of viteHandles) await viteHandle.stop();
      await removeDaemonCoordFile(projectRoot);
    },
  };
}

function fileFromCanvasOp(op: CanvasOp): string {
  let uid: string | undefined;
  if ('uid' in op) {
    uid = op.uid;
  } else if ('parentUid' in op) {
    uid = op.parentUid;
  } else if ('uids' in op) {
    uid = op.uids[0];
  }
  if (!uid) return 'unknown';
  const idx = uid.indexOf('.tsx:');
  return idx === -1 ? uid : uid.slice(0, idx + 4);
}

export type { FileFolder };
