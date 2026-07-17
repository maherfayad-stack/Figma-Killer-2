import { describe, expect, it } from 'vitest';
import { computeReorderDropIndex, dropIndicatorBox, distance, DRAG_THRESHOLD_PX } from './drag-geometry.js';
import type { SiblingRect } from './drag-geometry.js';

const ROW_SIBLINGS: SiblingRect[] = [
  { uid: 'a', rect: { x: 0, y: 0, width: 100, height: 50 } }, // center x=50
  { uid: 'b', rect: { x: 100, y: 0, width: 100, height: 50 } }, // center x=150
  { uid: 'c', rect: { x: 200, y: 0, width: 100, height: 50 } }, // center x=250
];

const COLUMN_SIBLINGS: SiblingRect[] = [
  { uid: 'a', rect: { x: 0, y: 0, width: 100, height: 50 } }, // center y=25
  { uid: 'b', rect: { x: 0, y: 50, width: 100, height: 50 } }, // center y=75
];

describe('computeReorderDropIndex', () => {
  it('row axis: returns 0 when pointer is before every sibling center', () => {
    expect(computeReorderDropIndex('row', ROW_SIBLINGS, { x: -10, y: 25 })).toBe(0);
  });

  it('row axis: returns the sibling count when pointer is after every center', () => {
    expect(computeReorderDropIndex('row', ROW_SIBLINGS, { x: 999, y: 25 })).toBe(3);
  });

  it('row axis: returns the gap index for a pointer between two centers', () => {
    expect(computeReorderDropIndex('row', ROW_SIBLINGS, { x: 120, y: 25 })).toBe(1); // between a(50) and b(150)
    expect(computeReorderDropIndex('row', ROW_SIBLINGS, { x: 220, y: 25 })).toBe(2); // between b(150) and c(250)
  });

  it('column axis: uses the y coordinate instead of x', () => {
    expect(computeReorderDropIndex('column', COLUMN_SIBLINGS, { x: 50, y: -10 })).toBe(0);
    expect(computeReorderDropIndex('column', COLUMN_SIBLINGS, { x: 50, y: 50 })).toBe(1);
    expect(computeReorderDropIndex('column', COLUMN_SIBLINGS, { x: 50, y: 999 })).toBe(2);
  });

  it('empty siblings list (dragging the only child out and back): always index 0', () => {
    expect(computeReorderDropIndex('row', [], { x: 42, y: 0 })).toBe(0);
  });
});

describe('dropIndicatorBox', () => {
  const parentRect = { x: 0, y: 0, width: 300, height: 50 };

  it('row axis: a vertical line at each sibling boundary/gap, spanning the full parent height', () => {
    const first = dropIndicatorBox('row', ROW_SIBLINGS, 0, parentRect);
    expect(first.x).toBeCloseTo(0 - 2); // ROW_SIBLINGS[0].x, thickness/2=2
    expect(first.y).toBe(0);
    expect(first.h).toBe(50);

    const middle = dropIndicatorBox('row', ROW_SIBLINGS, 1, parentRect);
    expect(middle.x).toBeCloseTo(100 - 2); // midpoint of a's end (100) and b's start (100)

    const last = dropIndicatorBox('row', ROW_SIBLINGS, 3, parentRect);
    expect(last.x).toBeCloseTo(300 - 2); // c's end edge
  });

  it('column axis: a horizontal line spanning the full parent width', () => {
    const box = dropIndicatorBox('column', COLUMN_SIBLINGS, 1, { x: 0, y: 0, width: 300, height: 100 });
    expect(box.w).toBe(300);
    expect(box.y).toBeCloseTo(50 - 2); // between a's end(50) and b's start(50)
  });

  it('degenerates to a centered line when there are no siblings at all', () => {
    const box = dropIndicatorBox('row', [], 0, parentRect);
    expect(box.x).toBeCloseTo(150 - 2); // parent center
  });
});

describe('distance / DRAG_THRESHOLD_PX', () => {
  it('computes euclidean distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('exposes a small positive pixel threshold', () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(DRAG_THRESHOLD_PX).toBeLessThan(20);
  });
});
