import * as React from 'react';
import { Tldraw, createShapeId, type Editor, type TLComponents, type TLUiOverrides } from 'tldraw';
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
import { createScreenshotCache } from './screenshot-cache.js';
import {
  CCS_FRAME_SHAPE_TYPE,
  CcsFrameShapeUtil,
  ScreenshotCacheContext,
  onFrameGeometryCommitted,
  type CcsFrameShape,
} from './frame-shape.js';
import { frameSourcePath, isValidFrameName } from './new-frame.js';
import { EditModeLayer } from './edit-mode-layer.js';
import { emitUidRemap } from './selection-store.js';

/**
 * `StudioCanvas` — the package's public entry point (playbook §4/P1). All
 * tldraw specifics live behind this component: callers only ever see
 * `CanvasFrameRecord`-shaped data and the `CreateFrameFn` contract, never
 * a tldraw type (playbook §5.4 — keeps a future custom-camera fallback
 * possible without touching call sites).
 */

export interface CreateFrameRequest {
  fileFolder: string;
  name: string;
}

/**
 * Creates a new frame (`.tsx` + `src/frames.ts` registry entry +
 * `.studio/canvas.json` entry — playbook §4/P1 step 4). The default
 * implementation (see `defaultCreateFrame` inside `StudioCanvas`) sends a
 * `{kind:'create-frame', ...}` request over the real control-ws connection
 * (ADR-0014) and resolves once the resulting `file-changed` broadcast(s)
 * land the new frame in `frames` state, or rejects on a `control-error`
 * reply. Callers may still supply their own `onCreateFrame` (e.g. a
 * fs-backed test double, or a dev harness that wants to bypass the socket)
 * — it fully replaces the default, it does not layer on top of it.
 */
export type CreateFrameFn = (request: CreateFrameRequest) => Promise<void>;

export interface DuplicateFrameRequest {
  fileFolder: string;
  /** Filename (without extension) of the existing frame to duplicate — the
   * daemon reads its source, copies it to a uniquely-named new frame file,
   * patches the registry, and appends an offset `.studio/canvas.json`
   * entry (ADR-0015 — see `duplicate-frame.ts` in `packages/sync-daemon`
   * for the full three-artifact write). */
  sourceName: string;
}

/**
 * Duplicates an existing frame (ADR-0015 — the P1 defect fix: tldraw's
 * built-in duplicate/copy/paste created fileless "phantom" `ccs-frame`
 * shapes the reaper then deleted on the next sync). The default
 * implementation (see `defaultDuplicateFrame` inside `StudioCanvas`) sends
 * a `{kind:'duplicate-frame', ...}` request over the real control-ws
 * connection and resolves once the dedicated `duplicate-frame-result`
 * reply lands (unlike `CreateFrameFn`, success here is NOT observed via
 * `frames` state — the caller doesn't know the daemon-picked `newName` in
 * advance), or rejects on a `control-error` reply. Callers may still
 * supply their own `onDuplicateFrame` (e.g. a test double) — it fully
 * replaces the default, it does not layer on top of it.
 */
export type DuplicateFrameFn = (request: DuplicateFrameRequest) => Promise<void>;

/** Bound on how long a `defaultCreateFrame`/`defaultDuplicateFrame` promise
 * waits for a daemon reply before giving up — a stuck daemon/connection
 * should surface as a UI error, not hang forever. */
const CREATE_FRAME_TIMEOUT_MS = 10_000;

export interface StudioCanvasProps {
  /** Control-ws URL, e.g. `ws://127.0.0.1:4700` (ADR-0012/0013). */
  daemonUrl: string;
  /** See {@link CreateFrameFn}. Defaults to a real daemon-backed
   * implementation (ADR-0014's `create-frame` control request) — pass this
   * prop only to override that default (e.g. in tests). */
  onCreateFrame?: CreateFrameFn;
  /** See {@link DuplicateFrameFn}. Defaults to a real daemon-backed
   * implementation (ADR-0015's `duplicate-frame` control request) — pass
   * this prop only to override that default (e.g. in tests). */
  onDuplicateFrame?: DuplicateFrameFn;
  className?: string;
  style?: React.CSSProperties;
}

const CONTAINER_STYLE: React.CSSProperties = { position: 'relative', width: '100%', height: '100%' };

/** tldraw component overrides — P1 doesn't build studio chrome (that's
 * P5), so every stock tldraw UI panel not needed to demonstrate pan/zoom/
 * select/resize is hidden here (empty object = defaults kept only for the
 * shapes/handles/selection UI itself, per playbook BOUNDARIES: "do NOT
 * build the full studio chrome"). */
const MINIMAL_COMPONENTS: TLComponents = {
  MenuPanel: null,
  PageMenu: null,
  MainMenu: null,
  ActionsMenu: null,
  StylePanel: null,
  Toolbar: null,
  KeyboardShortcutsDialog: null,
  HelpMenu: null,
  DebugPanel: null,
  DebugMenu: null,
  ZoomMenu: null,
  QuickActions: null,
  NavigationPanel: null,
};

function shapeIdForRecordId(recordId: string) {
  return createShapeId(recordId);
}

/** `createShapeId(id)` deterministically produces `shape:<id>` (verified
 * against the installed tldraw@5.2.4 build) — recovering the original
 * record id is a plain prefix strip, not a public tldraw API, so it's
 * isolated to this one helper in case a future tldraw version changes
 * the format. */
function recordIdFromShapeId(shapeId: string): string {
  const prefix = 'shape:';
  return shapeId.startsWith(prefix) ? shapeId.slice(prefix.length) : shapeId;
}

/** Correlates an ADR-0014 `create-frame`/`get-canvas-json` request to its
 * `onControlReply`. Plain counter (not `crypto.randomUUID`) — this only
 * needs to be unique within one `StudioCanvas` instance's lifetime, not
 * globally, and stays dependency-free for the dev/e2e/browser targets
 * this module runs in. */
let requestIdCounter = 0;
function nextRequestId(prefix: string): string {
  requestIdCounter += 1;
  return `${prefix}-${requestIdCounter}`;
}

export function StudioCanvas({
  daemonUrl,
  onCreateFrame,
  onDuplicateFrame,
  className,
  style,
}: StudioCanvasProps): React.ReactElement {
  const [frames, setFrames] = React.useState<CanvasFrameRecord[]>([]);
  const [editorReady, setEditorReady] = React.useState(false);
  const editorRef = React.useRef<Editor | null>(null);
  // P2/WS-B: `EditModeLayer` needs the `Editor` instance as a render-time
  // value (it's JSX-conditional below), and `react-hooks/refs` correctly
  // flags reading `editorRef.current` during render (refs are an escape
  // hatch for effects/handlers, not render). `editorReady`/`editorRef`
  // above are untouched (still used the same way by the existing
  // effects further down) — this is purely an additional render-safe
  // mirror of the same value, set in the same `handleMount` callback.
  const [mountedEditor, setMountedEditor] = React.useState<Editor | null>(null);
  const clientRef = React.useRef<DaemonClient | null>(null);
  const originByFileFolderRef = React.useRef<Map<string, string>>(new Map());
  const [screenshotCache] = React.useState(() => createScreenshotCache());
  const [newFrameOpen, setNewFrameOpen] = React.useState(false);
  const [newFrameName, setNewFrameName] = React.useState('');
  const [newFrameError, setNewFrameError] = React.useState<string | null>(null);
  const [newFrameBusy, setNewFrameBusy] = React.useState(false);
  /** ADR-0015 phantom-frame guard: `true` for the duration of the
   * `CanvasFrameRecord[] -> tldraw shape` sync effect's own
   * `createShape`/`updateShape`/`deleteShapes` calls below, `false`
   * otherwise. The `registerAfterCreateHandler('shape', ...)` effect
   * (further down) uses this to tell "the sync effect just created a
   * real, record-backed frame shape" apart from "tldraw's native
   * duplicate/copy/paste/undo just created a `ccs-frame` shape out of
   * nowhere" — only the latter gets deleted right back out. A plain ref
   * (not React state) because it must be read synchronously inside a
   * tldraw store callback that can fire outside React's render cycle. */
  const isSyncingRef = React.useRef(false);

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

  const shapeUtils = React.useMemo(() => [CcsFrameShapeUtil], []);

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

  // --- CanvasFrameRecord[] -> tldraw FrameShape sync -------------------
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;

    // ADR-0015: everything this effect does to the store is "the file
    // system is the truth, catching the canvas up" — never a user gesture
    // — so the phantom-frame guard (registered below) must let it through
    // unconditionally. Set for the duration of this synchronous block only
    // (tldraw's create/update/delete calls run synchronously; there's no
    // await in between), then always cleared via `finally`.
    isSyncingRef.current = true;
    try {
      const currentShapeIds = new Set<string>();
      for (const record of frames) {
        const shapeId = shapeIdForRecordId(record.id);
        currentShapeIds.add(shapeId);
        const existing = editor.getShape<CcsFrameShape>(shapeId);
        const props = {
          fileFolder: record.fileFolder,
          framePath: record.framePath,
          name: record.name,
          devServerUrl: record.devServerUrl,
          w: record.w,
          h: record.h,
        };
        if (!existing) {
          editor.createShape<CcsFrameShape>({
            id: shapeId,
            type: CCS_FRAME_SHAPE_TYPE,
            x: record.x,
            y: record.y,
            props,
          });
        } else if (
          existing.x !== record.x ||
          existing.y !== record.y ||
          existing.props.w !== record.w ||
          existing.props.h !== record.h ||
          existing.props.devServerUrl !== record.devServerUrl ||
          existing.props.name !== record.name
        ) {
          editor.updateShape<CcsFrameShape>({ id: shapeId, type: CCS_FRAME_SHAPE_TYPE, x: record.x, y: record.y, props });
        }
      }

      const staleShapeIds = editor
        .getCurrentPageShapesSorted()
        .filter((s) => s.type === CCS_FRAME_SHAPE_TYPE && !currentShapeIds.has(s.id))
        .map((s) => s.id);
      if (staleShapeIds.length > 0) editor.deleteShapes(staleShapeIds);
    } finally {
      isSyncingRef.current = false;
    }
  }, [frames, editorReady]);

  // --- ADR-0015 phantom-frame guard ------------------------------------
  // tldraw's `registerBeforeCreateHandler` can only TRANSFORM a record
  // about to be created, not cancel its creation (verified against the
  // installed tldraw@5.2.4 `@tldraw/store` build — `StoreSideEffects`
  // has no "return false to block" affordance for creates, only for
  // deletes). `registerAfterCreateHandler` runs synchronously right after
  // the record lands in the store, in the SAME atomic operation, before
  // React ever re-renders — calling `editor.deleteShape` there removes it
  // before the user perceives it existing at all. This is the safety net
  // behind the `overrides.actions.duplicate` override below: it catches
  // ANY route to a fileless `ccs-frame` shape (native duplicate, copy/
  // paste, cut+undo, a future stray codepath), not just Cmd/Ctrl+D.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    return editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
      if (shape.type === CCS_FRAME_SHAPE_TYPE && !isSyncingRef.current) {
        editor.deleteShape(shape.id);
      }
    });
  }, [editorReady]);

  // --- drag/resize -> debounced .studio/canvas.json write (ADR-0013) ---
  React.useEffect(() => {
    return onFrameGeometryCommitted((shape) => {
      clientRef.current?.sendSetGeometry(shape.props.fileFolder, shape.props.framePath, {
        x: shape.x,
        y: shape.y,
        w: shape.props.w,
        h: shape.props.h,
      });
      setFrames((prev) =>
        prev.map((r) =>
          r.id === recordIdFromShapeId(shape.id) ? { ...r, x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h } : r,
        ),
      );
    });
  }, []);

  const handleMount = React.useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorReady(true);
    setMountedEditor(editor);
  }, []);

  /**
   * ADR-0015: replaces tldraw's native "duplicate" action (Cmd/Ctrl+D, and
   * the tool exposed via `overrides` — bound regardless of `MINIMAL_COMPONENTS`
   * hiding every UI panel, since `useKeyboardShortcuts` mounts unconditionally
   * inside `<Tldraw>`'s own UI provider) for `ccs-frame` shapes: instead of
   * tldraw's built-in record-copy (which the phantom-frame guard above would
   * immediately delete again), issue one real `duplicate-frame` daemon
   * request per selected frame. A selection with no frame shapes falls
   * through to the original action unchanged (harmless today — no other
   * shape type is ever intentionally created in this P1 UI — but keeps this
   * override honest about only touching what it means to).
   */
  const overrides = React.useMemo<TLUiOverrides>(
    () => ({
      actions(editor, actions) {
        const original = actions.duplicate;
        if (!original) return actions;
        return {
          ...actions,
          duplicate: {
            ...original,
            onSelect(source) {
              const frameShapes = editor
                .getSelectedShapes()
                .filter((shape): shape is CcsFrameShape => shape.type === CCS_FRAME_SHAPE_TYPE);
              if (frameShapes.length === 0) {
                original.onSelect(source);
                return;
              }
              for (const shape of frameShapes) {
                const sourceName = frameNameFromPath(shape.props.framePath);
                if (!sourceName) continue;
                duplicateFrame({ fileFolder: shape.props.fileFolder, sourceName }).catch((err: unknown) => {
                  // No toast system in P1 chrome (that's P5) — surface to
                  // the console rather than fail silently.
                  console.error('@ccs/canvas: duplicate-frame failed', err);
                });
              }
            },
          },
        };
      },
    }),
    [duplicateFrame],
  );

  const defaultFileFolder = frames[0]?.fileFolder;

  const submitNewFrame = React.useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!defaultFileFolder) {
        setNewFrameError('no file-folder known yet');
        return;
      }
      if (!isValidFrameName(newFrameName)) {
        setNewFrameError('name must be PascalCase, e.g. "Testimonials"');
        return;
      }
      setNewFrameBusy(true);
      setNewFrameError(null);
      createFrame({ fileFolder: defaultFileFolder, name: newFrameName })
        .then(() => {
          setNewFrameOpen(false);
          setNewFrameName('');
        })
        .catch((err: unknown) => {
          setNewFrameError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setNewFrameBusy(false);
        });
    },
    [createFrame, defaultFileFolder, newFrameName],
  );

  return (
    <div className={className} style={{ ...CONTAINER_STYLE, ...style }}>
      <ScreenshotCacheContext.Provider value={screenshotCache}>
        <Tldraw shapeUtils={shapeUtils} components={MINIMAL_COMPONENTS} overrides={overrides} onMount={handleMount} />
      </ScreenshotCacheContext.Provider>
      {mountedEditor && <EditModeLayer editor={mountedEditor} frames={frames} />}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, fontFamily: 'system-ui, sans-serif' }}>
        {newFrameOpen ? (
          <form
            onSubmit={submitNewFrame}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: '#fff',
              border: '1px solid #d4d4d8',
              borderRadius: 6,
              padding: 10,
              boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            }}
          >
            <input
              aria-label="New frame name"
              placeholder="Testimonials"
              value={newFrameName}
              onChange={(e) => setNewFrameName(e.target.value)}
              autoFocus
              style={{ fontSize: 13, padding: '4px 6px', border: '1px solid #d4d4d8', borderRadius: 4 }}
            />
            {newFrameError && <span style={{ fontSize: 12, color: '#dc2626' }}>{newFrameError}</span>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="submit" disabled={newFrameBusy} style={{ fontSize: 13 }}>
                {newFrameBusy ? 'Creating…' : 'Create'}
              </button>
              <button type="button" onClick={() => setNewFrameOpen(false)} style={{ fontSize: 13 }}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNewFrameOpen(true)}
            style={{
              fontSize: 13,
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid #d4d4d8',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            + New Frame
          </button>
        )}
      </div>
    </div>
  );
}
