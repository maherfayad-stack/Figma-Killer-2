import { describe, expect, it } from 'vitest';
import type { Rect as BridgeRect } from '@ccs/bridge';
import { FRAME_CHROME_HEADER_HEIGHT, type Box, type CameraState } from './geometry.js';
import {
  boxToBridgeRect,
  bridgeRectToBox,
  iframeRectToPageBox,
  iframeRectToScreenBox,
  screenPointToIframePoint,
} from './bridge-geometry.js';

describe('bridgeRectToBox / boxToBridgeRect', () => {
  it('round-trips the {x,y,width,height} <-> {x,y,w,h} shapes', () => {
    const rect: BridgeRect = { x: 10, y: 20, width: 30, height: 40 };
    const box: Box = { x: 10, y: 20, w: 30, h: 40 };
    expect(bridgeRectToBox(rect)).toEqual(box);
    expect(boxToBridgeRect(box)).toEqual(rect);
  });
});

describe('iframeRectToPageBox', () => {
  const frameBox: Box = { x: 100, y: 200, w: 1440, h: 900 };

  it('adds the frame origin and the chrome header offset', () => {
    const rect: BridgeRect = { x: 10, y: 5, width: 50, height: 20 };
    expect(iframeRectToPageBox(rect, frameBox)).toEqual({
      x: 110,
      y: 200 + FRAME_CHROME_HEADER_HEIGHT + 5,
      w: 50,
      h: 20,
    });
  });

  it('a rect at iframe origin (0,0) lands just below the header, at the frame left edge', () => {
    const rect: BridgeRect = { x: 0, y: 0, width: 100, height: 100 };
    expect(iframeRectToPageBox(rect, frameBox)).toEqual({
      x: frameBox.x,
      y: frameBox.y + FRAME_CHROME_HEADER_HEIGHT,
      w: 100,
      h: 100,
    });
  });
});

describe('iframeRectToScreenBox — multiple zoom levels (playbook §4/P2 pitfall)', () => {
  const frameBox: Box = { x: 0, y: 0, w: 1440, h: 900 };
  const rect: BridgeRect = { x: 100, y: 50, width: 200, height: 80 };

  it('zoom = 1, no pan: screen box is the page box unchanged', () => {
    const camera: CameraState = { x: 0, y: 0, z: 1 };
    expect(iframeRectToScreenBox(camera, frameBox, rect)).toEqual({
      x: 100,
      y: FRAME_CHROME_HEADER_HEIGHT + 50,
      w: 200,
      h: 80,
    });
  });

  it('zoom = 2, no pan: position AND size both scale by 2', () => {
    const camera: CameraState = { x: 0, y: 0, z: 2 };
    expect(iframeRectToScreenBox(camera, frameBox, rect)).toEqual({
      x: 200,
      y: (FRAME_CHROME_HEADER_HEIGHT + 50) * 2,
      w: 400,
      h: 160,
    });
  });

  it('zoom = 0.5 with a pan offset: matches screen = (page + camera) * zoom for both corners', () => {
    const camera: CameraState = { x: -1000, y: -500, z: 0.5 };
    const page = iframeRectToPageBox(rect, frameBox);
    const expectedX = (page.x + camera.x) * camera.z;
    const expectedY = (page.y + camera.y) * camera.z;
    const box = iframeRectToScreenBox(camera, frameBox, rect);
    expect(box.x).toBeCloseTo(expectedX, 10);
    expect(box.y).toBeCloseTo(expectedY, 10);
    expect(box.w).toBeCloseTo(page.w * camera.z, 10);
    expect(box.h).toBeCloseTo(page.h * camera.z, 10);
  });

  it('a frame panned/offset in page space still produces the correct screen box at 2x zoom', () => {
    const offsetFrameBox: Box = { x: 300, y: 150, w: 1440, h: 900 };
    const camera: CameraState = { x: -300, y: -150, z: 2 };
    // camera exactly cancels the frame's page-space offset, so the frame's
    // own origin should land back at screen (0,0)-ish once the rect's local
    // (0,0) + header is accounted for.
    const originRect: BridgeRect = { x: 0, y: 0, width: 10, height: 10 };
    const box = iframeRectToScreenBox(camera, offsetFrameBox, originRect);
    expect(box.x).toBeCloseTo(0, 10);
    expect(box.y).toBeCloseTo(FRAME_CHROME_HEADER_HEIGHT * 2, 10);
    expect(box.w).toBeCloseTo(20, 10);
    expect(box.h).toBeCloseTo(20, 10);
  });
});

describe('screenPointToIframePoint — inverse of iframeRectToScreenBox at multiple zooms', () => {
  const frameBox: Box = { x: 50, y: 25, w: 1440, h: 900 };

  it.each([
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 2 },
    { x: -400, y: -200, z: 1.5 },
    { x: 250, y: 75, z: 0.5 },
  ] satisfies CameraState[])('round-trips an iframe point through screen space at camera %j', (camera) => {
    const iframePoint = { x: 123.5, y: 47.25 };
    const rect: BridgeRect = { x: iframePoint.x, y: iframePoint.y, width: 1, height: 1 };
    const screenBox = iframeRectToScreenBox(camera, frameBox, rect);
    const recovered = screenPointToIframePoint(camera, frameBox, { x: screenBox.x, y: screenBox.y });
    expect(recovered.x).toBeCloseTo(iframePoint.x, 8);
    expect(recovered.y).toBeCloseTo(iframePoint.y, 8);
  });

  it('a point at the top-left of the iframe content area maps to iframe-space (0,0)', () => {
    const camera: CameraState = { x: 0, y: 0, z: 1 };
    const screenPoint = { x: frameBox.x, y: frameBox.y + FRAME_CHROME_HEADER_HEIGHT };
    expect(screenPointToIframePoint(camera, frameBox, screenPoint)).toEqual({ x: 0, y: 0 });
  });
});
