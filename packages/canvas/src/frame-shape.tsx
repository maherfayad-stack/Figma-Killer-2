import * as React from 'react';
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  resizeBox,
  useEditor,
  useValue,
  type Editor,
  type RecordProps,
  type TLBaseShape,
  type TLResizeInfo,
} from 'tldraw';
import { decideRenderMode } from './viewport-cull.js';
import { captureFrameScreenshot } from './screenshot-capture.js';
import type { ScreenshotCache } from './screenshot-cache.js';
import { FRAME_CHROME_HEADER_HEIGHT } from './geometry.js';
import { useSelectionStore } from './selection-store.js';

/**
 * `FrameShape` — the custom tldraw shape (playbook §4/P1 step 2). This is
 * the one module allowed to import tldraw's shape-authoring primitives
 * directly (`BaseBoxShapeUtil`, `HTMLContainer`, etc.) — the §5.4
 * abstraction boundary is enforced at the package's public `index.ts`,
 * which re-exports none of this. `StudioCanvas.tsx` wires this util into
 * `<Tldraw shapeUtils={[...]}>` but never re-exports the util or its
 * shape type itself.
 */

export interface CcsFrameShapeProps {
  /** File-folder name under `files/`, e.g. "demo". Not shown in the UI —
   * carried on the shape so geometry writes know which file-folder to
   * address (ADR-0013 `set-geometry` envelope). */
  fileFolder: string;
  /** File-folder-relative source path, matches `FrameEntry.framePath`. */
  framePath: string;
  /** Filename without extension — the chrome label. */
  name: string;
  /** Full iframe src, already including `?frame=<Name>`. */
  devServerUrl: string;
  w: number;
  h: number;
}

export type CcsFrameShape = TLBaseShape<'ccs-frame', CcsFrameShapeProps>;

// Registers 'ccs-frame' into tldraw's global shape-type union (the
// officially-supported extension point — see `TLGlobalShapePropsMap`'s own
// doc comment in @tldraw/tlschema) so `editor.createShape<CcsFrameShape>`/
// `updateShape<CcsFrameShape>` type-check normally. Module augmentation is
// an internal implementation detail of this file; it doesn't leak a
// tldraw type into `packages/canvas`'s own public API.
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    'ccs-frame': CcsFrameShapeProps;
  }
}

export const CCS_FRAME_SHAPE_TYPE = 'ccs-frame' as const;

/** Provides the shared `ScreenshotCache` instance down to shape component
 * instances. A cache isn't JSON-serializable/zod-validatable shape state
 * (tldraw's `props` must be), so it travels via React context from
 * `StudioCanvas`, not as a shape prop. */
export const ScreenshotCacheContext = React.createContext<ScreenshotCache | null>(null);

/**
 * Drag/resize-end pub-sub (playbook §4/P1 step 3: geometry two-way bind).
 * `onResizeEnd`/`onTranslateEnd` (below) fire ONLY at the end of an
 * interactive user gesture — never for programmatic `editor.updateShape`
 * calls `StudioCanvas` makes to sync incoming daemon state — which is
 * exactly the "user moved/resized a frame, persist it" signal without
 * needing to filter a generic `editor.store.listen` by change source.
 * Module-level singleton (not React context) because it's populated by a
 * `ShapeUtil` instance tldraw itself constructs — there's exactly one
 * `StudioCanvas` per page in this architecture, so this is equivalent to
 * a context in practice with far less plumbing.
 */
type GeometryCommitListener = (shape: CcsFrameShape) => void;
const geometryCommitListeners = new Set<GeometryCommitListener>();

export function onFrameGeometryCommitted(listener: GeometryCommitListener): () => void {
  geometryCommitListeners.add(listener);
  return () => geometryCommitListeners.delete(listener);
}

function emitFrameGeometryCommitted(shape: CcsFrameShape): void {
  for (const listener of geometryCommitListeners) listener(shape);
}

/**
 * P2/WS-B iframe registry (playbook §4/P2): maps a live `ccs-frame` shape's
 * tldraw shape id -> its rendered `<iframe>` element, so the top-level edit-
 * mode overlay (`edit-mode-layer.tsx`, which lives OUTSIDE any one shape's
 * own transformed DOM subtree — see that module's doc for why) can reach
 * into the currently-edit-mode frame's iframe to open a bridge connection
 * on it. Same module-level pub-sub shape as `onFrameGeometryCommitted`
 * above (a `ShapeUtil`/its component instances are constructed by tldraw
 * itself, not this package, so there's no React context boundary to thread
 * a ref through cleanly).
 */
type IframeRegistryListener = () => void;
const iframeRegistry = new Map<string, HTMLIFrameElement>();
const iframeRegistryListeners = new Set<IframeRegistryListener>();

function setRegisteredFrameIframe(shapeId: string, iframe: HTMLIFrameElement | null): void {
  const had = iframeRegistry.get(shapeId);
  if (had === iframe) return;
  if (iframe) iframeRegistry.set(shapeId, iframe);
  else iframeRegistry.delete(shapeId);
  for (const listener of iframeRegistryListeners) listener();
}

export function getRegisteredFrameIframe(shapeId: string): HTMLIFrameElement | null {
  return iframeRegistry.get(shapeId) ?? null;
}

export function onFrameIframeRegistryChange(listener: IframeRegistryListener): () => void {
  iframeRegistryListeners.add(listener);
  return () => iframeRegistryListeners.delete(listener);
}

function CcsFrameShapeComponent({ shape }: { shape: CcsFrameShape }): React.ReactElement {
  const editor: Editor = useEditor();
  const screenshotCache = React.useContext(ScreenshotCacheContext);
  // P2/WS-B: this frame's iframe gets pointer-events only while IT is the
  // one frame in edit mode (playbook §4/P2 "double-click frame = enter edit
  // mode ... iframe pointer-events auto"; all other frames stay `none`, and
  // normal P1 canvas pan/zoom is untouched since nothing here changes
  // outside this one shape's own render). See `edit-mode-layer.tsx`'s
  // module doc for why the actual hit-testing input is captured by a
  // top-level overlay rather than by this iframe directly (cross-origin
  // iframes never receive the parent's native mouse events either way).
  const isEditModeFrame = useSelectionStore((s) => s.editModeFrame?.shapeId === shape.id);

  const frameBox = React.useMemo(
    () => ({ x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h }),
    [shape.x, shape.y, shape.props.w, shape.props.h],
  );

  // Perf gate (playbook §4/P1): reactive live/screenshot decision, driven
  // by tldraw's own viewport-page-bounds + zoom signals (re-runs whenever
  // either changes, i.e. every pan/zoom tick) rather than a manual
  // resize/scroll listener.
  const viewportRenderMode = useValue(
    `ccs-frame-render-mode-${shape.id}`,
    () => decideRenderMode(editor.getViewportPageBounds(), editor.getZoomLevel(), frameBox),
    [editor, frameBox],
  );

  // FP-INS-b (AUDIT-FPINSb major fix): the ONE frame currently in edit mode
  // is ALWAYS rendered live, overriding the zoom/viewport cull. Rationale: an
  // edit-mode frame is being actively inspected/edited (its element selected
  // in the Layers panel, its computed CSS shown in the Inspect tab), and ALL
  // of that depends on a live iframe + bridge connection (`edit-mode-layer.
  // tsx` only opens a bridge on a REGISTERED — i.e. live — iframe, and the
  // registry is only populated in `'live'` mode below). Before this, opening
  // a multi-frame project (open-time `zoomToFit()` puts every frame under the
  // 30% screenshot threshold) then selecting a node via Layers left the
  // frame a static screenshot with no bridge, so the Inspect tab's
  // computed-CSS request resolved `not-found` forever. Perf stays bounded:
  // only the SINGLE edit-mode frame is force-lived; every other frame still
  // obeys the ordinary viewport/zoom cull (`viewportRenderMode` above).
  const renderMode = isEditModeFrame ? 'live' : viewportRenderMode;

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  // `capturedUrl` only ever holds a screenshot THIS component captured
  // itself (set from the async `.then()` below, never synchronously in
  // the effect body — react-hooks/set-state-in-effect). Whatever's
  // already in the shared cache from an earlier mount/session is read
  // directly during render instead (`cachedUrl` below), so there's no
  // "show cached immediately" setState to avoid a blank flash.
  const [capturedUrl, setCapturedUrl] = React.useState<string | null>(null);
  const wasLiveRef = React.useRef(false);
  const cachedUrl = screenshotCache?.get(shape.id)?.dataUrl ?? null;
  const screenshotUrl = capturedUrl ?? cachedUrl;

  React.useEffect(() => {
    if (renderMode === 'screenshot' && wasLiveRef.current && iframeRef.current && screenshotCache) {
      const iframe = iframeRef.current;
      const id = shape.id;
      void captureFrameScreenshot(iframe).then((dataUrl) => {
        if (dataUrl) {
          screenshotCache.set(id, dataUrl);
          setCapturedUrl(dataUrl);
        }
      });
    }
    wasLiveRef.current = renderMode === 'live';
  }, [renderMode, screenshotCache, shape.id]);

  // P2/WS-B iframe registry sync — see module doc above. Runs after every
  // render so it always reflects the CURRENT `iframeRef.current` (refs are
  // committed before effects run), registering while live and clearing
  // whenever this shape isn't rendering a live iframe (screenshot mode) or
  // unmounts.
  React.useEffect(() => {
    setRegisteredFrameIframe(shape.id, renderMode === 'live' ? iframeRef.current : null);
    return () => setRegisteredFrameIframe(shape.id, null);
  }, [renderMode, shape.id]);

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: shape.props.w,
        height: shape.props.h,
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        border: '1px solid #d4d4d8',
        borderRadius: 4,
        overflow: 'hidden',
        // Perf gate (playbook §4/P1): content-visibility + contain on
        // frame containers, applied unconditionally (cheap, and helps the
        // browser skip layout/paint work for frames tldraw itself hasn't
        // culled from the DOM yet).
        contentVisibility: 'auto',
        contain: 'layout style paint size',
      }}
    >
      <div
        style={{
          height: FRAME_CHROME_HEADER_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          fontSize: 12,
          fontFamily: 'system-ui, sans-serif',
          color: '#52525b',
          background: '#f4f4f5',
          borderBottom: '1px solid #e4e4e7',
          userSelect: 'none',
        }}
      >
        {shape.props.name}
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        {renderMode === 'live' ? (
          <iframe
            ref={iframeRef}
            src={shape.props.devServerUrl}
            title={shape.props.name}
            // Security (playbook §5.8): scripts + same-origin only, and
            // only ever pointed at a 127.0.0.1 dev server (StudioCanvas
            // never accepts a devServerUrl from anywhere but the
            // daemon's own ProjectInfo/DaemonEvent-derived state).
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              // Perf/pitfall (playbook §4/P1): pointer-events MUST be
              // none in canvas/nav mode or tldraw's own drag/select
              // gestures never reach the canvas — the iframe would eat
              // every mousedown first. P2/WS-B: 'auto' only for the ONE
              // frame currently in edit mode (double-click to enter, Esc
              // to exit — see `CcsFrameShapeUtil.onDoubleClick` below and
              // `edit-mode-layer.tsx`). Note this toggle reflects the
              // frame's general "editable now" state per the playbook
              // prompt; the actual hit-test input capture in P2 happens
              // via a top-level overlay in front of the iframe (see that
              // module's doc) because a cross-origin iframe's own DOM
              // events never reach this parent document regardless of
              // this CSS property — this keeps the property meaningful
              // for whenever a later phase needs the iframe itself to
              // receive events (e.g. in-place text editing).
              pointerEvents: isEditModeFrame ? 'auto' : 'none',
            }}
          />
        ) : screenshotUrl ? (
          <img
            src={screenshotUrl}
            alt={shape.props.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#f4f4f5' }} />
        )}
      </div>
    </HTMLContainer>
  );
}

export class CcsFrameShapeUtil extends BaseBoxShapeUtil<CcsFrameShape> {
  static override type = CCS_FRAME_SHAPE_TYPE;
  static override props: RecordProps<CcsFrameShape> = {
    fileFolder: T.string,
    framePath: T.string,
    name: T.string,
    devServerUrl: T.string,
    w: T.number,
    h: T.number,
  };

  override getDefaultProps(): CcsFrameShape['props'] {
    return { fileFolder: '', framePath: '', name: '', devServerUrl: '', w: 1440, h: 900 };
  }

  override canResize(): boolean {
    return true;
  }

  override onResize(shape: CcsFrameShape, info: TLResizeInfo<CcsFrameShape>): CcsFrameShape {
    return resizeBox(shape, info);
  }

  override onResizeEnd(_initial: CcsFrameShape, current: CcsFrameShape): void {
    emitFrameGeometryCommitted(current);
  }

  override onTranslateEnd(_initial: CcsFrameShape, current: CcsFrameShape): void {
    emitFrameGeometryCommitted(current);
  }

  override getIndicatorPath(shape: CcsFrameShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }

  /**
   * P2/WS-B "double-click frame = enter edit mode" (playbook §4/P2,
   * ADR-0016 WS-B split): zooms the camera to fit this frame and records
   * it as the studio's `editModeFrame` (selection store below).
   * `ShapeUtil.onDoubleClick` is the officially-supported per-shape
   * double-click hook (fires before tldraw's own default double-click
   * behavior for a box shape, e.g. entering its native edit/rename flow —
   * `ccs-frame` has none of that, so nothing to conflict with). Esc exit
   * (camera restore + `exitEditMode`) lives in `edit-mode-layer.tsx` since
   * it needs to run for a keydown anywhere on the page, not a per-shape
   * event.
   *
   * DELIBERATELY does NOT call `editor.setCameraOptions({isLocked:true})`
   * (CR, see worker report): tldraw's `isLocked` is a single blanket flag
   * with no "block pan, allow zoom" middle ground, and blocking zoom while
   * inspecting a frame's internals is worse UX than the "camera locks to
   * frame" playbook wording likely intended — read here as "the camera
   * SNAPS to the frame on entry / restores on exit", not "camera input is
   * frozen for the duration". Confirmed live: the P2 e2e zoom-level test
   * needs to zoom while in edit mode, and `isLocked:true` blocked that
   * entirely (both pan AND zoom), not just pan.
   */
  override onDoubleClick(shape: CcsFrameShape): void {
    const editor = this.editor;
    const camera = editor.getCamera();
    editor.zoomToBounds(
      { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h },
      { animation: { duration: 200 } },
    );
    useSelectionStore.getState().enterEditMode(
      { shapeId: shape.id, fileFolder: shape.props.fileFolder, framePath: shape.props.framePath },
      { x: camera.x, y: camera.y, z: camera.z },
    );
  }

  override component(shape: CcsFrameShape): React.ReactElement {
    return <CcsFrameShapeComponent shape={shape} />;
  }
}
