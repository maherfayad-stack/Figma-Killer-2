import { describe, expect, it, vi } from 'vitest';
import {
  computeResizedBox,
  createResizeGestureController,
  MIN_FRAME_SIZE,
  resizeHandleCursor,
  resizeHandleScreenPoint,
  RESIZE_HANDLES,
} from './resize-gestures.js';
import type { Box } from './geometry.js';

const BOX: Box = { x: 100, y: 100, w: 200, h: 150 }; // spans (100,100) to (300,250)

describe('computeResizedBox — corners', () => {
  it('"se" (bottom-right) grows w/h and keeps the top-left corner fixed', () => {
    const result = computeResizedBox(BOX, 'se', { x: 30, y: 20 });
    expect(result).toEqual({ x: 100, y: 100, w: 230, h: 170 });
  });

  it('"nw" (top-left) moves x/y and keeps the bottom-right corner fixed', () => {
    const result = computeResizedBox(BOX, 'nw', { x: -30, y: -20 });
    expect(result).toEqual({ x: 70, y: 80, w: 230, h: 170 });
  });

  it('"ne" (top-right) moves the top edge + grows width, keeps bottom-left fixed', () => {
    const result = computeResizedBox(BOX, 'ne', { x: 30, y: -20 });
    // right = 300+30=330 -> w=230; top = 100-20=80 -> h = 250-80=170
    expect(result).toEqual({ x: 100, y: 80, w: 230, h: 170 });
  });

  it('"sw" (bottom-left) moves the left edge + grows height, keeps top-right fixed', () => {
    const result = computeResizedBox(BOX, 'sw', { x: -30, y: 20 });
    // left = 100-30=70 -> w = 300-70=230; bottom = 250+20=270 -> h=270-100=170
    expect(result).toEqual({ x: 70, y: 100, w: 230, h: 170 });
  });
});

describe('computeResizedBox — edge midpoints', () => {
  it('"n" moves only the top edge', () => {
    const result = computeResizedBox(BOX, 'n', { x: 999, y: -10 });
    expect(result).toEqual({ x: 100, y: 90, w: 200, h: 160 });
  });

  it('"s" moves only the bottom edge', () => {
    const result = computeResizedBox(BOX, 's', { x: 999, y: 10 });
    expect(result).toEqual({ x: 100, y: 100, w: 200, h: 160 });
  });

  it('"e" moves only the right edge', () => {
    const result = computeResizedBox(BOX, 'e', { x: 10, y: 999 });
    expect(result).toEqual({ x: 100, y: 100, w: 210, h: 150 });
  });

  it('"w" moves only the left edge', () => {
    const result = computeResizedBox(BOX, 'w', { x: -10, y: 999 });
    expect(result).toEqual({ x: 90, y: 100, w: 210, h: 150 });
  });
});

describe('computeResizedBox — min-size clamp', () => {
  it('clamps "se" so w/h never drop below minSize, keeping top-left fixed', () => {
    const result = computeResizedBox(BOX, 'se', { x: -500, y: -500 });
    expect(result).toEqual({ x: 100, y: 100, w: MIN_FRAME_SIZE, h: MIN_FRAME_SIZE });
  });

  it('clamps "nw" so w/h never drop below minSize, keeping bottom-right fixed', () => {
    const result = computeResizedBox(BOX, 'nw', { x: 500, y: 500 });
    expect(result).toEqual({ x: 300 - MIN_FRAME_SIZE, y: 250 - MIN_FRAME_SIZE, w: MIN_FRAME_SIZE, h: MIN_FRAME_SIZE });
  });

  it('clamps "ne" (right grows via w, top clamps via h) independently per axis', () => {
    const result = computeResizedBox(BOX, 'ne', { x: -500, y: 500 });
    // right clamps to left+minSize; top clamps to bottom-minSize.
    expect(result).toEqual({ x: 100, y: 250 - MIN_FRAME_SIZE, w: MIN_FRAME_SIZE, h: MIN_FRAME_SIZE });
  });

  it('clamps "sw" independently per axis', () => {
    const result = computeResizedBox(BOX, 'sw', { x: 500, y: -500 });
    expect(result).toEqual({ x: 300 - MIN_FRAME_SIZE, y: 100, w: MIN_FRAME_SIZE, h: MIN_FRAME_SIZE });
  });

  it('respects a custom minSize option', () => {
    const result = computeResizedBox(BOX, 'se', { x: -500, y: -500 }, 10);
    expect(result).toEqual({ x: 100, y: 100, w: 10, h: 10 });
  });

  it('an edge handle also respects the min-size clamp on its single axis', () => {
    const result = computeResizedBox(BOX, 'n', { x: 0, y: 500 });
    expect(result).toEqual({ x: 100, y: 250 - MIN_FRAME_SIZE, w: 200, h: MIN_FRAME_SIZE });
  });

  it('a zero delta never violates the clamp (box already >= minSize)', () => {
    const result = computeResizedBox(BOX, 'se', { x: 0, y: 0 });
    expect(result).toEqual(BOX);
  });
});

describe('resizeHandleScreenPoint', () => {
  const screenBox: Box = { x: 10, y: 20, w: 100, h: 60 };

  it('places corners exactly on the box corners', () => {
    expect(resizeHandleScreenPoint(screenBox, 'nw')).toEqual({ x: 10, y: 20 });
    expect(resizeHandleScreenPoint(screenBox, 'ne')).toEqual({ x: 110, y: 20 });
    expect(resizeHandleScreenPoint(screenBox, 'se')).toEqual({ x: 110, y: 80 });
    expect(resizeHandleScreenPoint(screenBox, 'sw')).toEqual({ x: 10, y: 80 });
  });

  it('places edge handles at each edge midpoint', () => {
    expect(resizeHandleScreenPoint(screenBox, 'n')).toEqual({ x: 60, y: 20 });
    expect(resizeHandleScreenPoint(screenBox, 's')).toEqual({ x: 60, y: 80 });
    expect(resizeHandleScreenPoint(screenBox, 'e')).toEqual({ x: 110, y: 50 });
    expect(resizeHandleScreenPoint(screenBox, 'w')).toEqual({ x: 10, y: 50 });
  });
});

describe('resizeHandleCursor', () => {
  it('gives every handle a defined cursor', () => {
    for (const handle of RESIZE_HANDLES) {
      expect(typeof resizeHandleCursor(handle)).toBe('string');
    }
  });

  it('diagonal corners use the diagonal-resize cursors', () => {
    expect(resizeHandleCursor('nw')).toBe('nwse-resize');
    expect(resizeHandleCursor('se')).toBe('nwse-resize');
    expect(resizeHandleCursor('ne')).toBe('nesw-resize');
    expect(resizeHandleCursor('sw')).toBe('nesw-resize');
  });

  it('edges use axis-aligned cursors', () => {
    expect(resizeHandleCursor('n')).toBe('ns-resize');
    expect(resizeHandleCursor('s')).toBe('ns-resize');
    expect(resizeHandleCursor('e')).toBe('ew-resize');
    expect(resizeHandleCursor('w')).toBe('ew-resize');
  });
});

describe('createResizeGestureController', () => {
  it('calls onResize with the live box on every move, and onResizeEnd once on pointer-up', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const controller = createResizeGestureController({ onResize, onResizeEnd });

    controller.startResize('frame-1', 'se', BOX, { x: 0, y: 0 }, 7);
    expect(controller.isResizing()).toBe(true);

    controller.onPointerMove(7, { x: 10, y: 10 });
    expect(onResize).toHaveBeenCalledWith('frame-1', { x: 100, y: 100, w: 210, h: 160 });

    controller.onPointerMove(7, { x: 20, y: 20 });
    expect(onResize).toHaveBeenLastCalledWith('frame-1', { x: 100, y: 100, w: 220, h: 170 });

    controller.onPointerUp(7, { x: 20, y: 20 });
    expect(onResizeEnd).toHaveBeenCalledWith('frame-1', { x: 100, y: 100, w: 220, h: 170 });
    expect(controller.isResizing()).toBe(false);
  });

  it('ignores move/up events from a different pointerId than the active resize', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const controller = createResizeGestureController({ onResize, onResizeEnd });

    controller.startResize('frame-1', 'se', BOX, { x: 0, y: 0 }, 1);
    controller.onPointerMove(2, { x: 50, y: 50 });
    expect(onResize).not.toHaveBeenCalled();
    controller.onPointerUp(2, { x: 50, y: 50 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    expect(controller.isResizing()).toBe(true);
  });

  it('move/up before any startResize is a no-op', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const controller = createResizeGestureController({ onResize, onResizeEnd });
    controller.onPointerMove(1, { x: 10, y: 10 });
    controller.onPointerUp(1, { x: 10, y: 10 });
    expect(onResize).not.toHaveBeenCalled();
    expect(onResizeEnd).not.toHaveBeenCalled();
  });

  it('respects a custom minSize passed through to computeResizedBox', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    const controller = createResizeGestureController({ onResize, onResizeEnd, minSize: 5 });
    controller.startResize('frame-1', 'se', BOX, { x: 0, y: 0 }, 1);
    controller.onPointerUp(1, { x: -500, y: -500 });
    expect(onResizeEnd).toHaveBeenCalledWith('frame-1', { x: 100, y: 100, w: 5, h: 5 });
  });
});
