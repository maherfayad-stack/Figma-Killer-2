import { beforeEach, describe, expect, it } from 'vitest';
import { useCameraStore, ZOOM_STEP_FACTOR, MIN_ZOOM, MAX_ZOOM, type CameraFrame } from './camera-store.js';
import { pagePointToScreenSpace } from './geometry.js';

const VIEWPORT = { w: 1000, h: 800 };

function resetStore(): void {
  useCameraStore.setState({
    camera: { x: 0, y: 0, z: 1 },
    frames: new Map(),
    selectedIds: new Set(),
  });
}

beforeEach(() => {
  resetStore();
});

describe('setFrames / setCamera', () => {
  it('replaces the frames map keyed by id', () => {
    const frames: CameraFrame[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 200, y: 0, w: 100, h: 100 },
    ];
    useCameraStore.getState().setFrames(frames);
    const stored = useCameraStore.getState().frames;
    expect(stored.size).toBe(2);
    expect(stored.get('a')).toEqual(frames[0]);
    expect(stored.get('b')).toEqual(frames[1]);
  });

  it('setFrames with an empty array clears any previous frames', () => {
    useCameraStore.getState().setFrames([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }]);
    useCameraStore.getState().setFrames([]);
    expect(useCameraStore.getState().frames.size).toBe(0);
  });

  it('setCamera directly assigns the camera', () => {
    useCameraStore.getState().setCamera({ x: 42, y: -7, z: 3 });
    expect(useCameraStore.getState().camera).toEqual({ x: 42, y: -7, z: 3 });
  });
});

describe('pan', () => {
  it('at zoom 1, screen delta equals page-space camera delta', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 1 });
    useCameraStore.getState().pan(50, -20);
    expect(useCameraStore.getState().camera).toEqual({ x: 50, y: -20, z: 1 });
  });

  it('at 2x zoom, a screen delta is halved in page space', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 2 });
    useCameraStore.getState().pan(50, -20);
    expect(useCameraStore.getState().camera).toEqual({ x: 25, y: -10, z: 2 });
  });

  it('at 0.5x zoom, a screen delta is doubled in page space', () => {
    useCameraStore.getState().setCamera({ x: 10, y: 10, z: 0.5 });
    useCameraStore.getState().pan(10, 10);
    expect(useCameraStore.getState().camera).toEqual({ x: 30, y: 30, z: 0.5 });
  });

  it('keeps the point under a fixed screen position visually fixed while panning (drag semantics)', () => {
    useCameraStore.getState().setCamera({ x: 5, y: 5, z: 1.5 });
    const screenPoint = { x: 300, y: 200 };
    const pagePointBefore = {
      x: screenPoint.x / 1.5 - 5,
      y: screenPoint.y / 1.5 - 5,
    };
    useCameraStore.getState().pan(30, 15);
    // The page point that WAS under screenPoint now renders `(30,15)` screen
    // px away from where it used to (screen = (page + camera) * z) — i.e.
    // the content moved with the drag by exactly the screen delta.
    const after = pagePointToScreenSpace(useCameraStore.getState().camera, pagePointBefore);
    expect(after.x).toBeCloseTo(screenPoint.x + 30, 10);
    expect(after.y).toBeCloseTo(screenPoint.y + 15, 10);
  });
});

describe('zoomAtPoint', () => {
  it('keeps the page-space point under screenPoint fixed on screen after zooming', () => {
    useCameraStore.getState().setCamera({ x: -100, y: -50, z: 1 });
    const screenPoint = { x: 400, y: 300 };
    const camBefore = useCameraStore.getState().camera;
    const pagePointBefore = {
      x: screenPoint.x / camBefore.z - camBefore.x,
      y: screenPoint.y / camBefore.z - camBefore.y,
    };

    useCameraStore.getState().zoomAtPoint(3, screenPoint, VIEWPORT);

    expect(useCameraStore.getState().camera.z).toBe(3);
    const screenAfter = pagePointToScreenSpace(useCameraStore.getState().camera, pagePointBefore);
    expect(screenAfter.x).toBeCloseTo(screenPoint.x, 10);
    expect(screenAfter.y).toBeCloseTo(screenPoint.y, 10);
  });

  it('works identically when zooming out (newZoom < current z)', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 4 });
    const screenPoint = { x: 120, y: 90 };
    const pagePointBefore = { x: screenPoint.x / 4, y: screenPoint.y / 4 };

    useCameraStore.getState().zoomAtPoint(1, screenPoint, VIEWPORT);

    expect(useCameraStore.getState().camera.z).toBe(1);
    const screenAfter = pagePointToScreenSpace(useCameraStore.getState().camera, pagePointBefore);
    expect(screenAfter.x).toBeCloseTo(screenPoint.x, 10);
    expect(screenAfter.y).toBeCloseTo(screenPoint.y, 10);
  });

  it('zooming at the origin (screenPoint 0,0) with identity camera keeps page origin at screen origin', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 1 });
    useCameraStore.getState().zoomAtPoint(5, { x: 0, y: 0 }, VIEWPORT);
    expect(useCameraStore.getState().camera).toEqual({ x: 0, y: 0, z: 5 });
  });
});

describe('zoomIn / zoomOut', () => {
  it('zoomIn multiplies the current zoom by ZOOM_STEP_FACTOR, anchored at the viewport center', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 1 });
    useCameraStore.getState().zoomIn(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(ZOOM_STEP_FACTOR, 10);
  });

  it('zoomOut divides the current zoom by ZOOM_STEP_FACTOR', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: 1 });
    useCameraStore.getState().zoomOut(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1 / ZOOM_STEP_FACTOR, 10);
  });

  it('zoomIn then zoomOut returns to the original zoom (inverse factors)', () => {
    useCameraStore.getState().setCamera({ x: 3, y: 3, z: 2 });
    useCameraStore.getState().zoomIn(VIEWPORT);
    useCameraStore.getState().zoomOut(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(2, 10);
  });

  it('keeps the viewport-center page point fixed at the viewport center after a step', () => {
    useCameraStore.getState().setCamera({ x: -50, y: -25, z: 1 });
    const center = { x: VIEWPORT.w / 2, y: VIEWPORT.h / 2 };
    const camBefore = useCameraStore.getState().camera;
    const centerPageBefore = { x: center.x / camBefore.z - camBefore.x, y: center.y / camBefore.z - camBefore.y };

    useCameraStore.getState().zoomIn(VIEWPORT);

    const screenAfter = pagePointToScreenSpace(useCameraStore.getState().camera, centerPageBefore);
    expect(screenAfter.x).toBeCloseTo(center.x, 10);
    expect(screenAfter.y).toBeCloseTo(center.y, 10);
  });

  it('zoomIn is clamped at MAX_ZOOM', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: MAX_ZOOM });
    useCameraStore.getState().zoomIn(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBe(MAX_ZOOM);
  });

  it('zoomOut is clamped at MIN_ZOOM', () => {
    useCameraStore.getState().setCamera({ x: 0, y: 0, z: MIN_ZOOM });
    useCameraStore.getState().zoomOut(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBe(MIN_ZOOM);
  });
});

describe('resetZoom', () => {
  it('sets z back to 1', () => {
    useCameraStore.getState().setCamera({ x: 10, y: 10, z: 3.5 });
    useCameraStore.getState().resetZoom(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBe(1);
  });

  it('keeps the page point currently at the viewport center still centered afterwards', () => {
    useCameraStore.getState().setCamera({ x: -40, y: 60, z: 2.5 });
    const center = { x: VIEWPORT.w / 2, y: VIEWPORT.h / 2 };
    const camBefore = useCameraStore.getState().camera;
    const centerPageBefore = { x: center.x / camBefore.z - camBefore.x, y: center.y / camBefore.z - camBefore.y };

    useCameraStore.getState().resetZoom(VIEWPORT);

    const screenAfter = pagePointToScreenSpace(useCameraStore.getState().camera, centerPageBefore);
    expect(screenAfter.x).toBeCloseTo(center.x, 10);
    expect(screenAfter.y).toBeCloseTo(center.y, 10);
  });
});

describe('zoomToBounds', () => {
  it('fits a box exactly with no inset/targetZoom, centering the camera on it', () => {
    const box = { x: 0, y: 0, w: 1000, h: 800 }; // exactly matches VIEWPORT aspect ratio
    useCameraStore.getState().zoomToBounds(box, VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1, 10);
    const screenTopLeft = pagePointToScreenSpace(useCameraStore.getState().camera, { x: 0, y: 0 });
    const screenBottomRight = pagePointToScreenSpace(useCameraStore.getState().camera, { x: 1000, y: 800 });
    expect(screenTopLeft.x).toBeCloseTo(0, 6);
    expect(screenTopLeft.y).toBeCloseTo(0, 6);
    expect(screenBottomRight.x).toBeCloseTo(1000, 6);
    expect(screenBottomRight.y).toBeCloseTo(800, 6);
  });

  it('picks the narrower axis when the box is wider than the viewport aspect ratio', () => {
    // Box is very wide relative to viewport (2000x100 vs 1000x800) -> width-constrained.
    const box = { x: 0, y: 0, w: 2000, h: 100 };
    useCameraStore.getState().zoomToBounds(box, VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1000 / 2000, 10);
  });

  it('picks the narrower axis when the box is taller than the viewport aspect ratio', () => {
    const box = { x: 0, y: 0, w: 100, h: 2000 };
    useCameraStore.getState().zoomToBounds(box, VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(800 / 2000, 10);
  });

  it('applies inset, shrinking the effective viewport used for the fit', () => {
    const box = { x: 0, y: 0, w: 1000, h: 800 };
    useCameraStore.getState().zoomToBounds(box, VIEWPORT, { inset: 200 });
    // available = 800x600 -> widthZoom = 800/1000 = 0.8, heightZoom = 600/800
    // = 0.75 -> height-constrained, fitZoom = 0.75 (the smaller of the two).
    expect(useCameraStore.getState().camera.z).toBeCloseTo(0.75, 10);
  });

  it('clamps to targetZoom when the fit zoom would exceed it', () => {
    const box = { x: 0, y: 0, w: 50, h: 50 }; // tiny box -> huge fit zoom
    useCameraStore.getState().zoomToBounds(box, VIEWPORT, { targetZoom: 2 });
    expect(useCameraStore.getState().camera.z).toBe(2);
  });

  it('does not clamp when the fit zoom is already below targetZoom', () => {
    const box = { x: 0, y: 0, w: 1000, h: 800 };
    useCameraStore.getState().zoomToBounds(box, VIEWPORT, { targetZoom: 5 });
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1, 10);
  });

  it('centers the camera on the box midpoint', () => {
    const box = { x: 100, y: 200, w: 100, h: 100 };
    useCameraStore.getState().zoomToBounds(box, VIEWPORT);
    const midpoint = { x: 150, y: 250 };
    const screenMidpoint = pagePointToScreenSpace(useCameraStore.getState().camera, midpoint);
    expect(screenMidpoint.x).toBeCloseTo(VIEWPORT.w / 2, 6);
    expect(screenMidpoint.y).toBeCloseTo(VIEWPORT.h / 2, 6);
  });
});

describe('zoomToFit', () => {
  it('is a no-op when there are no frames', () => {
    useCameraStore.getState().setCamera({ x: 7, y: 7, z: 3 });
    useCameraStore.getState().zoomToFit(VIEWPORT);
    expect(useCameraStore.getState().camera).toEqual({ x: 7, y: 7, z: 3 });
  });

  it('fits the union bounding box of every frame', () => {
    useCameraStore.getState().setFrames([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 900, y: 700, w: 100, h: 100 }, // union: (0,0)-(1000,800)
    ]);
    useCameraStore.getState().zoomToFit(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1, 10);
    const screenTopLeft = pagePointToScreenSpace(useCameraStore.getState().camera, { x: 0, y: 0 });
    const screenBottomRight = pagePointToScreenSpace(useCameraStore.getState().camera, { x: 1000, y: 800 });
    expect(screenTopLeft.x).toBeCloseTo(0, 6);
    expect(screenBottomRight.x).toBeCloseTo(1000, 6);
    expect(screenBottomRight.y).toBeCloseTo(800, 6);
  });

  it('has no targetZoom clamp (fits exactly, even to a very high zoom)', () => {
    useCameraStore.getState().setFrames([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }]);
    useCameraStore.getState().zoomToFit(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(80, 10); // min(1000/10, 800/10)
  });
});

describe('zoomToSelection', () => {
  beforeEach(() => {
    useCameraStore.getState().setFrames([
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 900, y: 700, w: 100, h: 100 },
    ]);
  });

  it('is a no-op when selectedIds is empty', () => {
    useCameraStore.getState().setCamera({ x: 9, y: 9, z: 4 });
    useCameraStore.getState().select([]);
    useCameraStore.getState().zoomToSelection(VIEWPORT);
    expect(useCameraStore.getState().camera).toEqual({ x: 9, y: 9, z: 4 });
  });

  it('fits only the selected frame, ignoring unselected ones', () => {
    useCameraStore.getState().select(['a']);
    useCameraStore.getState().zoomToSelection(VIEWPORT);
    // Box 'a' is 100x100 -> fit zoom = min(1000/100, 800/100) = 8.
    expect(useCameraStore.getState().camera.z).toBeCloseTo(8, 10);
    const screenCenter = pagePointToScreenSpace(useCameraStore.getState().camera, { x: 50, y: 50 });
    expect(screenCenter.x).toBeCloseTo(VIEWPORT.w / 2, 6);
    expect(screenCenter.y).toBeCloseTo(VIEWPORT.h / 2, 6);
  });

  it('fits the union of multiple selected frames', () => {
    useCameraStore.getState().select(['a', 'b']);
    useCameraStore.getState().zoomToSelection(VIEWPORT);
    expect(useCameraStore.getState().camera.z).toBeCloseTo(1, 10);
  });

  it('is a no-op when selectedIds reference no known frame', () => {
    useCameraStore.getState().setCamera({ x: 1, y: 2, z: 3 });
    useCameraStore.getState().select(['does-not-exist']);
    useCameraStore.getState().zoomToSelection(VIEWPORT);
    expect(useCameraStore.getState().camera).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('select / clearSelection', () => {
  it('select replaces selectedIds', () => {
    useCameraStore.getState().select(['a', 'b']);
    expect(useCameraStore.getState().selectedIds).toEqual(new Set(['a', 'b']));
    useCameraStore.getState().select(['c']);
    expect(useCameraStore.getState().selectedIds).toEqual(new Set(['c']));
  });

  it('clearSelection empties selectedIds', () => {
    useCameraStore.getState().select(['a']);
    useCameraStore.getState().clearSelection();
    expect(useCameraStore.getState().selectedIds.size).toBe(0);
  });
});
