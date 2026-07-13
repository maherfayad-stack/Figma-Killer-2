/**
 * packages/sync-daemon — per-project Node daemon: boots one Vite dev
 * server per file-folder, exposes a localhost-only control ws speaking
 * `@ccs/protocol` (CanvasOp in, DaemonEvent out, ProjectInfo bootstrap),
 * watches `.studio/canvas.json` + frame dirs + `design-system/**` with
 * chokidar, and owns the debounced geometry-write API. Scope: Phase 1
 * (playbook §4/P1). AST write-back (op-queue actually mutating source) is
 * Phase 3; git checkpoint commits are a later phase.
 */
export { openProject } from './daemon.js';
export type {
  DaemonHandle,
  DaemonFileFolder,
  OpenProjectOptions,
  StartViteServerFn,
} from './daemon.js';

export { scanProject } from './scan.js';
export type { FileFolder, FrameFile } from './scan.js';

export {
  readCanvasJson,
  writeCanvasJsonAtomic,
  syncFrameEntries,
  frameMetaEquals,
  reconcileCanvasJson,
} from './canvas-json.js';

export { allocatePort, isPortFree } from './port-pool.js';

export { startViteServer } from './vite-orchestrator.js';
export type { ViteServerHandle, StartViteServerOptions } from './vite-orchestrator.js';

export { watchFrameFiles, watchCanvasJson, watchDesignSystem } from './watcher.js';
export type { WatchHandle } from './watcher.js';

export { createControlServer } from './ws-server.js';
export type {
  ControlServerHandle,
  ControlServerOptions,
  ClientMessage,
  SetGeometryRequest,
} from './ws-server.js';

export { createGeometryWriter } from './geometry.js';
export type { GeometryWriter, GeometryWriterOptions, GeometryUpdate } from './geometry.js';

export { writeDaemonCoordFile, readDaemonCoordFile, removeDaemonCoordFile } from './coord-file.js';
export type { DaemonCoordFile, DaemonCoordFileFileFolder } from './coord-file.js';

export { FileOpQueue } from './file-op-queue.js';
export { toProjectRelative } from './paths.js';
