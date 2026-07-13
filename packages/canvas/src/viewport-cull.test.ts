import { describe, expect, it } from 'vitest';
import { computeFrameRenderMode, computeRenderModes } from './viewport-cull.js';
import type { Box, CameraState } from './geometry.js';

const IDENTITY_CAMERA: CameraState = { x: 0, y: 0, z: 1 };
const VIEWPORT = { w: 1000, h: 800 };

describe('computeFrameRenderMode', () => {
  it('renders live when the frame is inside the viewport at normal zoom', () => {
    const frame: Box = { x: 100, y: 100, w: 200, h: 200 };
    expect(computeFrameRenderMode(IDENTITY_CAMERA, VIEWPORT, frame)).toBe('live');
  });

  it('renders a screenshot when the frame is outside the viewport', () => {
    const frame: Box = { x: 5000, y: 5000, w: 200, h: 200 };
    expect(computeFrameRenderMode(IDENTITY_CAMERA, VIEWPORT, frame)).toBe('screenshot');
  });

  it('forces screenshots for every frame below the zoom threshold, even if visible', () => {
    const frame: Box = { x: 0, y: 0, w: 100, h: 100 }; // well within viewport
    const zoomedOut: CameraState = { x: 0, y: 0, z: 0.2 };
    expect(computeFrameRenderMode(zoomedOut, VIEWPORT, frame)).toBe('screenshot');
  });

  it('renders live right at and above the zoom threshold (0.3 default)', () => {
    const frame: Box = { x: 0, y: 0, w: 100, h: 100 };
    expect(computeFrameRenderMode({ x: 0, y: 0, z: 0.3 }, VIEWPORT, frame)).toBe('live');
    expect(computeFrameRenderMode({ x: 0, y: 0, z: 0.29 }, VIEWPORT, frame)).toBe('screenshot');
  });

  it('respects a custom zoomScreenshotThreshold', () => {
    const frame: Box = { x: 0, y: 0, w: 100, h: 100 };
    const camera: CameraState = { x: 0, y: 0, z: 0.4 };
    expect(computeFrameRenderMode(camera, VIEWPORT, frame, { zoomScreenshotThreshold: 0.5 })).toBe('screenshot');
    expect(computeFrameRenderMode(camera, VIEWPORT, frame, { zoomScreenshotThreshold: 0.3 })).toBe('live');
  });

  it('a positive cullMarginPage keeps a just-offscreen frame live', () => {
    // Viewport page bounds are [0,1000]x[0,800]; this frame starts at
    // x=1050, just past the right edge.
    const frame: Box = { x: 1050, y: 0, w: 100, h: 100 };
    expect(computeFrameRenderMode(IDENTITY_CAMERA, VIEWPORT, frame)).toBe('screenshot');
    expect(computeFrameRenderMode(IDENTITY_CAMERA, VIEWPORT, frame, { cullMarginPage: 200 })).toBe('live');
  });

  it('accounts for pan when deciding visibility', () => {
    const pannedCamera: CameraState = { x: -2000, y: 0, z: 1 };
    // viewport page bounds shift to [2000, 3000] x [0, 800]
    const frame: Box = { x: 2100, y: 100, w: 200, h: 200 };
    expect(computeFrameRenderMode(pannedCamera, VIEWPORT, frame)).toBe('live');
    // Without the pan, the same frame is well outside the [0,1000] viewport.
    expect(computeFrameRenderMode(IDENTITY_CAMERA, VIEWPORT, frame)).toBe('screenshot');
  });
});

describe('computeRenderModes (batch, 20-frame perf scenario)', () => {
  it('decides all frames in one pass, matching the per-frame function', () => {
    const frames = new Map<string, Box>();
    for (let i = 0; i < 20; i++) {
      frames.set(`frame-${i}`, { x: i * 1600, y: 0, w: 1440, h: 900 });
    }
    const camera: CameraState = { x: -3200, y: 0, z: 1 }; // viewport centered near frame index 2
    const batch = computeRenderModes(camera, VIEWPORT, frames);
    for (const [id, box] of frames) {
      expect(batch.get(id)).toBe(computeFrameRenderMode(camera, VIEWPORT, box));
    }
  });

  it('every frame is a screenshot below the zoom threshold', () => {
    const frames = new Map<string, Box>([['a', { x: 0, y: 0, w: 100, h: 100 }]]);
    const batch = computeRenderModes({ x: 0, y: 0, z: 0.1 }, VIEWPORT, frames);
    expect(batch.get('a')).toBe('screenshot');
  });
});
