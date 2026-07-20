import * as React from 'react';
import type { ComputedStyleResult } from '@ccs/bridge';
import type { ControlReply, DaemonEvent, FrameMeta, ProjectInfo } from '@ccs/protocol';
import { connectDaemon, type DaemonClient } from './daemon-client.js';
import {
  deriveFileFolderPath,
  frameNameFromPath,
  isCanvasJsonPath,
  isFrameSourcePath,
} from './daemon-protocol.js';
import { checkFrameSourceExists, originOf } from './canvas-json-client.js';
import {
  defaultGeometryForIndex,
  frameRecordId,
  removeFrameRecord,
  resyncFileFolderGeometry,
  upsertFrameRecord,
  wireProjectInfo,
  type CanvasFrameRecord,
} from './project-wiring.js';
import { createScreenshotCache, type ScreenshotCache } from './screenshot-cache.js';
import { frameSourcePath } from './new-frame.js';
import { emitUidRemap } from './selection-store.js';
import type { Box } from './geometry.js';
import {
  CREATE_FRAME_TIMEOUT_MS,
  type CreateFrameFn,
  type DuplicateFrameFn,
} from './studio-canvas-types.js';

/**
 * Sub-workstream 2d-ii (`.orchestrator/CANVAS-ENGINE-DESIGN.md`) — the
 * engine-agnostic half of what used to be one monolithic `StudioCanvas.tsx`.
 * Everything here is daemon/protocol/React-state wiring that touches ZERO
 * engine-specific API (no tldraw, no `camera-store.ts`) — see
 * `CANVAS-ENGINE-DESIGN.md`'s own enumeration of what belongs on each side
 * of this split. `TldrawEngineCanvas` and `CustomEngineCanvas` both call
 * this ONE hook and get an identical `frames`/`createFrame`/
 * `duplicateFrame`/`setFrameGeometry`/`requestComputedStyle` surface to
 * build their engine-specific `StudioCanvasHandle` around.
 *
 * Everything moved into this hook is a MECHANICAL relocation of what
 * `StudioCanvas.tsx` already did (daemon connection + event wiring, the
 * `create-frame`/`duplicate-frame`/`get-canvas-json` request/reply
 * correlation, the screenshot-cache instance, the computed-style-requester
 * ref plumbing, `setFrameGeometry`'s daemon write) — no behavior changed by
 * moving it here, just WHERE it lives.
 */

export interface UseStudioCanvasDaemonOptions {
  /** Control-ws URL, e.g. `ws://127.0.0.1:4700` (ADR-0012/0013). */
  daemonUrl: string;
  // `| undefined` explicit on all three (not just `?`) so this interface's
  // properties accept a `StudioCanvasProps`-shaped object's optional
  // fields directly under this repo's `exactOptionalPropertyTypes: true` —
  // both engine components destructure their own OWN optional props (which
  // are themselves `X | undefined` under the same setting) straight into
  // this options object, so the target type must admit `undefined`
  // explicitly, not just omission.
  onCreateFrame?: CreateFrameFn | undefined;
  onDuplicateFrame?: DuplicateFrameFn | undefined;
  /** See `StudioCanvasProps.onBridgeConnectionChange`'s doc — forwarded
   * verbatim from whichever engine's `EditModeLayer` adapter calls
   * {@link UseStudioCanvasDaemonResult.handleBridgeConnectionChange}. */
  onBridgeConnectionChange?: ((connected: boolean) => void) | undefined;
}

export interface UseStudioCanvasDaemonResult {
  frames: CanvasFrameRecord[];
  /** Shared with the tldraw path's `ScreenshotCacheContext` (unused by the
   * custom engine's `FrameShape.tsx`, which never implemented screenshot
   * capture — see `CustomEngineCanvas.tsx`'s own doc for that disclosed
   * gap). Still constructed unconditionally here since `handleEvent`'s
   * `hmr-update` branch bumps its generation regardless of which engine is
   * active — harmless, inert bookkeeping for the custom engine. */
  screenshotCache: ScreenshotCache;
  createFrame: CreateFrameFn;
  duplicateFrame: DuplicateFrameFn;
  /** The first known frame's file-folder — used by `NewFrameForm` as the
   * target file-folder for a new frame (mirrors `StudioCanvas.tsx`'s
   * original `frames[0]?.fileFolder` computation exactly). */
  defaultFileFolder: string | undefined;
  /** FIX-W4b-3a `StudioCanvasHandle.setFrameGeometry` — see that method's
   * own doc in `studio-canvas-types.ts`. Identical for both engines: writes
   * the daemon's `set-geometry` message and updates `frames` state: the
   * engine-specific `CanvasFrameRecord[] -> live shape` sync effect (each
   * engine's own, unchanged concern) then reflects the new size onto the
   * rendered frame on its own. */
  setFrameGeometry: (fileFolder: string, framePath: string, geometry: Partial<Box>) => void;
  /** The "drag/resize gesture finished, persist me" endpoint both engines'
   * own geometry-commit pub-sub subscribers call (`onFrameGeometryCommitted`
   * from `frame-shape.js` for the tldraw path, `frame-geometry-commit.js`
   * for the custom engine — two different buses with two different payload
   * shapes, see each engine file's own subscriber) — this is the ONE place
   * that turns "(fileFolder, framePath) + final box" into the real daemon
   * `set-geometry` write + `frames` state update, exactly mirroring
   * `StudioCanvas.tsx`'s original `onFrameGeometryCommitted` subscriber
   * body byte-for-byte (same `sendSetGeometry` call, same `setFrames`
   * matcher, just addressed by `(fileFolder, framePath)` instead of a
   * tldraw shape id — `frameRecordId` makes those the same lookup key). */
  commitFrameGeometry: (fileFolder: string, framePath: string, geometry: Box) => void;
  /** FP-INS-b `StudioCanvasHandle.requestComputedStyle` — stable function
   * that always reads whichever bridge connection is live AT CALL TIME (via
   * the ref `handleBridgeConnectionChange` populates), same "hand the
   * caller a lazily-resolved function" contract `StudioCanvas.tsx`'s
   * original inline closure had. */
  requestComputedStyle: (uid: string) => Promise<ComputedStyleResult>;
  /** Passed to whichever `EditModeLayer` adapter the active engine mounts
   * as its `onBridgeConnectionChange` prop — updates the
   * `requestComputedStyle` ref AND forwards a plain `connected: boolean` to
   * this hook's own `onBridgeConnectionChange` option, exactly like
   * `StudioCanvas.tsx`'s original `handleBridgeConnectionChange`. */
  handleBridgeConnectionChange: (fn: ((uid: string) => Promise<ComputedStyleResult>) | null) => void;
}

/** `createShapeId(id)` produces `shape:<id>` for the tldraw path only — this
 * hook never constructs or parses a shape id (that's `TldrawEngineCanvas`'s
 * own concern); every lookup here is keyed by `(fileFolder, framePath)` or
 * the plain `CanvasFrameRecord.id`, matching `frameRecordId`'s convention
 * (`${fileFolder}::${framePath}`) which both engines already agree on. */

/** Correlates an ADR-0014 `create-frame`/`get-canvas-json` request to its
 * `onControlReply`. Plain counter (not `crypto.randomUUID`) — this only
 * needs to be unique within one hook instance's lifetime, not globally, and
 * stays dependency-free for the dev/e2e/browser targets this module runs
 * in. */
let requestIdCounter = 0;
function nextRequestId(prefix: string): string {
  requestIdCounter += 1;
  return `${prefix}-${requestIdCounter}`;
}

export function useStudioCanvasDaemon({
  daemonUrl,
  onCreateFrame,
  onDuplicateFrame,
  onBridgeConnectionChange,
}: UseStudioCanvasDaemonOptions): UseStudioCanvasDaemonResult {
  const [frames, setFrames] = React.useState<CanvasFrameRecord[]>([]);
  const clientRef = React.useRef<DaemonClient | null>(null);
  const originByFileFolderRef = React.useRef<Map<string, string>>(new Map());
  const [screenshotCache] = React.useState(() => createScreenshotCache());

  // --- ADR-0014/0015 control-request/reply correlation -----------------
  // `get-canvas-json` resolves by `requestId` alone (direct reply carries
  // the `FrameMeta`). `create-frame` has no dedicated success reply (see
  // `daemon-client.ts`'s module doc): a `control-error` reply still
  // correlates by `requestId`, but success is only observable once the
  // resulting `file-changed` broadcast(s) land the new record in `frames`
  // state — hence tracking `fileFolder`/`framePath` per pending request too
  // (resolved by the `frames`-watching effect below, not by a reply).
  // `duplicate-frame` (ADR-0015) DOES get a dedicated success reply
  // (`duplicate-frame-result`) — the caller can't know the daemon-picked
  // `newName` in advance, so it resolves directly from that reply instead.
  const pendingGetCanvasJsonRef = React.useRef<Map<string, (meta: FrameMeta | null) => void>>(new Map());
  const pendingCreateFrameRef = React.useRef<
    Map<string, { fileFolder: string; framePath: string; resolve: () => void; reject: (err: Error) => void }>
  >(new Map());
  const pendingDuplicateFrameRef = React.useRef<
    Map<string, { resolve: () => void; reject: (err: Error) => void }>
  >(new Map());

  // FP-INS-b: the CURRENT edit-mode frame's `requestComputedStyle`, kept in
  // a ref (not React state) so `requestComputedStyle` (below) always reads
  // whichever bridge connection is live AT CALL TIME. `EditModeLayer` is the
  // sole owner of the actual bridge connection (one per edit-mode iframe);
  // this is populated/cleared via `handleBridgeConnectionChange`, which
  // whichever engine's `EditModeLayer` adapter passes down as
  // `onBridgeConnectionChange`.
  const computedStyleRequesterRef = React.useRef<((uid: string) => Promise<ComputedStyleResult>) | null>(null);
  // `onBridgeConnectionChange` is expected to be a stable callback (the
  // studio passes a `useCallback`-wrapped setter, same discipline as
  // `onReady`); read via a ref so `handleBridgeConnectionChange` itself
  // stays stable (empty dep array) and doesn't churn the caller's effect.
  const onBridgeConnectionChangeRef = React.useRef(onBridgeConnectionChange);
  React.useEffect(() => {
    onBridgeConnectionChangeRef.current = onBridgeConnectionChange;
  }, [onBridgeConnectionChange]);
  const handleBridgeConnectionChange = React.useCallback(
    (fn: ((uid: string) => Promise<ComputedStyleResult>) | null) => {
      computedStyleRequesterRef.current = fn;
      // FP-INS-b (AUDIT-FPINSb): surface the (re)connect/teardown to the
      // studio so the Inspect tab can re-run its computed-CSS fetch once the
      // bridge is actually live (a one-shot mount-time fetch otherwise races
      // a frame that only goes live after selection).
      onBridgeConnectionChangeRef.current?.(fn !== null);
    },
    [],
  );
  const requestComputedStyle = React.useCallback((uid: string): Promise<ComputedStyleResult> => {
    const fn = computedStyleRequesterRef.current;
    if (!fn) return Promise.resolve({ ok: false, reason: 'not-found' } as ComputedStyleResult);
    return fn(uid);
  }, []);

  /** ADR-0014 default `onCreateFrame`: sends `create-frame` over the real
   * control-ws connection and lets the pending-request bookkeeping above
   * settle the promise (success via the `frames`-watching effect, failure
   * via `handleControlReply`'s `control-error` branch inside the
   * daemon-connection effect). */
  const defaultCreateFrame = React.useCallback<CreateFrameFn>((request) => {
    const client = clientRef.current;
    if (!client) {
      return Promise.reject(new Error('@ccs/canvas: not connected to the daemon yet'));
    }
    const requestId = nextRequestId('create-frame');
    const framePath = frameSourcePath(request.name);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCreateFrameRef.current.delete(requestId);
        reject(
          new Error(
            `@ccs/canvas: create-frame "${request.name}" in "${request.fileFolder}" timed out waiting for the daemon`,
          ),
        );
      }, CREATE_FRAME_TIMEOUT_MS);
      pendingCreateFrameRef.current.set(requestId, {
        fileFolder: request.fileFolder,
        framePath,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      client.sendCreateFrame(request.fileFolder, request.name, requestId);
    });
  }, []);

  const createFrame = onCreateFrame ?? defaultCreateFrame;

  /** ADR-0015 default `onDuplicateFrame`: sends `duplicate-frame` over the
   * real control-ws connection. Unlike `defaultCreateFrame`, this resolves
   * directly from the dedicated `duplicate-frame-result` reply (handled in
   * `handleControlReply` below) rather than by watching `frames` state —
   * the caller doesn't know the daemon-picked `newName` in advance, so
   * there's no known `framePath` to watch for. */
  const defaultDuplicateFrame = React.useCallback<DuplicateFrameFn>((request) => {
    const client = clientRef.current;
    if (!client) {
      return Promise.reject(new Error('@ccs/canvas: not connected to the daemon yet'));
    }
    const requestId = nextRequestId('duplicate-frame');
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDuplicateFrameRef.current.delete(requestId);
        reject(
          new Error(
            `@ccs/canvas: duplicate-frame for "${request.sourceName}" in "${request.fileFolder}" timed out waiting for the daemon`,
          ),
        );
      }, CREATE_FRAME_TIMEOUT_MS);
      pendingDuplicateFrameRef.current.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      client.sendDuplicateFrame(request.fileFolder, request.sourceName, requestId);
    });
  }, []);

  const duplicateFrame = onDuplicateFrame ?? defaultDuplicateFrame;

  // Resolves pending `defaultCreateFrame` promises once the new frame's
  // `file-changed` broadcast(s) have propagated through `handleFileChanged`
  // into `frames` state — `create-frame` has no direct success reply
  // (ADR-0014), so this is the only success signal available.
  React.useEffect(() => {
    if (pendingCreateFrameRef.current.size === 0) return;
    for (const [requestId, pending] of pendingCreateFrameRef.current) {
      const created = frames.some((r) => r.fileFolder === pending.fileFolder && r.framePath === pending.framePath);
      if (created) {
        pendingCreateFrameRef.current.delete(requestId);
        pending.resolve();
      }
    }
  }, [frames]);

  // --- daemon connection + event wiring (ADR-0012/0013/0014) ----------
  React.useEffect(() => {
    let cancelled = false;

    /** Fetches a file-folder's `.studio/canvas.json` via the real
     * control-ws `get-canvas-json` request (ADR-0014) — replies come back
     * through `handleControlReply` below, correlated by `requestId`.
     * Returns `null` on any failure (unknown file-folder, not-yet-connected
     * client, `control-error` reply), mirroring how the daemon's own
     * `readCanvasJson` treats a missing file as "no geometry yet". */
    function requestCanvasJson(fileFolder: string): Promise<FrameMeta | null> {
      const client = clientRef.current;
      if (!client) return Promise.resolve(null);
      const requestId = nextRequestId('get-canvas-json');
      return new Promise<FrameMeta | null>((resolve) => {
        pendingGetCanvasJsonRef.current.set(requestId, resolve);
        client.sendGetCanvasJson(fileFolder, requestId);
      });
    }

    function handleControlReply(reply: ControlReply): void {
      if (reply.kind === 'get-canvas-json-result') {
        const resolve = pendingGetCanvasJsonRef.current.get(reply.requestId);
        if (!resolve) return; // stale/unmatched reply (e.g. after unmount) — ignore
        pendingGetCanvasJsonRef.current.delete(reply.requestId);
        resolve(reply.meta);
        return;
      }

      if (reply.kind === 'duplicate-frame-result') {
        // ADR-0015: unlike create-frame, duplicate-frame has a dedicated
        // success reply — resolve directly, no `frames`-watching effect
        // needed (the new frame still arrives via the ordinary
        // `file-changed` -> `get-canvas-json` -> `setFrames` path; this
        // reply is purely about settling the caller's promise).
        const pendingDuplicate = pendingDuplicateFrameRef.current.get(reply.requestId);
        if (!pendingDuplicate) return; // stale/unmatched reply — ignore
        pendingDuplicateFrameRef.current.delete(reply.requestId);
        pendingDuplicate.resolve();
        return;
      }

      if (reply.kind === 'read-source-result') {
        // FP-INS-b: `read-source`/`read-source-result` is sent/consumed over
        // `apps/studio`'s OWN (separate) daemon-ops connection (`daemon-
        // connection.tsx`), never over THIS package's internal control-ws —
        // `@ccs/canvas` never issues a `read-source` request itself. Ignored
        // here purely so this reply kind (which carries no `reason` field)
        // narrows out of the remaining `.reason`-bearing union below; a
        // stray reply of this kind reaching this socket is otherwise
        // harmless and unreachable in practice.
        return;
      }

      // reply.kind === 'control-error' — could be a `get-canvas-json`,
      // `create-frame`, or `duplicate-frame` failure; each tracks pending
      // requests by `requestId` in its own map, so check each.
      const pendingJson = pendingGetCanvasJsonRef.current.get(reply.requestId);
      if (pendingJson) {
        pendingGetCanvasJsonRef.current.delete(reply.requestId);
        pendingJson(null);
        return;
      }
      const pendingCreate = pendingCreateFrameRef.current.get(reply.requestId);
      if (pendingCreate) {
        pendingCreateFrameRef.current.delete(reply.requestId);
        pendingCreate.reject(new Error(reply.reason));
        return;
      }
      const pendingDuplicate = pendingDuplicateFrameRef.current.get(reply.requestId);
      if (pendingDuplicate) {
        pendingDuplicateFrameRef.current.delete(reply.requestId);
        pendingDuplicate.reject(new Error(reply.reason));
      }
    }

    async function handleProjectInfo(info: ProjectInfo): Promise<void> {
      for (const frame of info.frames) {
        const derived = deriveFileFolderPath(frame.framePath);
        if (!derived) continue;
        if (!originByFileFolderRef.current.has(derived.fileFolder)) {
          originByFileFolderRef.current.set(derived.fileFolder, originOf(frame.devServerUrl));
        }
      }

      const metaByFileFolder = new Map<string, FrameMeta>();
      await Promise.all(
        [...originByFileFolderRef.current.keys()].map(async (fileFolder) => {
          const meta = await requestCanvasJson(fileFolder);
          if (meta) metaByFileFolder.set(fileFolder, meta);
        }),
      );
      if (cancelled) return;
      setFrames(wireProjectInfo(info, metaByFileFolder));
    }

    async function handleFileChanged(projectRelativePath: string): Promise<void> {
      const derived = deriveFileFolderPath(projectRelativePath);
      if (!derived) return;
      const origin = originByFileFolderRef.current.get(derived.fileFolder);
      if (!origin) return; // unknown file-folder — see CHANGE-REQUEST (no origin learned yet)

      if (isCanvasJsonPath(derived.relPath)) {
        const meta = await requestCanvasJson(derived.fileFolder);
        if (!meta || cancelled) return;
        setFrames((prev) => resyncFileFolderGeometry(prev, derived.fileFolder, meta));
        return;
      }

      if (isFrameSourcePath(derived.relPath)) {
        const name = frameNameFromPath(derived.relPath);
        if (!name) return;
        const exists = await checkFrameSourceExists(origin, derived.relPath);
        if (cancelled) return;
        const id = frameRecordId(derived.fileFolder, derived.relPath);

        if (!exists) {
          setFrames((prev) => removeFrameRecord(prev, id));
          return;
        }

        const meta = await requestCanvasJson(derived.fileFolder);
        if (cancelled) return;
        setFrames((prev) => {
          const entry = meta?.frames.find((f) => f.framePath === derived.relPath);
          const sameFolderCount = prev.filter((r) => r.fileFolder === derived.fileFolder).length;
          const box = entry ?? { ...defaultGeometryForIndex(sameFolderCount), framePath: derived.relPath };
          const record: CanvasFrameRecord = {
            id,
            fileFolder: derived.fileFolder,
            framePath: derived.relPath,
            name,
            devServerUrl: `${origin}/?frame=${encodeURIComponent(name)}`,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
          };
          return upsertFrameRecord(prev, record);
        });
      }
    }

    function handleEvent(event: DaemonEvent): void {
      if (event.t === 'file-changed') {
        void handleFileChanged(event.file);
      } else if (event.t === 'hmr-update') {
        const derived = deriveFileFolderPath(event.file);
        if (!derived) return;
        screenshotCache.bumpGeneration(frameRecordId(derived.fileFolder, derived.relPath));
      } else if (event.t === 'uid-remap') {
        // P2/WS-B (playbook §4/P2, ADR-0016): forwarded to
        // `edit-mode-layer.tsx`'s subscriber via the module-level bus in
        // `selection-store.ts` — this daemon connection effect is the one
        // place `DaemonEvent`s are classified, but the re-resolution logic
        // needs the active edit-mode frame's bridge connection, which lives
        // in that component, not here.
        emitUidRemap(event);
      }
    }

    const client = connectDaemon(daemonUrl, {
      onProjectInfo: (info) => void handleProjectInfo(info),
      onEvent: handleEvent,
      onControlReply: handleControlReply,
    });
    clientRef.current = client;

    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
    };
  }, [daemonUrl, screenshotCache]);

  // FP-4a: `frames` mirror readable at CALL TIME (not closure-creation time)
  // by `setFrameGeometry`/`commitFrameGeometry` below — handed to callers
  // (imperative handle methods, geometry-commit subscribers) that are
  // themselves only reconstructed rarely, so a plain destructured `frames`
  // closure would go stale.
  const framesRef = React.useRef<CanvasFrameRecord[]>(frames);
  React.useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  /** FIX-W4b-3a `StudioCanvasHandle.setFrameGeometry` — see that method's own
   * doc in `studio-canvas-types.ts`. `geometry` is a PARTIAL box because the
   * Inspector only ever knows the axis it's actually editing (its numeric
   * W/H fields have no live read of the board's canvas X/Y) — any omitted
   * field is filled in from the frame's OWN current record here, so a W/H-
   * only edit can never silently reset the board's canvas position. A
   * no-op if no matching frame is currently known. */
  const setFrameGeometry = React.useCallback((fileFolder: string, framePath: string, geometry: Partial<Box>) => {
    const record = framesRef.current.find((r) => r.fileFolder === fileFolder && r.framePath === framePath);
    if (!record) return;
    const next: Box = {
      x: geometry.x ?? record.x,
      y: geometry.y ?? record.y,
      w: geometry.w ?? record.w,
      h: geometry.h ?? record.h,
    };
    clientRef.current?.sendSetGeometry(fileFolder, framePath, next);
    setFrames((prev) => prev.map((r) => (r.id === record.id ? { ...r, ...next } : r)));
  }, []);

  /** The drag/resize "gesture finished, persist me" endpoint — see
   * {@link UseStudioCanvasDaemonResult.commitFrameGeometry}'s own doc for
   * why this is addressed by `(fileFolder, framePath)` rather than a record
   * id: it's the exact same daemon write + `frames` update
   * `StudioCanvas.tsx`'s original `onFrameGeometryCommitted` subscriber did,
   * just with the id-derivation step (`recordIdFromShapeId`) left to the
   * caller (each engine's own subscriber already has `fileFolder`/
   * `framePath` on hand — the tldraw shape carries them as props directly;
   * the custom engine's `CommittedFrameGeometry.id` IS the record id, one
   * `frames.find` away). */
  const commitFrameGeometry = React.useCallback((fileFolder: string, framePath: string, geometry: Box) => {
    clientRef.current?.sendSetGeometry(fileFolder, framePath, geometry);
    setFrames((prev) =>
      prev.map((r) => (r.fileFolder === fileFolder && r.framePath === framePath ? { ...r, ...geometry } : r)),
    );
  }, []);

  const defaultFileFolder = frames[0]?.fileFolder;

  return {
    frames,
    screenshotCache,
    createFrame,
    duplicateFrame,
    defaultFileFolder,
    setFrameGeometry,
    commitFrameGeometry,
    requestComputedStyle,
    handleBridgeConnectionChange,
  };
}
