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
import { selectLiveFrames, DEFAULT_MAX_LIVE_FRAMES, type FrameRenderMode } from './viewport-cull.js';
import { captureFrameScreenshot } from './screenshot-capture.js';
import type { ScreenshotCache } from './screenshot-cache.js';
import { FRAME_CHROME_HEADER_HEIGHT, type Box } from './geometry.js';
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

/** FIX 6 (AUDIT-FIXW1 blocker remediation) tuning — see the
 * `isLiveByBudget` `useValue` in `CcsFrameShapeComponent`. `MAX_LIVE_FRAMES`
 * is the hard cap on simultaneously-live iframes that keeps the 20-frame
 * 60fps perf gate green; `CULL_MARGIN_FACTOR` keeps a frame just past the
 * viewport edge eligible (smooth panning) as a fraction of the current
 * viewport size (so it means the same thing at any zoom). */
const FIX6_MAX_LIVE_FRAMES = DEFAULT_MAX_LIVE_FRAMES;
const FIX6_CULL_MARGIN_FACTOR = 0.3;

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
  // FIX 6: the edit-mode frame's shape id, subscribed globally (not just
  // "is it ME") — so EVERY frame re-renders when edit mode changes, and each
  // recomputes `isLiveByBudget` below with the correct `alwaysLive` frame
  // occupying one slot of the live budget. Without this, a non-edit-mode
  // frame wouldn't re-render when another frame entered edit mode and so
  // wouldn't yield its live slot.
  const editModeShapeId = useSelectionStore((s) => s.editModeFrame?.shapeId ?? null);

  const frameBox = React.useMemo(
    () => ({ x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h }),
    [shape.x, shape.y, shape.props.w, shape.props.h],
  );

  // FIX 6 (AUDIT-FIXW1 blocker remediation): is THIS frame in the bounded
  // live set? `selectLiveFrames` (see its own doc in `viewport-cull.ts`)
  // makes ONE decision over ALL `ccs-frame` shapes on the page — at most
  // `FIX6_MAX_LIVE_FRAMES` may be live, the ones nearest the viewport
  // centre among those intersecting the (margin-expanded) viewport, with
  // the edit-mode frame forced in and counting toward the cap. This is the
  // hard bound that keeps the 20-frame 60fps perf gate green: no matter how
  // far the camera zooms out (so that all 20 frames are visible at once),
  // only the nearest `FIX6_MAX_LIVE_FRAMES` mount a live iframe; the rest
  // render a labeled placeholder (never a live iframe, never blank).
  //
  // Reactive via `useValue`: reading `editor.getViewportPageBounds()` +
  // `editor.getCurrentPageShapes()` (both tldraw reactive signals) re-runs
  // this every pan/zoom tick and whenever a frame is added/moved; the
  // `editModeShapeId` dep re-runs it on edit-mode changes.
  const isLiveByBudget = useValue(
    `ccs-frame-live-${shape.id}`,
    () => {
      const viewportPageBounds = editor.getViewportPageBounds();
      const cullMarginPage = Math.max(viewportPageBounds.w, viewportPageBounds.h) * FIX6_CULL_MARGIN_FACTOR;
      const boxes = new Map<string, Box>();
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type === CCS_FRAME_SHAPE_TYPE) {
          const f = s as CcsFrameShape;
          boxes.set(f.id, { x: f.x, y: f.y, w: f.props.w, h: f.props.h });
        }
      }
      const live = selectLiveFrames(viewportPageBounds, boxes, {
        maxLive: FIX6_MAX_LIVE_FRAMES,
        alwaysLive: editModeShapeId,
        cullMarginPage,
      });
      return live.has(shape.id);
    },
    [editor, frameBox, editModeShapeId, shape.id],
  );

  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  // `capturedUrl` only ever holds a screenshot THIS component captured
  // itself (set from the async `.then()` below, never synchronously in
  // the effect body — react-hooks/set-state-in-effect). Whatever's
  // already in the shared cache from an earlier mount/session is read
  // directly during render instead (`cachedUrl` below), so there's no
  // "show cached immediately" setState to avoid a blank flash.
  //
  // FIX 6 note: today `screenshotUrl` is effectively always `null` — a
  // real screenshot requires reading the iframe's DOM, which is cross-
  // origin (studio :5173 vs frame dev-server :5200+) so
  // `screenshot-capture.ts`'s `iframe.contentDocument` read is always
  // `null` and capture is a silent no-op. The capture wiring below is kept
  // (harmless) so it lights up automatically once the follow-up bridge-side
  // rasterization workstream (which also delivers FP-6 export) provides a
  // real cross-origin screenshot; until then, a non-live frame shows the
  // labeled placeholder (see the render return), never a blank box.
  const [capturedUrl, setCapturedUrl] = React.useState<string | null>(null);
  const wasLiveRef = React.useRef(false);
  const cachedUrl = screenshotCache?.get(shape.id)?.dataUrl ?? null;
  const screenshotUrl = capturedUrl ?? cachedUrl;

  // FP-INS-b (AUDIT-FPINSb): the ONE edit-mode frame is ALWAYS live (its
  // Inspect-tab computed CSS + bridge depend on a live iframe). It's also
  // forced into `selectLiveFrames`'s result via `alwaysLive`, so this
  // explicit branch is belt-and-suspenders — the render-mode guarantee is
  // stated here directly and does not depend on the selector.
  const renderMode: FrameRenderMode = isEditModeFrame || isLiveByBudget ? 'live' : 'screenshot';

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
          // FIX 6 (AUDIT-FIXW1 blocker remediation): a LABELED placeholder,
          // not a blank grey void. A frame that's culled / over the live cap
          // and has no real screenshot yet (cross-origin capture can't
          // produce one until the follow-up bridge-rasterization workstream)
          // still visibly reads as a BOARD — its name centered on a bordered
          // card — so the human's "I want the frames nearly all the time
          // showing" holds even for the far/over-cap frames, while the live
          // iframe count stays hard-capped for perf.
          <FramePlaceholder name={shape.props.name} />
        )}
      </div>
    </HTMLContainer>
  );
}

/** FIX 6: lightweight labeled placeholder for a non-live, not-yet-captured
 * frame (see the render return's doc). Pure presentational — no iframe, no
 * capture, negligible cost, so having many of these on-screen at once (the
 * far frames in a large project) does not affect the perf gate. */
function FramePlaceholder({ name }: { name: string }): React.ReactElement {
  return (
    <div
      data-testid="ccs-frame-placeholder"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        boxSizing: 'border-box',
        background: '#fafafa',
        color: '#71717a',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 500,
        textAlign: 'center',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
        {name}
      </span>
    </div>
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
