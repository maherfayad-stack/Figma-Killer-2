import { describe, expect, it } from 'vitest';
import { computeFrameRenderMode, computeRenderModes, selectLiveFrames, DEFAULT_MAX_LIVE_FRAMES } from './viewport-cull.js';
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

describe('selectLiveFrames (FIX 6 bounded live set)', () => {
  // Page-space viewport of [0,1000]x[0,800] (matches VIEWPORT at z=1, pan 0).
  const VP: Box = { x: 0, y: 0, w: 1000, h: 800 };

  it('keeps every frame live when there are fewer than the cap and all are on-screen', () => {
    const frames = new Map<string, Box>([
      ['a', { x: 0, y: 0, w: 200, h: 200 }],
      ['b', { x: 300, y: 0, w: 200, h: 200 }],
      ['c', { x: 600, y: 0, w: 200, h: 200 }],
    ]);
    const live = selectLiveFrames(VP, frames, { maxLive: 8 });
    expect(live).toEqual(new Set(['a', 'b', 'c']));
  });

  it('hard-caps the live set at maxLive, keeping the frames nearest the viewport centre', () => {
    // 20 frames laid left-to-right; viewport centre is at page (500,400).
    const frames = new Map<string, Box>();
    for (let i = 0; i < 20; i++) frames.set(`f${i}`, { x: i * 60, y: 350, w: 50, h: 50 });
    const live = selectLiveFrames(VP, frames, { maxLive: 4, cullMarginPage: 100_000 });
    expect(live.size).toBe(4);
    // Frame centres nearest (500,400): x-centre = i*60+25. Closest to 500 are
    // i=8 (505), i=7 (445), i=9 (565), i=6 (385) — the 4 nearest.
    expect(live).toEqual(new Set(['f8', 'f7', 'f9', 'f6']));
  });

  it('excludes frames outside the (margin-expanded) viewport', () => {
    const frames = new Map<string, Box>([
      ['near', { x: 100, y: 100, w: 100, h: 100 }],
      ['far', { x: 50_000, y: 50_000, w: 100, h: 100 }],
    ]);
    const live = selectLiveFrames(VP, frames, { maxLive: 8 });
    expect(live).toEqual(new Set(['near']));
  });

  it('a positive cullMarginPage keeps a just-offscreen frame live', () => {
    const frames = new Map<string, Box>([['edge', { x: 1050, y: 0, w: 100, h: 100 }]]);
    expect(selectLiveFrames(VP, frames, { maxLive: 8 })).toEqual(new Set());
    expect(selectLiveFrames(VP, frames, { maxLive: 8, cullMarginPage: 200 })).toEqual(new Set(['edge']));
  });

  it('always includes the alwaysLive (edit-mode) frame even if off-screen, and it counts toward the cap', () => {
    const frames = new Map<string, Box>();
    for (let i = 0; i < 5; i++) frames.set(`f${i}`, { x: i * 60, y: 350, w: 50, h: 50 });
    frames.set('editing', { x: 90_000, y: 90_000, w: 50, h: 50 }); // far off-screen
    const live = selectLiveFrames(VP, frames, { maxLive: 3, alwaysLive: 'editing', cullMarginPage: 100_000 });
    expect(live.has('editing')).toBe(true);
    expect(live.size).toBe(3); // editing + the 2 nearest on-screen frames
  });

  it('defaults maxLive to DEFAULT_MAX_LIVE_FRAMES', () => {
    const frames = new Map<string, Box>();
    for (let i = 0; i < 20; i++) frames.set(`f${i}`, { x: i * 40, y: 380, w: 30, h: 30 });
    const live = selectLiveFrames(VP, frames, { cullMarginPage: 100_000 });
    expect(live.size).toBe(DEFAULT_MAX_LIVE_FRAMES);
  });
});
