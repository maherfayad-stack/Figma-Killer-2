import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CanvasOp,
  CreateFrameRequest,
  CreateTokenRequest,
  DaemonEvent,
  DeleteTokenRequest,
  DuplicateFrameRequest,
  GetCanvasJsonRequest,
  NodeUid,
  ProjectInfo,
  ReadSourceRequest,
  RedoRequest,
  SetTokenRequest,
  UndoRequest,
} from '@ccs/protocol';
import { getNodeSource, type InverseOp } from '@ccs/ast-engine';
import { reconcileCanvasJson, readCanvasJson } from './canvas-json.js';
import { createFrameOnDisk } from './create-frame.js';
import { duplicateFrameOnDisk } from './duplicate-frame.js';
import { createGeometryWriter, type GeometryUpdate } from './geometry.js';
import { FileOpQueue } from './file-op-queue.js';
import { toFileFolderRelative, toProjectRelative } from './paths.js';
import { createTreeSnapshotStore } from './tree-snapshot.js';
import { allocatePort } from './port-pool.js';
import { scanProject, type FileFolder } from './scan.js';
import { resolveContainedPath } from './safe-path.js';
import {
  createControlServer,
  type ControlServerHandle,
  type ReplyFn,
  type SetGeometryRequest,
} from './ws-server.js';
import { startViteServer, type ViteServerHandle } from './vite-orchestrator.js';
import { writeStudioViteConfig } from './studio-vite-config.js';
import {
  watchCanvasJson,
  watchDesignSystem,
  watchFrameFiles,
  type WatchHandle,
} from './watcher.js';
import {
  removeDaemonCoordFile,
  writeDaemonCoordFile,
  type DaemonCoordFileFileFolder,
} from './coord-file.js';
import { SelfWriteTracker } from './self-write-tracker.js';
import { UndoRedoManager, type UndoEntry } from './undo-stack.js';
import { CheckpointScheduler, ensureFileFolderGitRepo } from './git-checkpoint.js';
import {
  applyCanvasOpToDisk,
  applyForwardOpToDisk,
  applyInverseOpToDisk,
  relPathFromCanvasOp,
  summarizeCanvasOp,
} from './op-apply.js';
import { applyTokenCrud, type TokenCrudRequest } from './token-crud.js';
import { rebuildTokenOutputs, tokensJsPath } from './token-rebuild.js';

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
/** git checkpoint cadence (playbook §4/P3, ADR-0018 item 11): commit every
 * N applied ops, or after this many ms of idle — whichever comes first. */
const DEFAULT_CHECKPOINT_EVERY_N_OPS = 20;
const DEFAULT_CHECKPOINT_IDLE_MS = 30_000;

export interface StartViteServerFn {
  (options: { cwd: string; port: number; studioConfigPath?: string }): Promise<ViteServerHandle>;
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
  /** P5 `tree-snapshot` debounce (default 150ms) — overridable so tests
   * don't have to wait through the default window. */
  treeSnapshotDebounceMs?: number;
  /** ADR-0016 addendum / P2 WS-A daemon boot hook: when `true`, every
   * file-folder's Vite dev server boots with a daemon-generated studio
   * config (`writeStudioViteConfig`) layering the source-uid plugin +
   * bridge injection on top of that file-folder's OWN `vite.config.ts` —
   * WITHOUT the file-folder ever depending on any `@ccs/*` package (P0
   * standalone contract). Defaults to `false`: a plain `openProject` call
   * boots every file-folder exactly as P1 always has (no `@ccs/*`
   * involvement at all), preserving that contract by construction rather
   * than by convention. */
  studioMode?: boolean;
  /** P3 git-checkpoint tuning (default 20 ops / 30s idle) — overridable so
   * tests/integration harnesses don't have to wait 30 real seconds. */
  checkpointEveryNOps?: number;
  checkpointIdleMs?: number;
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
    options.daemonPort ??
    (await allocatePort(options.daemonPortStart ?? DEFAULT_DAEMON_PORT_START, takenPorts));
  takenPorts.add(daemonPort);

  const startVite: StartViteServerFn =
    options.startVite ??
    ((o) =>
      startViteServer({
        cwd: o.cwd,
        port: o.port,
        ...(o.studioConfigPath !== undefined ? { studioConfigPath: o.studioConfigPath } : {}),
      }));

  const viteHandles: ViteServerHandle[] = [];
  const fileFolders: DaemonFileFolder[] = [];
  let portCursor = options.frameServerPortStart ?? DEFAULT_FRAME_SERVER_PORT_START;

  for (const fileFolder of scanned) {
    const port = await allocatePort(portCursor, takenPorts);
    takenPorts.add(port);
    portCursor = port + 1;

    const studioConfigPath = options.studioMode
      ? await writeStudioViteConfig({
          projectRoot,
          fileFolderRoot: fileFolder.root,
          fileFolderName: fileFolder.name,
        })
      : undefined;

    const handle = await startVite({
      cwd: fileFolder.root,
      port,
      ...(studioConfigPath !== undefined ? { studioConfigPath } : {}),
    });
    viteHandles.push(handle);
    fileFolders.push({
      name: fileFolder.name,
      root: fileFolder.root,
      port,
      devServerUrl: handle.url,
      frameNames: fileFolder.frames.map((f) => f.name),
    });
  }

  // P3 (playbook §4/P3, ADR-0018 items 9/11): self-write suppression, the
  // per-file-folder undo/redo stack, and per-file-folder git checkpoint
  // schedulers. Each file-folder gets its OWN nested git repo (`git init`
  // if absent) + a managed `.gitignore` right at project-open, so the
  // very first canvas op already has somewhere to check into.
  const selfWriteTracker = new SelfWriteTracker();
  const undoManager = new UndoRedoManager();
  const checkpointSchedulers = new Map<string, CheckpointScheduler>();
  for (const fileFolder of fileFolders) {
    await ensureFileFolderGitRepo(fileFolder.root);
    checkpointSchedulers.set(
      fileFolder.name,
      new CheckpointScheduler(fileFolder.root, {
        everyNOps: options.checkpointEveryNOps ?? DEFAULT_CHECKPOINT_EVERY_N_OPS,
        idleMs: options.checkpointIdleMs ?? DEFAULT_CHECKPOINT_IDLE_MS,
      }),
    );
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

  /**
   * P5 resume item 1 (STATE.md "P5 RESUME HERE", `tree-snapshot.ts`): the
   * live-tree cache + debouncer. `onRecomputed` references `control`
   * before it's assigned below — safe, same forward-reference-via-closure
   * pattern `geometryWriter.onWritten` already relies on (the callback
   * only ever RUNS after a debounce timer fires, by which point `control`
   * is long since assigned; JS closures capture the binding, not a
   * snapshotted value).
   */
  const treeSnapshotStore = createTreeSnapshotStore({
    onRecomputed: (event) => control.broadcast(event),
    ...(options.treeSnapshotDebounceMs !== undefined ? { debounceMs: options.treeSnapshotDebounceMs } : {}),
  });
  // Populate the cache for every frame ALREADY on disk at project-open
  // (playbook brief: "on project open (per frame)") — so a client that
  // connects before any edit happens still gets every frame's current
  // tree via `getInitialEvents` right after the bootstrap `ProjectInfo`,
  // rather than only discovering it after the next edit/HMR event.
  for (const fileFolder of scanned) {
    for (const frame of fileFolder.frames) {
      await treeSnapshotStore.computeAndCache(frame.absPath, frame.framePath);
    }
  }

  function resolveFileFolder(name: string): DaemonFileFolder | undefined {
    return fileFolders.find((f) => f.name === name);
  }

  const CANVAS_OP_TYPES = new Set<CanvasOp['t']>([
    'set-text',
    'set-prop',
    'set-classes',
    'insert-node',
    'delete-node',
    'move-node',
    'wrap-node',
  ]);
  /** `InverseOp` (ast-engine-owned, ADR-0019 CR2) is a strict SUPERSET of
   * `CanvasOp` — `restore-node`/`unwrap-node` have no wire representation.
   * The frozen `op-applied` DaemonEvent's `inverse` field is typed
   * `CanvasOp[]` (protocol/events.ts), so only the 5/7 op kinds that
   * invert as themselves can be surfaced there; the other 2 still get a
   * real undo via the daemon's OWN stack (`undoManager`), just not a
   * client-visible preview of what undo would do. */
  function isCanvasOp(inverseOp: InverseOp): inverseOp is CanvasOp {
    return CANVAS_OP_TYPES.has(inverseOp.t as CanvasOp['t']);
  }

  /** ast-engine's `ApplyOpResult.uidRemap` is typed as a plain
   * `Record<string, string>` (a pure library — it has no reason to import
   * the wire-level `NodeUid` brand); the frozen `UidRemapEventSchema.map`
   * requires `Record<NodeUid, NodeUid>`. Every key/value ast-engine
   * produces is already `<relPath>:<astPath>`-shaped by construction, so
   * this is a type-level bridge, not a runtime transformation. */
  function toNodeUidMap(map: Record<string, string>): Record<NodeUid, NodeUid> {
    return map as Record<NodeUid, NodeUid>;
  }

  /**
   * P3 CR (ws-server.ts module doc): `NodeUid`/`CanvasOp` only carry a
   * FILE-FOLDER-relative path — the ADR-0013-frozen `canvas-op` envelope
   * never carried the file-folder segment itself, which is unambiguous
   * with exactly one file-folder but not with several. Prefers an
   * explicit `fileFolder` (unambiguous, O(1)); falls back to an on-disk
   * search across every known file-folder for the op's relPath, erroring
   * on zero or multiple matches rather than silently guessing.
   *
   * AUDIT-6 BLOCKER fix (playbook §5.8): `relPath` is attacker-controlled
   * (it's derived from the uid embedded in an incoming `CanvasOp`), so
   * EVERY branch below runs it through the shared `resolveContainedPath`
   * containment check (`safe-path.ts`) before it's ever joined into a
   * filesystem path — a `..`-traversal or absolute relPath is rejected
   * HERE, before any `existsSync`/read/write is attempted, rather than
   * relying on `existsSync` (which checks existence, not containment) or
   * on the write boundary alone to catch it.
   */
  function resolveFileFolderForOp(
    op: CanvasOp,
    explicitFileFolder?: string,
  ): { fileFolder: DaemonFileFolder; relPath: string; absPath: string } | { error: string } {
    const relPath = relPathFromCanvasOp(op);

    if (explicitFileFolder) {
      const fileFolder = resolveFileFolder(explicitFileFolder);
      if (!fileFolder) return { error: `unknown file-folder "${explicitFileFolder}"` };
      const safe = resolveContainedPath(fileFolder.root, relPath);
      if (!safe.ok) return { error: `invalid path: ${safe.reason}` };
      return { fileFolder, relPath, absPath: safe.absPath };
    }

    const candidates: Array<{ fileFolder: DaemonFileFolder; absPath: string }> = [];
    for (const ff of fileFolders) {
      const safe = resolveContainedPath(ff.root, relPath);
      if (safe.ok && existsSync(safe.absPath)) candidates.push({ fileFolder: ff, absPath: safe.absPath });
    }
    if (candidates.length === 0) return { error: `no file-folder contains "${relPath}"` };
    if (candidates.length > 1) {
      return {
        error: `ambiguous file-folder for "${relPath}" across [${candidates.map((c) => c.fileFolder.name).join(', ')}] — pass fileFolder explicitly in the canvas-op message`,
      };
    }
    return { fileFolder: candidates[0]!.fileFolder, relPath, absPath: candidates[0]!.absPath };
  }

  /**
   * The P3 write-through path (playbook §4/P3, ADR-0018): resolve which
   * file-folder/file the op targets, then run the actual `applyOp` +
   * atomic-write + concurrent-edit-guard INSIDE that file's `FileOpQueue`
   * slot (ADR-0019 CR1 watch: `applyOp` briefly blocks via
   * `Atomics.wait` for the embedded-prettier worker thread — running it
   * here, one file-queue-slot at a time, is what keeps that blocking
   * bounded and serialized rather than piling up across concurrent ops on
   * DIFFERENT files, which still proceed independently).
   */
  function handleCanvasOp(op: CanvasOp, opId: string, explicitFileFolder?: string): void {
    const resolved = resolveFileFolderForOp(op, explicitFileFolder);
    if ('error' in resolved) {
      control.broadcast({ t: 'op-rejected', opId, reason: resolved.error });
      return;
    }
    const { fileFolder, relPath, absPath: absFilePath } = resolved;

    void fileOpQueue.enqueue(absFilePath, async () => {
      const result = await applyCanvasOpToDisk(fileFolder.root, op, selfWriteTracker);
      if (!result.ok) {
        control.broadcast({ t: 'op-rejected', opId, reason: result.reason });
        return;
      }

      undoManager.recordApplied(fileFolder.name, {
        absFilePath: result.absFilePath,
        relPath: result.relPath,
        forwardOp: op,
        inverseOp: result.extra.inverseOp,
      });

      const projectRelFile = toProjectRelative(projectRoot, absFilePath);
      // Explicit broadcast from the write-through path itself — paired
      // with `uid-remap` below — NOT a re-discovery via the fs watcher
      // (which self-write-suppresses this exact write, see watcher.ts).
      control.broadcast({ t: 'file-changed', file: projectRelFile });
      control.broadcast({ t: 'hmr-update', file: projectRelFile });
      if (Object.keys(result.extra.uidRemap).length > 0) {
        // ADR-0018 item 5: file-folder-relative, NOT project-relative.
        control.broadcast({ t: 'uid-remap', file: relPath, map: toNodeUidMap(result.extra.uidRemap) });
      }
      control.broadcast({
        t: 'op-applied',
        opId,
        inverse: isCanvasOp(result.extra.inverseOp) ? [result.extra.inverseOp] : [],
      });

      // P5 (`tree-snapshot.ts`): an op-driven write self-write-suppresses
      // the watcher's OWN tree-snapshot trigger (same reason it suppresses
      // file-changed/hmr-update re-discovery, see watcher-wiring below) —
      // schedule the recompute explicitly here so the LayersPanel still
      // updates after an Inspector-driven edit, not just a raw IDE edit.
      treeSnapshotStore.scheduleRecompute(absFilePath, relPath);

      checkpointSchedulers.get(fileFolder.name)?.noteOp(summarizeCanvasOp(op));
    });
  }

  /**
   * Undo/redo (ADR-0018 item 9, additive `undo`/`redo` control requests —
   * `packages/protocol/src/control-messages.ts`). Peeks the top-of-stack
   * entry first (without popping) purely to learn WHICH file it targets,
   * so the actual pop + apply can run inside that file's `FileOpQueue`
   * slot — serialized against any canvas-op racing the same file. If
   * nothing pops out from under us in the meantime the peeked entry and
   * the popped one are the same; if a queued canvas-op landed first and
   * changed the top of stack, the freshly-popped entry (re-read inside
   * the queue) is still the correct one to undo.
   */
  function handleUndo(request: UndoRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({ kind: 'control-error', requestId: request.requestId, reason: `unknown file-folder "${request.fileFolder}"` });
      return;
    }
    const peeked = undoManager.peekUndo(fileFolder.name);
    if (!peeked) {
      reply({ kind: 'undo-result', requestId: request.requestId, fileFolder: fileFolder.name, applied: false, file: null });
      return;
    }

    void fileOpQueue.enqueue(peeked.absFilePath, async () => {
      const entry = undoManager.popUndo(fileFolder.name);
      if (!entry) {
        reply({ kind: 'undo-result', requestId: request.requestId, fileFolder: fileFolder.name, applied: false, file: null });
        return;
      }

      const result = await applyInverseOpToDisk(entry.absFilePath, entry.inverseOp, selfWriteTracker);
      if (!result.ok) {
        undoManager.pushUndo(fileFolder.name, entry); // preserve history — never lose it on a failed attempt
        reply({
          kind: 'undo-result',
          requestId: request.requestId,
          fileFolder: fileFolder.name,
          applied: false,
          file: null,
          reason: result.reason,
        });
        return;
      }

      undoManager.pushRedo(fileFolder.name, entry);
      broadcastAfterUndoRedo(entry, result.extra.uidRemap);
      reply({
        kind: 'undo-result',
        requestId: request.requestId,
        fileFolder: fileFolder.name,
        applied: true,
        file: toProjectRelative(projectRoot, entry.absFilePath),
      });
      checkpointSchedulers.get(fileFolder.name)?.noteOp(`undo ${summarizeCanvasOp(entry.forwardOp)}`);
    });
  }

  function handleRedo(request: RedoRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({ kind: 'control-error', requestId: request.requestId, reason: `unknown file-folder "${request.fileFolder}"` });
      return;
    }
    const peeked = undoManager.peekRedo(fileFolder.name);
    if (!peeked) {
      reply({ kind: 'redo-result', requestId: request.requestId, fileFolder: fileFolder.name, applied: false, file: null });
      return;
    }

    void fileOpQueue.enqueue(peeked.absFilePath, async () => {
      const entry = undoManager.popRedo(fileFolder.name);
      if (!entry) {
        reply({ kind: 'redo-result', requestId: request.requestId, fileFolder: fileFolder.name, applied: false, file: null });
        return;
      }

      const result = await applyForwardOpToDisk(entry.absFilePath, entry.forwardOp, selfWriteTracker);
      if (!result.ok) {
        undoManager.pushRedo(fileFolder.name, entry);
        reply({
          kind: 'redo-result',
          requestId: request.requestId,
          fileFolder: fileFolder.name,
          applied: false,
          file: null,
          reason: result.reason,
        });
        return;
      }

      undoManager.pushUndo(fileFolder.name, entry);
      broadcastAfterUndoRedo(entry, result.extra.uidRemap);
      reply({
        kind: 'redo-result',
        requestId: request.requestId,
        fileFolder: fileFolder.name,
        applied: true,
        file: toProjectRelative(projectRoot, entry.absFilePath),
      });
      checkpointSchedulers.get(fileFolder.name)?.noteOp(`redo ${summarizeCanvasOp(entry.forwardOp)}`);
    });
  }

  function broadcastAfterUndoRedo(entry: UndoEntry, uidRemap: Record<string, string>): void {
    const projectRelFile = toProjectRelative(projectRoot, entry.absFilePath);
    control.broadcast({ t: 'file-changed', file: projectRelFile });
    control.broadcast({ t: 'hmr-update', file: projectRelFile });
    if (Object.keys(uidRemap).length > 0) {
      control.broadcast({ t: 'uid-remap', file: entry.relPath, map: toNodeUidMap(uidRemap) });
    }
    // Same self-write-suppression reasoning as `handleCanvasOp` above.
    treeSnapshotStore.scheduleRecompute(entry.absFilePath, entry.relPath);
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

  /** The shared queue key both ADR-0014 handlers use for one file-folder:
   * `src/frames.ts` is the one artifact every `create-frame` call mutates
   * (alongside the new source file + canvas.json), so serializing on it
   * both prevents two concurrent create-frame calls from interleaving
   * their registry reads/writes AND guarantees a `get-canvas-json` queued
   * right after a `create-frame` observes that create-frame's writes
   * rather than racing ahead of them. */
  function createFrameQueueKey(fileFolderRoot: string): string {
    return join(fileFolderRoot, 'src', 'frames.ts');
  }

  function handleCreateFrame(request: CreateFrameRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({
        kind: 'control-error',
        requestId: request.requestId,
        reason: `unknown file-folder "${request.fileFolder}"`,
      });
      return;
    }
    void fileOpQueue.enqueue(createFrameQueueKey(fileFolder.root), async () => {
      try {
        const result = await createFrameOnDisk(fileFolder.root, request.name);
        control.broadcast({
          t: 'file-changed',
          file: toProjectRelative(projectRoot, join(fileFolder.root, result.framePath)),
        });
        control.broadcast({
          t: 'file-changed',
          file: toProjectRelative(projectRoot, join(fileFolder.root, '.studio', 'canvas.json')),
        });
      } catch (err) {
        reply({
          kind: 'control-error',
          requestId: request.requestId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** ADR-0015: real file-backed frame duplication (the P1 defect fix — see
   * `duplicate-frame.ts`'s module doc). Serialized on the same
   * `createFrameQueueKey` as `create-frame`/`get-canvas-json` so the three
   * request kinds can never interleave their reads/writes of a
   * file-folder's `src/frames.ts`/`.studio/canvas.json`. */
  function handleDuplicateFrame(request: DuplicateFrameRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({
        kind: 'control-error',
        requestId: request.requestId,
        reason: `unknown file-folder "${request.fileFolder}"`,
      });
      return;
    }
    void fileOpQueue.enqueue(createFrameQueueKey(fileFolder.root), async () => {
      try {
        const result = await duplicateFrameOnDisk(
          fileFolder.root,
          request.sourceName,
          request.newName,
        );
        control.broadcast({
          t: 'file-changed',
          file: toProjectRelative(projectRoot, join(fileFolder.root, result.framePath)),
        });
        control.broadcast({
          t: 'file-changed',
          file: toProjectRelative(projectRoot, join(fileFolder.root, '.studio', 'canvas.json')),
        });
        reply({
          kind: 'duplicate-frame-result',
          requestId: request.requestId,
          fileFolder: fileFolder.name,
          sourceName: request.sourceName,
          newName: result.newName,
          framePath: result.framePath,
        });
      } catch (err) {
        reply({
          kind: 'control-error',
          requestId: request.requestId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  function handleGetCanvasJson(request: GetCanvasJsonRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({
        kind: 'control-error',
        requestId: request.requestId,
        reason: `unknown file-folder "${request.fileFolder}"`,
      });
      return;
    }
    void fileOpQueue.enqueue(createFrameQueueKey(fileFolder.root), async () => {
      try {
        const meta = await readCanvasJson(fileFolder.root);
        reply({
          kind: 'get-canvas-json-result',
          requestId: request.requestId,
          fileFolder: fileFolder.name,
          meta,
        });
      } catch (err) {
        reply({
          kind: 'control-error',
          requestId: request.requestId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * P4 token-CRUD (playbook §4/P4, ADR-0022): one shared handler for
   * `set-token`/`create-token`/`delete-token` — write via `token-crud.ts`
   * (the daemon's sole `design-system/src/tokens/tokens.js` write path),
   * then immediately run the SAME rebuild pipeline a `tokens-changed`
   * watch event triggers (`token-rebuild.ts`), then broadcast
   * `tokens-changed` once (not twice — `applyTokenCrud` marks the
   * self-write tracker so `watchDesignSystem`'s independent rediscovery of
   * this exact edit is suppressed). Serialized on the tokens.js path
   * itself via the existing `FileOpQueue` (same discipline as canvas ops:
   * concurrent token edits never interleave their read-modify-write).
   */
  function tokenCrudQueueKey(): string {
    return tokensJsPath(projectRoot);
  }

  async function handleTokenCrudRequest(
    request: SetTokenRequest | CreateTokenRequest | DeleteTokenRequest,
    reply: ReplyFn,
  ): Promise<void> {
    const crudRequest: TokenCrudRequest = {
      kind: request.kind,
      group: request.group,
      theme: request.theme,
      key: request.key,
      ...('value' in request ? { value: request.value } : {}),
    };
    const result = await applyTokenCrud(projectRoot, crudRequest, selfWriteTracker);
    if (!result.ok) {
      reply({ kind: 'token-write-result', requestId: request.requestId, applied: false, reason: result.reason });
      return;
    }
    const rebuildResult = await rebuildTokenOutputs(
      projectRoot,
      fileFolders.map((f) => f.root),
    );
    if (rebuildResult.ok) {
      control.broadcast({ t: 'tokens-changed' });
    }
    reply({ kind: 'token-write-result', requestId: request.requestId, applied: true });
  }

  /**
   * FP-INS-b (`.orchestrator/FEATURE-PARITY-PLAN.md` "Inspect / code tab") —
   * additive, READ-ONLY control-ws handler: the Inspect tab's "Code (JSX)"
   * section. This NEVER writes — the only fs call below is `readFile`.
   *
   * SECURITY (the hard constraint this task exists to get right — mirrors
   * `resolveFileFolderForOp`'s AUDIT-6/6b discipline exactly, reusing the
   * SAME shared containment check rather than reimplementing it): `request.
   * framePath` is attacker-controlled wire input (it arrives verbatim from
   * whatever's connected to the control-ws) and is run through the shared
   * `resolveContainedPath` (`safe-path.ts` — realpath-based, symlink-safe)
   * against `fileFolder.root` BEFORE any read is attempted. A `..`-traversal,
   * an absolute `framePath`, or a path that only escapes the root via a
   * symlink is rejected with a `control-error`, exactly like a write would
   * be — there is no separate/weaker check for this read path. The studio
   * never gets to pass a raw absolute filesystem path in: only a known
   * `fileFolder` NAME (resolved server-side against the daemon's own
   * configured roots) plus a root-relative `framePath`.
   *
   * The node-slice branch (`request.uid` present) never substring-hacks the
   * raw file text — it asks `@ccs/ast-engine`'s `getNodeSource` to reprint
   * the node from a fresh parse of the SAME source text this handler just
   * read (the identical uid <-> AST-node mapping `tree-snapshot.ts`/
   * `op-apply.ts` already rely on, ADR-0017), so a component-instance uid's
   * slice is naturally its `<Component .../>` usage code.
   */
  function handleReadSource(request: ReadSourceRequest, reply: ReplyFn): void {
    const fileFolder = resolveFileFolder(request.fileFolder);
    if (!fileFolder) {
      reply({
        kind: 'control-error',
        requestId: request.requestId,
        reason: `unknown file-folder "${request.fileFolder}"`,
      });
      return;
    }

    const safe = resolveContainedPath(fileFolder.root, request.framePath);
    if (!safe.ok) {
      reply({ kind: 'control-error', requestId: request.requestId, reason: `invalid path: ${safe.reason}` });
      return;
    }

    void (async () => {
      let sourceText: string;
      try {
        sourceText = await readFile(safe.absPath, 'utf8');
      } catch (err) {
        reply({
          kind: 'control-error',
          requestId: request.requestId,
          reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      if (!request.uid) {
        reply({
          kind: 'read-source-result',
          requestId: request.requestId,
          fileFolder: fileFolder.name,
          framePath: request.framePath,
          uid: null,
          source: sourceText,
        });
        return;
      }

      const nodeSource = getNodeSource(sourceText, request.uid);
      if (!nodeSource.ok) {
        reply({ kind: 'control-error', requestId: request.requestId, reason: nodeSource.reason });
        return;
      }
      reply({
        kind: 'read-source-result',
        requestId: request.requestId,
        fileFolder: fileFolder.name,
        framePath: request.framePath,
        uid: request.uid,
        source: nodeSource.source,
      });
    })();
  }

  function handleSetToken(request: SetTokenRequest, reply: ReplyFn): void {
    void fileOpQueue.enqueue(tokenCrudQueueKey(), () => handleTokenCrudRequest(request, reply));
  }
  function handleCreateToken(request: CreateTokenRequest, reply: ReplyFn): void {
    void fileOpQueue.enqueue(tokenCrudQueueKey(), () => handleTokenCrudRequest(request, reply));
  }
  function handleDeleteToken(request: DeleteTokenRequest, reply: ReplyFn): void {
    void fileOpQueue.enqueue(tokenCrudQueueKey(), () => handleTokenCrudRequest(request, reply));
  }

  const control: ControlServerHandle = createControlServer({
    port: daemonPort,
    getBootstrap: buildBootstrap,
    getInitialEvents: () => treeSnapshotStore.currentEvents(),
    onCanvasOp: handleCanvasOp,
    onSetGeometry: handleSetGeometry,
    onCreateFrame: handleCreateFrame,
    onGetCanvasJson: handleGetCanvasJson,
    onDuplicateFrame: handleDuplicateFrame,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSetToken: handleSetToken,
    onCreateToken: handleCreateToken,
    onDeleteToken: handleDeleteToken,
    onReadSource: handleReadSource,
  });

  const watchHandles: WatchHandle[] = [];
  for (const fileFolder of fileFolders) {
    watchHandles.push(
      watchFrameFiles(
        projectRoot,
        fileFolder.root,
        (e) => {
          control.broadcast(e);
          // P5 (`tree-snapshot.ts`): a genuine external edit (IDE, git
          // checkout, etc.) to a frame file — NOT an op-driven write (those
          // are self-write-suppressed before `emit` is even called here,
          // see `watcher.ts`'s `onEdit`, and are scheduled explicitly from
          // `handleCanvasOp`/`broadcastAfterUndoRedo` instead, so this can
          // never double-schedule the same write). Covers both in-place
          // edits (`hmr-update`) and add/remove (`file-changed` only) —
          // an add gets an initial tree computed here; a remove's
          // `computeAndCache` fails soft (ENOENT) and just evicts the
          // stale cache entry, emitting nothing.
          if (e.t === 'file-changed' || e.t === 'hmr-update') {
            const absPath = join(projectRoot, e.file);
            const relPath = toFileFolderRelative(fileFolder.root, absPath);
            treeSnapshotStore.scheduleRecompute(absPath, relPath);
          }
        },
        selfWriteTracker,
      ),
    );
    watchHandles.push(watchCanvasJson(projectRoot, fileFolder.root, (e) => control.broadcast(e)));
  }

  /**
   * P4 (playbook §4/P4, ADR-0022): an IDE edit to `design-system/src/
   * tokens/tokens.js` (as opposed to a token-CRUD control message, which
   * already rebuilds+broadcasts itself in `handleTokenCrudRequest`) is
   * only visible to the daemon via this watcher's `tokens-changed` signal
   * — run the SAME rebuild pipeline here before re-broadcasting it, and
   * only broadcast on a successful rebuild (a malformed edit mid-save
   * shouldn't tell every connected client "tokens changed" for a rebuild
   * that produced nothing new). `components-changed` has no P4 rebuild
   * step (the component catalog reads meta.ts on demand, not via a
   * daemon-pushed artifact) — broadcast it straight through, unchanged
   * from P1.
   */
  function onDesignSystemEvent(event: DaemonEvent): void {
    if (event.t !== 'tokens-changed') {
      control.broadcast(event);
      return;
    }
    void rebuildTokenOutputs(
      projectRoot,
      fileFolders.map((f) => f.root),
    ).then((result) => {
      if (result.ok) control.broadcast(event);
    });
  }
  watchHandles.push(watchDesignSystem(projectRoot, onDesignSystemEvent, selfWriteTracker));

  // Initial build (playbook §4/P4 acceptance: a fresh project boot already
  // has up-to-date `src/tokens.css` / `tokens.preset.js` in every
  // file-folder, not just after the first subsequent edit). Best-effort —
  // a project with no `design-system/` yet (or a malformed tokens.js)
  // still boots normally; `rebuildTokenOutputs` never throws.
  await rebuildTokenOutputs(
    projectRoot,
    fileFolders.map((f) => f.root),
  );

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
      treeSnapshotStore.dispose();
      await geometryWriter.flushAll();
      // Flush every file-folder's pending git checkpoint before shutting
      // down so ops applied right before close() aren't silently left
      // uncommitted (best-effort — commit() itself never throws, see
      // git-checkpoint.ts).
      for (const scheduler of checkpointSchedulers.values()) {
        await scheduler.commit();
        scheduler.dispose();
      }
      for (const watchHandle of watchHandles) await watchHandle.close();
      await control.close();
      for (const viteHandle of viteHandles) await viteHandle.stop();
      await removeDaemonCoordFile(projectRoot);
    },
  };
}

export type { FileFolder };
