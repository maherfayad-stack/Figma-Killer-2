import { describe, expect, it } from 'vitest';
import {
  boxToFrameEntry,
  boxesEqual,
  boxesIntersect,
  frameEntryToBox,
  framePointToIframeSpace,
  framePointToPageSpace,
  iframePointToFrameSpace,
  pagePointToFrameSpace,
  pagePointToScreenSpace,
  screenPointToPageSpace,
  screenViewportToPageBounds,
  type Box,
} from './geometry.js';

describe('iframe space <-> frame space (identity in P1)', () => {
  it('round-trips any point unchanged', () => {
    const p = { x: 123.5, y: 47 };
    expect(iframePointToFrameSpace(p)).toEqual(p);
    expect(framePointToIframeSpace(p)).toEqual(p);
  });
});

describe('frame space <-> page space', () => {
  const frameBox: Box = { x: 100, y: 200, w: 400, h: 300 };

  it('maps a frame-local point to page space by adding the frame origin', () => {
    expect(framePointToPageSpace(frameBox, { x: 10, y: 20 })).toEqual({ x: 110, y: 220 });
  });

  it('maps a page-space point back to frame-local space', () => {
    expect(pagePointToFrameSpace(frameBox, { x: 110, y: 220 })).toEqual({ x: 10, y: 20 });
  });

  it('round-trips frame -> page -> frame', () => {
    const local = { x: 37, y: 91 };
    const page = framePointToPageSpace(frameBox, local);
    expect(pagePointToFrameSpace(frameBox, page)).toEqual(local);
  });
});

describe('page space <-> screen space (camera transform)', () => {
  it('applies pan + zoom: screen = (page + camera) * zoom', () => {
    const camera = { x: -50, y: -50, z: 2 };
    expect(pagePointToScreenSpace(camera, { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it('round-trips page -> screen -> page for an arbitrary camera', () => {
    const camera = { x: 17, y: -33, z: 1.5 };
    const page = { x: 200, y: -40 };
    const screen = pagePointToScreenSpace(camera, page);
    const back = screenPointToPageSpace(camera, screen);
    expect(back.x).toBeCloseTo(page.x, 10);
    expect(back.y).toBeCloseTo(page.y, 10);
  });

  it('identity camera (no pan, zoom 1) leaves points unchanged', () => {
    const camera = { x: 0, y: 0, z: 1 };
    expect(pagePointToScreenSpace(camera, { x: 42, y: 7 })).toEqual({ x: 42, y: 7 });
  });
});

describe('screenViewportToPageBounds', () => {
  it('computes the visible page-space rect for an identity camera', () => {
    const camera = { x: 0, y: 0, z: 1 };
    expect(screenViewportToPageBounds(camera, { w: 800, h: 600 })).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('accounts for pan and zoom', () => {
    const camera = { x: -1000, y: -500, z: 2 };
    // topLeft = (0/2 - (-1000), 0/2 - (-500)) = (1000, 500)
    // bottomRight = (800/2 + 1000, 600/2 + 500) = (1400, 800)
    expect(screenViewportToPageBounds(camera, { w: 800, h: 600 })).toEqual({
      x: 1000,
      y: 500,
      w: 400,
      h: 300,
    });
  });
});

describe('boxesIntersect', () => {
  it('detects overlap', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
  });

  it('detects no overlap (fully separated)', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 50, h: 50 })).toBe(false);
  });

  it('treats edge-touching boxes as non-intersecting (open interval semantics)', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it('one box fully inside another intersects', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 1000, h: 1000 }, { x: 100, y: 100, w: 10, h: 10 })).toBe(true);
  });
});

describe('FrameEntry <-> Box', () => {
  it('frameEntryToBox drops framePath', () => {
    expect(frameEntryToBox({ framePath: 'src/frames/Hero.tsx', x: 1, y: 2, w: 3, h: 4 })).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    });
  });

  it('boxToFrameEntry re-attaches framePath', () => {
    expect(boxToFrameEntry('src/frames/Hero.tsx', { x: 1, y: 2, w: 3, h: 4 })).toEqual({
      framePath: 'src/frames/Hero.tsx',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    });
  });

  it('round-trips box -> entry -> box', () => {
    const box: Box = { x: 10, y: 20, w: 30, h: 40 };
    expect(frameEntryToBox(boxToFrameEntry('src/frames/Hero.tsx', box))).toEqual(box);
  });
});

describe('boxesEqual', () => {
  it('true for structurally identical boxes', () => {
    expect(boxesEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
  });

  it('false when any field differs', () => {
    expect(boxesEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
  });
});
