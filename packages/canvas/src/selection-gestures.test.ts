import { describe, expect, it, vi } from 'vitest';
import { createSelectionGestureController, type SelectionGesturePointerInfo } from './selection-gestures.js';
import type { Box } from './geometry.js';

function pointerInfo(overrides: Partial<SelectionGesturePointerInfo>): SelectionGesturePointerInfo {
  return {
    pointerId: 1,
    screenPoint: { x: 0, y: 0 },
    pagePoint: { x: 0, y: 0 },
    shiftKey: false,
    frameId: null,
    ...overrides,
  };
}

interface Harness {
  select: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  onMarqueeChange: ReturnType<typeof vi.fn>;
  selected: Set<string>;
  frameBoxes: Map<string, Box>;
  controller: ReturnType<typeof createSelectionGestureController>;
}

function makeHarness(initialSelection: string[] = [], frameBoxes: Map<string, Box> = new Map()): Harness {
  const selected = new Set(initialSelection);
  const select = vi.fn((ids: string[]) => {
    selected.clear();
    for (const id of ids) selected.add(id);
  });
  const clearSelection = vi.fn(() => selected.clear());
  const onMarqueeChange = vi.fn();
  const controller = createSelectionGestureController({
    getSelectedIds: () => selected,
    getFrameBoxes: () => frameBoxes,
    select,
    clearSelection,
    onMarqueeChange,
  });
  return { select, clearSelection, onMarqueeChange, selected, frameBoxes, controller };
}

describe('click / shift-click on a frame', () => {
  it('plain click on an unselected frame selects only it, immediately at pointer-down', () => {
    const h = makeHarness();
    h.controller.onPointerDown(pointerInfo({ frameId: 'a' }));
    expect(h.select).toHaveBeenCalledWith(['a']);
    expect(h.selected).toEqual(new Set(['a']));
    // No drag, no shift: pointer-up should not change anything further.
    h.controller.onPointerUp(pointerInfo({ frameId: null }));
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('plain click replaces a previous multi-selection with just the clicked frame', () => {
    const h = makeHarness(['a', 'b']);
    // Clicking 'b' (already part of the selection) with no shift, no drag.
    h.controller.onPointerDown(pointerInfo({ frameId: 'b' }));
    // Selection change is deferred to pointer-up (no drag happened yet).
    expect(h.selected).toEqual(new Set(['a', 'b']));
    h.controller.onPointerUp(pointerInfo({ frameId: null }));
    expect(h.select).toHaveBeenCalledWith(['b']);
    expect(h.selected).toEqual(new Set(['b']));
  });

  it('shift-click on an unselected frame adds it (toggle-add)', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'b', shiftKey: true }));
    expect(h.selected).toEqual(new Set(['a', 'b']));
    h.controller.onPointerUp(pointerInfo({ frameId: null, shiftKey: true }));
    // Nothing further changes on pointer-up for a shift-click.
    expect(h.select).toHaveBeenCalledTimes(1);
  });

  it('shift-click on an already-selected frame removes it (toggle-remove)', () => {
    const h = makeHarness(['a', 'b']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'b', shiftKey: true }));
    expect(h.selected).toEqual(new Set(['a']));
  });

  it('shift-click toggle happens immediately at pointer-down, not deferred', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'a', shiftKey: true }));
    expect(h.selected).toEqual(new Set());
    expect(h.select).toHaveBeenCalledTimes(1);
  });
});

describe('click on empty background', () => {
  it('clears the selection on pointer-up with no drag', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: null }));
    expect(h.clearSelection).not.toHaveBeenCalled();
    h.controller.onPointerUp(pointerInfo({ frameId: null }));
    expect(h.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('does not clear selection if a marquee drag happened instead', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: null, screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 20, y: 20 }, pagePoint: { x: 20, y: 20 } }));
    h.controller.onPointerUp(pointerInfo({ frameId: null, screenPoint: { x: 20, y: 20 }, pagePoint: { x: 20, y: 20 } }));
    expect(h.clearSelection).not.toHaveBeenCalled();
  });
});

describe('marquee hit-testing', () => {
  const frameBoxes = new Map<string, Box>([
    ['fully-inside', { x: 10, y: 10, w: 20, h: 20 }],
    ['partial-overlap', { x: 90, y: 90, w: 40, h: 40 }],
    ['no-overlap', { x: 500, y: 500, w: 10, h: 10 }],
  ]);

  function drag(h: Harness, from: { x: number; y: number }, to: { x: number; y: number }, shiftKey = false) {
    h.controller.onPointerDown(pointerInfo({ frameId: null, screenPoint: from, pagePoint: from, shiftKey }));
    h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: to, pagePoint: to, shiftKey }));
    h.controller.onPointerUp(pointerInfo({ frameId: null, screenPoint: to, pagePoint: to, shiftKey }));
  }

  it('marquee dragged past the threshold reports the box via onMarqueeChange', () => {
    const h = makeHarness([], frameBoxes);
    h.controller.onPointerDown(pointerInfo({ frameId: null, screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    expect(h.onMarqueeChange).not.toHaveBeenCalled();
    h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 50, y: 50 }, pagePoint: { x: 50, y: 50 } }));
    expect(h.onMarqueeChange).toHaveBeenCalledWith({ x: 0, y: 0, w: 50, h: 50 });
  });

  it('a movement below the drag threshold does not start a marquee', () => {
    const h = makeHarness([], frameBoxes);
    h.controller.onPointerDown(pointerInfo({ frameId: null, screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 1, y: 1 }, pagePoint: { x: 1, y: 1 } }));
    expect(h.onMarqueeChange).not.toHaveBeenCalled();
    expect(h.controller.isMarqueeActive()).toBe(false);
  });

  it('selects only frames fully contained by the marquee', () => {
    const h = makeHarness([], frameBoxes);
    // Marquee box exactly covering 'fully-inside' (10,10 to 30,30) with margin.
    drag(h, { x: 0, y: 0 }, { x: 35, y: 35 });
    expect(h.select).toHaveBeenCalledWith(['fully-inside']);
  });

  it('selects a frame with only PARTIAL overlap', () => {
    const h = makeHarness([], frameBoxes);
    // Marquee from (80,80) to (100,100) partially overlaps 'partial-overlap' (90,90,40,40).
    drag(h, { x: 80, y: 80 }, { x: 100, y: 100 });
    expect(h.select).toHaveBeenCalledWith(['partial-overlap']);
  });

  it('does not select a frame with no overlap at all', () => {
    const h = makeHarness([], frameBoxes);
    drag(h, { x: 0, y: 0 }, { x: 60, y: 60 });
    const selectedArg = h.select.mock.calls.at(-1)?.[0] as string[];
    expect(selectedArg).not.toContain('no-overlap');
  });

  it('selects every frame intersecting a marquee covering multiple frames', () => {
    const h = makeHarness([], frameBoxes);
    drag(h, { x: 0, y: 0 }, { x: 140, y: 140 });
    const selectedArg = new Set(h.select.mock.calls.at(-1)?.[0] as string[]);
    expect(selectedArg).toEqual(new Set(['fully-inside', 'partial-overlap']));
  });

  it('a marquee that hits nothing selects an empty array (replacing any prior selection)', () => {
    const h = makeHarness(['fully-inside'], frameBoxes);
    drag(h, { x: 200, y: 200 }, { x: 260, y: 260 });
    expect(h.select).toHaveBeenCalledWith([]);
  });

  it('plain marquee REPLACES the existing selection', () => {
    const h = makeHarness(['no-overlap'], frameBoxes);
    drag(h, { x: 0, y: 0 }, { x: 35, y: 35 });
    expect(h.select).toHaveBeenCalledWith(['fully-inside']);
  });

  it('shift+marquee ADDS to the existing selection instead of replacing it', () => {
    const h = makeHarness(['no-overlap'], frameBoxes);
    drag(h, { x: 0, y: 0 }, { x: 35, y: 35 }, true);
    const selectedArg = new Set(h.select.mock.calls.at(-1)?.[0] as string[]);
    expect(selectedArg).toEqual(new Set(['no-overlap', 'fully-inside']));
  });

  it('onMarqueeChange is called with null once the marquee ends', () => {
    const h = makeHarness([], frameBoxes);
    drag(h, { x: 0, y: 0 }, { x: 35, y: 35 });
    expect(h.onMarqueeChange).toHaveBeenLastCalledWith(null);
  });

  it('the marquee box normalizes regardless of drag direction (dragging up-left)', () => {
    const h = makeHarness([], frameBoxes);
    h.controller.onPointerDown(pointerInfo({ frameId: null, screenPoint: { x: 100, y: 100 }, pagePoint: { x: 100, y: 100 } }));
    h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 20, y: 20 }, pagePoint: { x: 20, y: 20 } }));
    expect(h.onMarqueeChange).toHaveBeenCalledWith({ x: 20, y: 20, w: 80, h: 80 });
  });
});

describe('drag-to-move start signaling (onPointerMove return value)', () => {
  it('returns frame-drag-start once the pointer crosses the threshold on an ALREADY-selected frame', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'a', screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    const first = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 1, y: 0 }, pagePoint: { x: 1, y: 0 } }));
    expect(first).toEqual({ type: 'none' });
    const result = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 10, y: 0 }, pagePoint: { x: 10, y: 0 } }));
    expect(result).toEqual({ type: 'frame-drag-start', frameId: 'a', startPagePoint: { x: 0, y: 0 } });
    // Selection is left exactly as it was — no collapse on pointer-up.
    h.controller.onPointerUp(pointerInfo({ frameId: null, screenPoint: { x: 10, y: 0 }, pagePoint: { x: 10, y: 0 } }));
    expect(h.select).not.toHaveBeenCalled();
  });

  it('returns frame-drag-start for a freshly-selected (previously unselected) frame too', () => {
    const h = makeHarness([]);
    h.controller.onPointerDown(pointerInfo({ frameId: 'a', screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    const result = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 10, y: 0 }, pagePoint: { x: 10, y: 0 } }));
    expect(result).toEqual({ type: 'frame-drag-start', frameId: 'a', startPagePoint: { x: 0, y: 0 } });
  });

  it('never returns frame-drag-start for a shift-click drag', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'a', shiftKey: true, screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    const result = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 10, y: 0 }, pagePoint: { x: 10, y: 0 } }));
    expect(result).toEqual({ type: 'none' });
  });

  it('only returns frame-drag-start once per gesture even with multiple subsequent moves', () => {
    const h = makeHarness(['a']);
    h.controller.onPointerDown(pointerInfo({ frameId: 'a', screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    const first = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 10, y: 0 }, pagePoint: { x: 10, y: 0 } }));
    expect(first.type).toBe('frame-drag-start');
    const second = h.controller.onPointerMove(pointerInfo({ frameId: null, screenPoint: { x: 20, y: 0 }, pagePoint: { x: 20, y: 0 } }));
    expect(second).toEqual({ type: 'none' });
  });
});

describe('pointerId isolation', () => {
  it('ignores a move/up from a pointerId different from the one that started the gesture', () => {
    const h = makeHarness([], new Map([['a', { x: 0, y: 0, w: 10, h: 10 }]]));
    h.controller.onPointerDown(pointerInfo({ pointerId: 1, frameId: null, screenPoint: { x: 0, y: 0 }, pagePoint: { x: 0, y: 0 } }));
    h.controller.onPointerMove(pointerInfo({ pointerId: 2, frameId: null, screenPoint: { x: 50, y: 50 }, pagePoint: { x: 50, y: 50 } }));
    expect(h.onMarqueeChange).not.toHaveBeenCalled();
    h.controller.onPointerUp(pointerInfo({ pointerId: 2, frameId: null }));
    expect(h.clearSelection).not.toHaveBeenCalled();
  });
});
