import { describe, expect, it } from 'vitest';
import type { FrameMeta, ProjectInfo } from '@ccs/protocol';
import {
  defaultGeometryForIndex,
  frameRecordId,
  removeFrameRecord,
  resyncFileFolderGeometry,
  upsertFrameRecord,
  wireProjectInfo,
} from './project-wiring.js';

const DEMO_PROJECT_INFO: ProjectInfo = {
  frames: [
    { framePath: 'files/demo/src/frames/Hero.tsx', name: 'Hero', devServerUrl: 'http://127.0.0.1:5200/?frame=Hero' },
    {
      framePath: 'files/demo/src/frames/Pricing.tsx',
      name: 'Pricing',
      devServerUrl: 'http://127.0.0.1:5200/?frame=Pricing',
    },
  ],
  daemonPort: 4700,
};

const DEMO_CANVAS_JSON: FrameMeta = {
  frames: [
    { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
    { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
  ],
  comments: [],
  zoomBookmarks: [],
};

describe('wireProjectInfo — ProjectInfo -> FrameShape wiring', () => {
  it('produces one record per frame, positioned from the matching canvas.json entry', () => {
    const records = wireProjectInfo(DEMO_PROJECT_INFO, new Map([['demo', DEMO_CANVAS_JSON]]));
    expect(records).toEqual([
      {
        id: 'demo::src/frames/Hero.tsx',
        fileFolder: 'demo',
        framePath: 'src/frames/Hero.tsx',
        name: 'Hero',
        devServerUrl: 'http://127.0.0.1:5200/?frame=Hero',
        x: 0,
        y: 0,
        w: 1440,
        h: 900,
      },
      {
        id: 'demo::src/frames/Pricing.tsx',
        fileFolder: 'demo',
        framePath: 'src/frames/Pricing.tsx',
        name: 'Pricing',
        devServerUrl: 'http://127.0.0.1:5200/?frame=Pricing',
        x: 1600,
        y: 0,
        w: 1440,
        h: 900,
      },
    ]);
  });

  it('falls back to a cascading default geometry when canvas.json has no matching entry', () => {
    const emptyMeta: FrameMeta = { frames: [], comments: [], zoomBookmarks: [] };
    const records = wireProjectInfo(DEMO_PROJECT_INFO, new Map([['demo', emptyMeta]]));
    expect(records[0]).toMatchObject(defaultGeometryForIndex(0));
    expect(records[1]).toMatchObject(defaultGeometryForIndex(1));
  });

  it('falls back to defaults when the file-folder has no canvas.json entry at all (fetch failed)', () => {
    const records = wireProjectInfo(DEMO_PROJECT_INFO, new Map());
    expect(records[0]).toMatchObject(defaultGeometryForIndex(0));
    expect(records[1]).toMatchObject(defaultGeometryForIndex(1));
  });

  it('skips frames whose framePath does not resolve to files/<folder>/...', () => {
    const info: ProjectInfo = {
      frames: [{ framePath: 'not-under-files/Hero.tsx', name: 'Hero', devServerUrl: 'http://x/?frame=Hero' }],
      daemonPort: 4700,
    };
    expect(wireProjectInfo(info, new Map())).toEqual([]);
  });

  it('derives fileFolder from multiple distinct file-folders independently', () => {
    const info: ProjectInfo = {
      frames: [
        { framePath: 'files/demo/src/frames/Hero.tsx', name: 'Hero', devServerUrl: 'http://a/?frame=Hero' },
        { framePath: 'files/other/src/frames/Landing.tsx', name: 'Landing', devServerUrl: 'http://b/?frame=Landing' },
      ],
      daemonPort: 4700,
    };
    const records = wireProjectInfo(info, new Map([['demo', DEMO_CANVAS_JSON]]));
    expect(records.map((r) => r.fileFolder)).toEqual(['demo', 'other']);
    expect(records[1]).toMatchObject(defaultGeometryForIndex(0)); // "other" had no canvas.json entry
  });
});

describe('frameRecordId', () => {
  it('is stable and namespaced by fileFolder', () => {
    expect(frameRecordId('demo', 'src/frames/Hero.tsx')).toBe('demo::src/frames/Hero.tsx');
  });
});

describe('upsertFrameRecord / removeFrameRecord', () => {
  const base = wireProjectInfo(DEMO_PROJECT_INFO, new Map([['demo', DEMO_CANVAS_JSON]]));

  it('upsert replaces an existing record by id', () => {
    const heroRecord = base[0];
    if (!heroRecord) throw new Error('expected a Hero record in the fixture');
    const updated = { ...heroRecord, x: 999 };
    const result = upsertFrameRecord(base, updated);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === heroRecord.id)?.x).toBe(999);
  });

  it('upsert appends when the id is new', () => {
    const newRecord = { ...base[0]!, id: 'demo::src/frames/New.tsx', framePath: 'src/frames/New.tsx', name: 'New' };
    const result = upsertFrameRecord(base, newRecord);
    expect(result).toHaveLength(3);
  });

  it('remove drops exactly the matching id', () => {
    const heroRecord = base[0];
    if (!heroRecord) throw new Error('expected a Hero record in the fixture');
    const result = removeFrameRecord(base, heroRecord.id);
    expect(result).toHaveLength(1);
    expect(result.find((r) => r.id === heroRecord.id)).toBeUndefined();
  });
});

describe('resyncFileFolderGeometry — external canvas.json change re-sync', () => {
  it('applies fresh geometry to matching records in the target file-folder only', () => {
    const base = wireProjectInfo(DEMO_PROJECT_INFO, new Map([['demo', DEMO_CANVAS_JSON]]));
    const updatedMeta: FrameMeta = {
      frames: [
        { framePath: 'src/frames/Hero.tsx', x: 321, y: 654, w: 1000, h: 700 },
        { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
      ],
      comments: [],
      zoomBookmarks: [],
    };
    const result = resyncFileFolderGeometry(base, 'demo', updatedMeta);
    expect(result.find((r) => r.framePath === 'src/frames/Hero.tsx')).toMatchObject({
      x: 321,
      y: 654,
      w: 1000,
      h: 700,
    });
    expect(result.find((r) => r.framePath === 'src/frames/Pricing.tsx')).toMatchObject({ x: 1600, y: 0 });
  });

  it('leaves records in other file-folders untouched', () => {
    const info: ProjectInfo = {
      frames: [
        { framePath: 'files/demo/src/frames/Hero.tsx', name: 'Hero', devServerUrl: 'http://a/?frame=Hero' },
        { framePath: 'files/other/src/frames/Landing.tsx', name: 'Landing', devServerUrl: 'http://b/?frame=Landing' },
      ],
      daemonPort: 4700,
    };
    const base = wireProjectInfo(info, new Map([['demo', DEMO_CANVAS_JSON]]));
    const otherBefore = base.find((r) => r.fileFolder === 'other');
    const result = resyncFileFolderGeometry(base, 'demo', DEMO_CANVAS_JSON);
    expect(result.find((r) => r.fileFolder === 'other')).toEqual(otherBefore);
  });

  it('leaves a record untouched if the resync payload has no matching framePath', () => {
    const base = wireProjectInfo(DEMO_PROJECT_INFO, new Map([['demo', DEMO_CANVAS_JSON]]));
    const heroBefore = base.find((r) => r.framePath === 'src/frames/Hero.tsx');
    const sparseMeta: FrameMeta = {
      frames: [{ framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 }],
      comments: [],
      zoomBookmarks: [],
    };
    const result = resyncFileFolderGeometry(base, 'demo', sparseMeta);
    expect(result.find((r) => r.framePath === 'src/frames/Hero.tsx')).toEqual(heroBefore);
  });
});
