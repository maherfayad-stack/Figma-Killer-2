import * as React from 'react';
import { FRAME_CHROME_HEADER_HEIGHT } from './geometry.js';

/**
 * Sub-workstream 2b (`.orchestrator/CANVAS-ENGINE-DESIGN.md`'s Phase 2
 * split) — `FrameShape.tsx` is the plain-React replacement for
 * `frame-shape.tsx`'s tldraw `CcsFrameShapeUtil`/`CcsFrameShapeComponent`.
 * NOT a tldraw `ShapeUtil` — no shape-lifecycle hooks, no `HTMLContainer`,
 * no `useEditor`/`useValue`. The parent (`Canvas.tsx`) owns mounting one of
 * these per frame, positions it via CSS `left/top/width/height` in
 * page-space coordinates inside its own transformed "world" div, and
 * decides this frame's live/placeholder render mode (via `viewport-cull.ts`'s
 * `selectLiveFrames`, computed ONCE over every frame, not per-shape here —
 * see that module's doc for why a single batched decision is the
 * perf-safe approach) and passes the result down as the `live` prop.
 *
 * Deliberately ported 1:1 from `frame-shape.tsx`'s render logic (chrome
 * header strip, `content-visibility`/`contain` perf CSS, iframe sandbox +
 * pointer-events, `FramePlaceholder` fallback) per this sub-workstream's
 * brief — everything tldraw-specific (HTMLContainer, useEditor, useValue,
 * the iframe registry pub-sub, screenshot-capture) is intentionally
 * dropped, NOT ported:
 *  - Screenshot-capture/cache is a separate, still-unresolved concern
 *    (frame-shape.tsx's own doc: cross-origin `iframe.contentDocument`
 *    reads always fail; a real fix needs bridge-side rasterization, a
 *    distinct follow-up workstream) — out of scope for this pass. A
 *    non-live frame here always shows the plain labeled placeholder,
 *    the same honest fallback frame-shape.tsx uses when it has no
 *    screenshot yet.
 *  - Edit-mode pointer-events toggling (iframe `pointer-events: auto` only
 *    while a frame is in edit mode) is owned by a LATER sub-workstream's
 *    edit-mode layer; this component always renders `pointer-events: none`
 *    on its iframe, matching frame-shape.tsx's own non-edit-mode default.
 *  - Selection is a `selected` boolean prop, rendered as the same blue
 *    2px outline `frame-shape.tsx` would (see the `border` style below) —
 *    sub-workstream 2c (`selection-gestures.ts`/`Canvas.tsx`) is what
 *    actually SETS this prop via real click/marquee interaction.
 *
 * Sub-workstream 2c ALSO adds the `data-ccs-frame-id` attribute on the root
 * div: `Canvas.tsx` needs to know "which frame (if any) is under this
 * pointer" on every pointer-down to drive `selection-gestures.ts` (a frame
 * hit vs. empty background) — a plain DOM data-attribute lookup
 * (`target.closest('[data-ccs-frame-id]')`) from `Canvas.tsx`'s own
 * native pointer-event listener is simpler and avoids an extra prop/
 * cross-component relay entirely (no event handler needed here at all —
 * `Canvas.tsx`'s listener sits on an ANCESTOR element and reads this
 * attribute directly off whatever native `event.target` bubbled up to it).
 */

export interface FrameShapeProps {
  /** Stable frame id (matches `CameraFrame.id` / `CanvasFrameRecord.id`).
   * Sub-workstream 2c: also rendered as the root div's `data-ccs-frame-id`
   * attribute so `Canvas.tsx` can hit-test which frame (if any) a pointer
   * event landed on. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Filename without extension — the chrome header label (matches
   * `CanvasFrameRecord.name`). */
  name: string;
  /** Full iframe src, already including `?frame=<Name>` (matches
   * `CanvasFrameRecord.devServerUrl`). */
  devServerUrl: string;
  /** Whether this frame is in `viewport-cull.ts`'s `selectLiveFrames`
   * result for THIS render (parent computes this over all frames at once —
   * see module doc). `true` mounts a real `<iframe>`; `false` renders
   * `FramePlaceholder`. */
  live: boolean;
  /** Simple selection-outline affordance for a future sub-workstream (2c)
   * to drive — no interaction logic here sets this. */
  selected?: boolean;
}

/** Lightweight labeled placeholder for a non-live frame — ported verbatim
 * from `frame-shape.tsx`'s `FramePlaceholder` (same styling, same "reads
 * as a board, never a blank void" intent). */
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

/**
 * One frame's rendering — mounted by `Canvas.tsx` at page-space
 * `left: x, top: y, width: w, height: h` inside the transformed world div.
 * This component itself doesn't apply the camera transform or its own
 * screen position; it just renders its own box's contents.
 */
export function FrameShape({ id, x, y, w, h, name, devServerUrl, live, selected }: FrameShapeProps): React.ReactElement {
  return (
    <div
      data-ccs-frame-id={id}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        border: selected ? '2px solid #3b82f6' : '1px solid #d4d4d8',
        borderRadius: 4,
        overflow: 'hidden',
        // Sub-workstream 2c: a selected frame's body is draggable (see
        // `Canvas.tsx`'s drag-to-move wiring) — 'move' communicates that;
        // an unselected frame just shows the default pointer.
        cursor: selected ? 'move' : 'default',
        // Perf gate (ported verbatim from frame-shape.tsx): content-visibility
        // + contain on frame containers — cheap, and helps the browser skip
        // layout/paint work for frames the parent hasn't culled from the DOM
        // yet (a placeholder still costs a DOM node even though it's cheap).
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
        {name}
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        {live ? (
          <iframe
            src={devServerUrl}
            title={name}
            // Security (playbook §5.8, ported from frame-shape.tsx):
            // scripts + same-origin only, and only ever pointed at a
            // 127.0.0.1 dev server by the caller.
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              // Always 'none' in this sub-workstream (2b) — edit-mode
              // pointer-events toggling is owned by a later sub-workstream's
              // edit-mode layer; this matches frame-shape.tsx's own
              // non-edit-mode default.
              pointerEvents: 'none',
            }}
          />
        ) : (
          <FramePlaceholder name={name} />
        )}
      </div>
    </div>
  );
}
