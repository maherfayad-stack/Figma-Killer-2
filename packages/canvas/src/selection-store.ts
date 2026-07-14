import { create } from 'zustand';
import type { UidRemapEvent } from '@ccs/protocol';
import type { BreadcrumbEntry, Rect } from '@ccs/bridge';

/**
 * P2/WS-B in-memory selection store (playbook §4/P2, ADR-0016). Deliberately
 * NOT persisted anywhere — this is pure ephemeral UI state (which frame is
 * in edit mode, what's hovered/selected, the current breadcrumb), so it
 * does NOT violate the One Rule (playbook §5.1: "the only editor-owned
 * persistent data is spatial metadata in `.studio/canvas.json`" — this
 * store never touches disk, never round-trips through the daemon as
 * anything other than transient `hit-test`/`report-rects` bridge calls).
 * A page reload starts with an empty selection; that's intended.
 *
 * Zustand (not React context) so it's readable/writable from BOTH React
 * components (`edit-mode-layer.tsx`, the breadcrumb bar) AND
 * `frame-shape.tsx`'s `ShapeUtil` methods, which tldraw itself constructs
 * outside any component tree (`CcsFrameShapeUtil.onDoubleClick` calls
 * `useSelectionStore.getState().enterEditMode(...)` directly — no hook
 * context available there).
 */

export interface EditModeFrameRef {
  /** tldraw shape id (`shape:<CanvasFrameRecord id>`) of the ONE frame
   * currently in edit mode — matches `frame-shape.tsx`'s
   * `getRegisteredFrameIframe` key. */
  shapeId: string;
  /** File-folder name + file-folder-relative frame source path (matches
   * `CanvasFrameRecord.fileFolder`/`.framePath`) — lets the edit-mode layer
   * and the `uid-remap` handler below know which frame/file a bridge
   * message or daemon event applies to. */
  fileFolder: string;
  framePath: string;
}

export interface CameraSnapshot {
  x: number;
  y: number;
  z: number;
}

export interface HoverState {
  uid: string;
  /** Iframe CSS-pixel-space rect, as reported by the bridge's `hit-test`
   * reply — NOT yet transformed to screen space (that's
   * `bridge-geometry.ts`'s job, applied at render time so it always uses
   * the current camera). */
  rect: Rect;
  dynamic: boolean;
  component: string | null;
  /** Display name for the hover name-tag — `data-component` (e.g.
   * "ds:Button") when the node is an imported component instance, else the
   * lowercase host tag name (e.g. "h1"). NOT derivable from `uid` alone
   * (`<relPath>:<astPath>` carries no tag name) — the bridge's `hit-test`
   * reply's `breadcrumb` always ends with an entry for the hit node itself
   * (`HitInfoSchema` doc: "ending with the hit node itself"), which is
   * where this comes from (same fallback `component ?? tagName` the
   * bridge's own `buildBreadcrumb` uses). */
  name: string;
}

export interface SelectionState {
  uid: string;
  rect: Rect | null;
  dynamic: boolean;
  component: string | null;
  breadcrumb: BreadcrumbEntry[];
  /** True once a `uid-remap`/HMR re-resolution couldn't find this node
   * anymore (playbook §4/P2 pitfall: "selection survives HMR ... uid remap
   * event re-resolves"; ADR-0016: "absent -> mark detached"). A detached
   * selection keeps its last-known rect/breadcrumb (stale, dimmed by the
   * overlay) rather than silently vanishing. */
  detached: boolean;
}

export interface SelectionStoreState {
  editModeFrame: EditModeFrameRef | null;
  /** Camera captured the instant edit mode was entered, so Esc can restore
   * the pre-edit-mode pan/zoom exactly (playbook §4/P2: "Esc exits"). */
  previousCamera: CameraSnapshot | null;
  hoveredUid: string | null;
  hover: HoverState | null;
  /** Playbook wording is "selectedUids" (plural/list-shaped, forward
   * compatible with a future multi-select gesture) — P2 only ever
   * populates 0 or 1 entries (single click-to-select), but the shape is
   * kept as an array per that wording. Per-uid detail (rect/dynamic/
   * breadcrumb/detached) lives in `selections`, keyed by uid. */
  selectedUids: string[];
  selections: Record<string, SelectionState>;
  /** Breadcrumb of the PRIMARY (most recently selected) node — what the
   * minimal top-bar element renders (playbook §4/P2: "breadcrumb in top
   * bar"). Empty when nothing is selected. */
  breadcrumb: BreadcrumbEntry[];

  enterEditMode(frame: EditModeFrameRef, previousCamera: CameraSnapshot): void;
  /** Returns the frame that WAS active (so the caller can restore its
   * camera) — null if edit mode wasn't active. Clears hover/selection too
   * (leaving edit mode with a stale selection overlay would be confusing,
   * and the bridge connection that was streaming `rects-update` for it is
   * torn down by the caller in the same gesture). */
  exitEditMode(): { frame: EditModeFrameRef; previousCamera: CameraSnapshot | null } | null;
  setHover(hover: HoverState | null): void;
  setSelection(selection: Omit<SelectionState, 'detached'> | null): void;
  /** Applied when a `rects-update`/`report-rects` reply reports a fresher
   * rect for a uid currently tracked in `selections` (playbook §4/P2
   * pitfall: "bridge must stream rect updates while selected"). A `null`
   * rect means the node is currently unmeasurable (e.g. `display:none`) —
   * NOT the same as detached (still present, just not laid out); left
   * untouched if the uid isn't part of the current selection (stale reply
   * after a deselect).
   */
  updateSelectionRect(uid: string, rect: Rect | null): void;
  /** Marks a selected uid detached (bridge `report-rects` came back null
   * for it after a remap/HMR check) without removing it from
   * `selectedUids` — the overlay renders a distinct "detached" affordance
   * rather than the selection just disappearing. */
  markSelectionDetached(uid: string): void;
  /** Pure remap step of the FROZEN `uid-remap` DaemonEvent handler
   * (ADR-0016: "studio re-resolves selection through the map (unmapped-
   * but-present uid -> keep; absent -> mark detached)"). Only rewrites
   * `hoveredUid`/`selectedUids`/`selections` keys found in `map`; presence
   * verification for uids NOT in the map (the "absent -> detached" half)
   * requires a live `report-rects` round trip, which is out of this pure
   * store method's reach — `edit-mode-layer.tsx`'s `onUidRemap` subscriber
   * does that follow-up and calls `markSelectionDetached`/
   * `updateSelectionRect` with the result. Returns the remapped uids so the
   * caller knows what to verify. */
  applyUidRemap(map: Record<string, string>): string[];
}

const EMPTY_BREADCRUMB: BreadcrumbEntry[] = [];

export const useSelectionStore = create<SelectionStoreState>((set, get) => ({
  editModeFrame: null,
  previousCamera: null,
  hoveredUid: null,
  hover: null,
  selectedUids: [],
  selections: {},
  breadcrumb: EMPTY_BREADCRUMB,

  enterEditMode(frame, previousCamera) {
    set({
      editModeFrame: frame,
      previousCamera,
      hoveredUid: null,
      hover: null,
      selectedUids: [],
      selections: {},
      breadcrumb: EMPTY_BREADCRUMB,
    });
  },

  exitEditMode() {
    const { editModeFrame, previousCamera } = get();
    if (!editModeFrame) return null;
    set({
      editModeFrame: null,
      previousCamera: null,
      hoveredUid: null,
      hover: null,
      selectedUids: [],
      selections: {},
      breadcrumb: EMPTY_BREADCRUMB,
    });
    return { frame: editModeFrame, previousCamera };
  },

  setHover(hover) {
    set({ hoveredUid: hover?.uid ?? null, hover });
  },

  setSelection(selection) {
    if (!selection) {
      set({ selectedUids: [], selections: {}, breadcrumb: EMPTY_BREADCRUMB });
      return;
    }
    const entry: SelectionState = { ...selection, detached: false };
    set({
      selectedUids: [entry.uid],
      selections: { [entry.uid]: entry },
      breadcrumb: entry.breadcrumb,
    });
  },

  updateSelectionRect(uid, rect) {
    set((state) => {
      const existing = state.selections[uid];
      if (!existing) return state;
      return { selections: { ...state.selections, [uid]: { ...existing, rect } } };
    });
  },

  markSelectionDetached(uid) {
    set((state) => {
      const existing = state.selections[uid];
      if (!existing) return state;
      return { selections: { ...state.selections, [uid]: { ...existing, detached: true } } };
    });
  },

  applyUidRemap(map) {
    const remapped: string[] = [];
    set((state) => {
      const remapUid = (uid: string): string => map[uid] ?? uid;

      const nextHoveredUid = state.hoveredUid ? remapUid(state.hoveredUid) : state.hoveredUid;
      const nextHover =
        state.hover && nextHoveredUid ? { ...state.hover, uid: nextHoveredUid } : state.hover;

      const nextSelectedUids = state.selectedUids.map(remapUid);
      const nextSelections: Record<string, SelectionState> = {};
      state.selectedUids.forEach((oldUid, i) => {
        const newUid = nextSelectedUids[i];
        const existing = state.selections[oldUid];
        if (!existing || !newUid) return;
        nextSelections[newUid] = newUid === oldUid ? existing : { ...existing, uid: newUid, detached: false };
        if (newUid !== oldUid) remapped.push(newUid);
      });

      const nextBreadcrumb =
        state.selectedUids.length > 0 && nextSelectedUids[0]
          ? (nextSelections[nextSelectedUids[0]]?.breadcrumb ?? state.breadcrumb)
          : state.breadcrumb;

      return {
        hoveredUid: nextHoveredUid,
        hover: nextHover,
        selectedUids: nextSelectedUids,
        selections: nextSelections,
        breadcrumb: nextBreadcrumb,
      };
    });
    return remapped;
  },
}));

// --- uid-remap event bus -----------------------------------------------
// `StudioCanvas.tsx` owns the one daemon connection and already classifies
// every `DaemonEvent` (playbook §4/P0/P1); it forwards `uid-remap` here
// rather than `edit-mode-layer.tsx` opening a second daemon connection.
// Same module-level pub-sub shape as `frame-shape.tsx`'s
// `onFrameGeometryCommitted`/iframe registry, for the same reason (the
// publisher and the one interested subscriber don't share a natural React
// ancestor without threading a prop through `StudioCanvas` -> `Tldraw`'s
// children, which doesn't exist as a slot here).
type UidRemapListener = (event: UidRemapEvent) => void;
const uidRemapListeners = new Set<UidRemapListener>();

export function emitUidRemap(event: UidRemapEvent): void {
  for (const listener of uidRemapListeners) listener(event);
}

export function onUidRemap(listener: UidRemapListener): () => void {
  uidRemapListeners.add(listener);
  return () => uidRemapListeners.delete(listener);
}
