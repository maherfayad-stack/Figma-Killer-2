import { describe, expect, it } from 'vitest';
import { FrameMetaSchema } from './frame-meta.js';

describe('FrameMeta (.studio/canvas.json)', () => {
  it('round-trips a sample FrameMeta with two frames', () => {
    const sample = {
      frames: [
        { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 800 },
        { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 1200 },
      ],
      comments: [],
      zoomBookmarks: [],
    };
    const parsed = FrameMetaSchema.parse(sample);
    expect(parsed).toEqual(sample);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(sample);
  });

  it('round-trips a FrameMeta with a populated comment and zoom bookmark', () => {
    const sample = {
      frames: [{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 800 }],
      comments: [
        {
          id: 'c1',
          frameName: 'Hero',
          nodeUid: 'src/frames/Hero.tsx:JSXElement[3]',
          x: 120,
          y: 40,
          text: 'Should this button be aqua per DS tokens?',
          resolved: false,
          createdAt: '2026-07-13T12:00:00.000Z',
        },
      ],
      zoomBookmarks: [{ id: 'z1', name: 'Overview', x: 0, y: 0, zoom: 0.5 }],
    };
    expect(FrameMetaSchema.parse(sample)).toEqual(sample);
  });

  it('rejects a frame with a non-positive width/height', () => {
    expect(() =>
      FrameMetaSchema.parse({
        frames: [{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 0, h: 800 }],
        comments: [],
        zoomBookmarks: [],
      }),
    ).toThrow();
  });

  it('rejects an empty framePath', () => {
    expect(() =>
      FrameMetaSchema.parse({
        frames: [{ framePath: '', x: 0, y: 0, w: 100, h: 100 }],
        comments: [],
        zoomBookmarks: [],
      }),
    ).toThrow();
  });

  it('rejects a comment with a malformed nodeUid anchor', () => {
    expect(() =>
      FrameMetaSchema.parse({
        frames: [],
        comments: [
          {
            id: 'c1',
            frameName: 'Hero',
            nodeUid: 'not-a-uid',
            x: 0,
            y: 0,
            text: 'x',
            resolved: false,
            createdAt: '2026-07-13T12:00:00.000Z',
          },
        ],
        zoomBookmarks: [],
      }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (strict — no second scene model per playbook §5 Global Risk #1)', () => {
    expect(() =>
      FrameMetaSchema.parse({
        frames: [],
        comments: [],
        zoomBookmarks: [],
        sceneGraph: { nodes: [] },
      }),
    ).toThrow();
  });
});
