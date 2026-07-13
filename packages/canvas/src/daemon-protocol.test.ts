import { describe, expect, it } from 'vitest';
import {
  buildCreateFrameMessage,
  buildGetCanvasJsonMessage,
  buildSetGeometryMessage,
  classifyDaemonMessage,
  deriveFileFolderPath,
  frameNameFromPath,
  isCanvasJsonPath,
  isFrameSourcePath,
} from './daemon-protocol.js';

describe('classifyDaemonMessage', () => {
  it('classifies a bare ProjectInfo bootstrap message (no `t` field)', () => {
    const raw = {
      frames: [
        { framePath: 'files/demo/src/frames/Hero.tsx', name: 'Hero', devServerUrl: 'http://127.0.0.1:5200/?frame=Hero' },
      ],
      daemonPort: 4700,
    };
    const result = classifyDaemonMessage(raw);
    expect(result.kind).toBe('project-info');
    if (result.kind === 'project-info') {
      expect(result.info.daemonPort).toBe(4700);
      expect(result.info.frames).toHaveLength(1);
    }
  });

  it('classifies a bare DaemonEvent (has `t`)', () => {
    const raw = { t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' };
    const result = classifyDaemonMessage(raw);
    expect(result).toEqual({ kind: 'daemon-event', event: raw });
  });

  it('classifies every DaemonEvent variant relevant to P1', () => {
    const events = [
      { t: 'file-changed', file: 'x' },
      { t: 'hmr-update', file: 'x' },
      { t: 'op-rejected', opId: '1', reason: 'ast-engine P3' },
    ];
    for (const event of events) {
      expect(classifyDaemonMessage(event)).toEqual({ kind: 'daemon-event', event });
    }
  });

  it('rejects a `t`-tagged message that fails DaemonEvent validation', () => {
    const result = classifyDaemonMessage({ t: 'not-a-real-event' });
    expect(result.kind).toBe('invalid');
  });

  it('rejects a non-`t` message that fails ProjectInfo validation', () => {
    const result = classifyDaemonMessage({ frames: 'not-an-array' });
    expect(result.kind).toBe('invalid');
  });

  it('rejects non-object input', () => {
    expect(classifyDaemonMessage('a string').kind).toBe('invalid');
    expect(classifyDaemonMessage(null).kind).toBe('invalid');
    expect(classifyDaemonMessage(42).kind).toBe('invalid');
  });

  it('classifies an ADR-0014 get-canvas-json-result reply (has `kind`, no `t`)', () => {
    const raw = {
      kind: 'get-canvas-json-result',
      requestId: 'r1',
      fileFolder: 'demo',
      meta: { frames: [], comments: [], zoomBookmarks: [] },
    };
    const result = classifyDaemonMessage(raw);
    expect(result).toEqual({ kind: 'control-reply', reply: raw });
  });

  it('classifies an ADR-0014 control-error reply', () => {
    const raw = { kind: 'control-error', requestId: 'r1', reason: 'invalid frame name' };
    const result = classifyDaemonMessage(raw);
    expect(result).toEqual({ kind: 'control-reply', reply: raw });
  });

  it('rejects a `kind`-tagged message that fails ControlReply validation', () => {
    const result = classifyDaemonMessage({ kind: 'not-a-real-reply' });
    expect(result.kind).toBe('invalid');
  });

  it('never confuses a `kind`-tagged control reply for a `t`-tagged DaemonEvent or the bare ProjectInfo', () => {
    expect(classifyDaemonMessage({ kind: 'control-error', requestId: 'r1', reason: 'x' }).kind).toBe('control-reply');
    expect(classifyDaemonMessage({ t: 'file-changed', file: 'x' }).kind).toBe('daemon-event');
    expect(classifyDaemonMessage({ frames: [], daemonPort: 4700 }).kind).toBe('project-info');
  });
});

describe('buildSetGeometryMessage', () => {
  it('matches the ADR-0013 client→server envelope exactly', () => {
    expect(buildSetGeometryMessage('demo', 'src/frames/Hero.tsx', { x: 1, y: 2, w: 3, h: 4 })).toEqual({
      kind: 'set-geometry',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    });
  });
});

describe('buildCreateFrameMessage', () => {
  it('matches the ADR-0014 client→server envelope exactly', () => {
    expect(buildCreateFrameMessage('req-1', 'demo', 'Testimonials')).toEqual({
      kind: 'create-frame',
      requestId: 'req-1',
      fileFolder: 'demo',
      name: 'Testimonials',
    });
  });
});

describe('buildGetCanvasJsonMessage', () => {
  it('matches the ADR-0014 client→server envelope exactly', () => {
    expect(buildGetCanvasJsonMessage('req-2', 'demo')).toEqual({
      kind: 'get-canvas-json',
      requestId: 'req-2',
      fileFolder: 'demo',
    });
  });
});

describe('deriveFileFolderPath', () => {
  it('derives fileFolder + relPath from the exact task-brief example', () => {
    expect(deriveFileFolderPath('files/demo/src/frames/Hero.tsx')).toEqual({
      fileFolder: 'demo',
      relPath: 'src/frames/Hero.tsx',
    });
  });

  it('handles nested file-folder-relative paths beyond src/frames', () => {
    expect(deriveFileFolderPath('files/demo/.studio/canvas.json')).toEqual({
      fileFolder: 'demo',
      relPath: '.studio/canvas.json',
    });
  });

  it('returns null for paths not rooted at files/<folder>/...', () => {
    expect(deriveFileFolderPath('design-system/tokens/tokens.json')).toBeNull();
    expect(deriveFileFolderPath('files/demo')).toBeNull();
    expect(deriveFileFolderPath('files')).toBeNull();
    expect(deriveFileFolderPath('')).toBeNull();
  });
});

describe('isFrameSourcePath / frameNameFromPath', () => {
  it('matches src/frames/*.tsx and extracts the name', () => {
    expect(isFrameSourcePath('src/frames/Hero.tsx')).toBe(true);
    expect(frameNameFromPath('src/frames/Hero.tsx')).toBe('Hero');
  });

  it('rejects nested or non-frame paths', () => {
    expect(isFrameSourcePath('src/frames/nested/Hero.tsx')).toBe(false);
    expect(isFrameSourcePath('src/App.tsx')).toBe(false);
    expect(isFrameSourcePath('.studio/canvas.json')).toBe(false);
    expect(frameNameFromPath('src/App.tsx')).toBeNull();
  });
});

describe('isCanvasJsonPath', () => {
  it('matches exactly .studio/canvas.json', () => {
    expect(isCanvasJsonPath('.studio/canvas.json')).toBe(true);
    expect(isCanvasJsonPath('src/frames/Hero.tsx')).toBe(false);
  });
});
