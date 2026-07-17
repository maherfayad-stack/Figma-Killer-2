import * as React from 'react';

/**
 * useResize — a small React reimplementation of Penpot's
 * `app.main.ui.hooks.resize/use-resize-hook` (`../penpot/frontend/src/app/
 * main/ui/hooks/resize.cljs`), adapted for this task (FP-2, `.orchestrator/
 * FEATURE-PARITY-PLAN.md` §2): drag a handle on a panel's edge, clamp
 * between `min`/`max`, persist the result. Penpot's version persists into
 * `storage/user` keyed by `[file-id key]`; we persist into `localStorage`
 * keyed by `[projectId, panelId]` (the "studio-local UI prefs" category the
 * One Rule already allows — see `projects-registry.ts`'s own localStorage
 * precedent — this is NOT design/scene data, so it never touches the
 * daemon or `.studio/canvas.json`).
 *
 * Mechanics kept faithful to the Penpot source: pointer-down captures the
 * drag-start size + pointer position (`start-size-ref`/`start-ref`),
 * pointer-move computes `new-size = start-size + delta` and clamps
 * (`mth/clamp`), pointer-up/lost-capture ends the drag. We use the
 * standard DOM Pointer Capture API (`setPointerCapture`/
 * `releasePointerCapture`) on the handle element itself in place of
 * Penpot's `dom/capture-pointer`/`dom/release-pointer` wrappers — same
 * effect (pointer events keep routing to the handle even once the cursor
 * leaves its bounding box mid-drag), no window-level listener bookkeeping
 * needed.
 *
 * RTL (playbook §5.9, ADR-0022): Penpot is not RTL-aware (`axis`/`negate?`
 * are caller-supplied constants). We ARE RTL-first, so `sign()` below
 * derives which physical direction growth is at DRAG TIME from
 * `document.documentElement.dir` (set once at boot by `main.tsx`) crossed
 * with which conceptual panel (`left`/`right`) is being dragged — see the
 * inline comment on `sign()` for the physical-layout derivation. This is
 * the one piece with no Penpot source to mirror (their app never flips
 * direction), so it's original.
 */

const STORAGE_PREFIX = 'ccs.studio.panel-width.v1';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function storageKey(projectId: string, panelId: string): string {
  return `${STORAGE_PREFIX}.${projectId}.${panelId}`;
}

function readPersisted(key: string, fallback: number, min: number, max: number): number {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function writePersisted(key: string, value: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // best-effort only (e.g. storage disabled/full) — never block resizing.
  }
}

export interface UseResizeOptions {
  /** Per-project identifier (a stable `ProjectEntry.id`, see
   * `projects-registry.ts`) — every panel width is scoped to this so two
   * different projects never share a saved width. */
  projectId: string;
  /** Which conceptual panel this is — decides the resize-direction sign
   * under RTL (see `sign()`). */
  panelId: 'left' | 'right';
  initial: number;
  min: number;
  max: number;
}

export interface UseResizeResult {
  /** Current panel size in px — already clamped + (on first read)
   * initialized from localStorage. */
  size: number;
  /** Spread onto the drag-handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  };
}

/** Which physical direction growth is when the pointer moves +1px in the
 * physical-x (screen) direction, for the given conceptual panel under the
 * current document direction.
 *
 * `WorkspaceShell`'s grid places the LEFT panel first in DOM order and the
 * RIGHT panel last; a CSS grid with `direction: rtl` renders DOM-first
 * columns at the PHYSICAL right (verified in `apps/studio/e2e/tests/
 * acceptance.spec.ts` test (h): "the DOM-first dock ... renders on the
 * PHYSICAL RIGHT" under `dir=rtl`). So:
 *   - left panel, LTR: panel is physically left, its resize edge (facing
 *     the canvas) is its physical-right edge — dragging right (+x) grows it.
 *   - left panel, RTL: panel is physically RIGHT, its resize edge is its
 *     physical-LEFT edge — dragging LEFT (-x) grows it.
 *   - right panel, LTR: panel is physically right, resize edge is
 *     physical-left — dragging LEFT (-x) grows it.
 *   - right panel, RTL: panel is physically LEFT, resize edge is
 *     physical-right — dragging RIGHT (+x) grows it.
 */
function sign(panelId: 'left' | 'right', isRtl: boolean): 1 | -1 {
  const isLeftPanel = panelId === 'left';
  const isPhysicallyLeft = isLeftPanel !== isRtl; // left panel is physically left unless mirrored by RTL
  return isPhysicallyLeft ? 1 : -1;
}

export function useResize({ projectId, panelId, initial, min, max }: UseResizeOptions): UseResizeResult {
  const key = React.useMemo(() => storageKey(projectId, panelId), [projectId, panelId]);
  const [size, setSize] = React.useState<number>(() => readPersisted(key, initial, min, max));

  // Re-read (and re-clamp) whenever the project/panel identity changes —
  // e.g. opening a different project should load THAT project's saved
  // width, not carry over the previously-open project's. React's
  // render-time "adjust state when a key changes" pattern (docs: "You
  // Might Not Need an Effect") — no effect needed, and it re-initializes
  // synchronously on the same render the key changed rather than one paint
  // later.
  const [prevKey, setPrevKey] = React.useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setSize(readPersisted(key, initial, min, max));
  }

  const draggingRef = React.useRef(false);
  const startSizeRef = React.useRef(size);
  const startXRef = React.useRef(0);
  const sizeRef = React.useRef(size);
  React.useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  const commitSize = React.useCallback(
    (raw: number) => {
      const clamped = clamp(raw, min, max);
      setSize(clamped);
      writePersisted(key, clamped);
    },
    [key, min, max],
  );

  const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startSizeRef.current = sizeRef.current;
  }, []);

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return;
      const isRtl = document.documentElement.dir === 'rtl';
      const delta = (e.clientX - startXRef.current) * sign(panelId, isRtl);
      commitSize(startSizeRef.current + delta);
    },
    [panelId, commitSize],
  );

  const onPointerUp = React.useCallback((e: React.PointerEvent<HTMLElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return { size, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
}
