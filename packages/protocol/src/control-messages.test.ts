import { describe, expect, it } from 'vitest';
import {
  ControlErrorSchema,
  ControlReplySchema,
  ControlRequestSchema,
  CreateFrameRequestSchema,
  DuplicateFrameRequestSchema,
  DuplicateFrameResultSchema,
  GetCanvasJsonRequestSchema,
  GetCanvasJsonResultSchema,
  RedoRequestSchema,
  RedoResultSchema,
  UndoRequestSchema,
  UndoResultSchema,
} from './control-messages.js';

describe('CreateFrameRequestSchema', () => {
  it('accepts a well-formed create-frame request', () => {
    const req = { kind: 'create-frame', requestId: 'r1', fileFolder: 'demo', name: 'Testimonials' };
    expect(CreateFrameRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects a missing name', () => {
    expect(
      CreateFrameRequestSchema.safeParse({ kind: 'create-frame', requestId: 'r1', fileFolder: 'demo' }).success,
    ).toBe(false);
  });

  it('rejects extra/unknown fields (strict)', () => {
    expect(
      CreateFrameRequestSchema.safeParse({
        kind: 'create-frame',
        requestId: 'r1',
        fileFolder: 'demo',
        name: 'Testimonials',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('GetCanvasJsonRequestSchema', () => {
  it('accepts a well-formed get-canvas-json request', () => {
    const req = { kind: 'get-canvas-json', requestId: 'r2', fileFolder: 'demo' };
    expect(GetCanvasJsonRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects a missing fileFolder', () => {
    expect(GetCanvasJsonRequestSchema.safeParse({ kind: 'get-canvas-json', requestId: 'r2' }).success).toBe(false);
  });
});

describe('DuplicateFrameRequestSchema', () => {
  it('accepts a well-formed duplicate-frame request without newName', () => {
    const req = { kind: 'duplicate-frame', requestId: 'r3', fileFolder: 'demo', sourceName: 'Hero' };
    expect(DuplicateFrameRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts an optional newName hint', () => {
    const req = { kind: 'duplicate-frame', requestId: 'r3', fileFolder: 'demo', sourceName: 'Hero', newName: 'HeroAlt' };
    expect(DuplicateFrameRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects a missing sourceName', () => {
    expect(
      DuplicateFrameRequestSchema.safeParse({ kind: 'duplicate-frame', requestId: 'r3', fileFolder: 'demo' }).success,
    ).toBe(false);
  });

  it('rejects extra/unknown fields (strict)', () => {
    expect(
      DuplicateFrameRequestSchema.safeParse({
        kind: 'duplicate-frame',
        requestId: 'r3',
        fileFolder: 'demo',
        sourceName: 'Hero',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('UndoRequestSchema / RedoRequestSchema', () => {
  it('accepts well-formed undo/redo requests', () => {
    const undoReq = { kind: 'undo', requestId: 'r4', fileFolder: 'demo' };
    const redoReq = { kind: 'redo', requestId: 'r5', fileFolder: 'demo' };
    expect(UndoRequestSchema.parse(undoReq)).toEqual(undoReq);
    expect(RedoRequestSchema.parse(redoReq)).toEqual(redoReq);
  });

  it('rejects a missing fileFolder', () => {
    expect(UndoRequestSchema.safeParse({ kind: 'undo', requestId: 'r4' }).success).toBe(false);
    expect(RedoRequestSchema.safeParse({ kind: 'redo', requestId: 'r5' }).success).toBe(false);
  });

  it('rejects extra/unknown fields (strict)', () => {
    expect(
      UndoRequestSchema.safeParse({ kind: 'undo', requestId: 'r4', fileFolder: 'demo', extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('UndoResultSchema / RedoResultSchema', () => {
  it('accepts an applied result with a file', () => {
    const reply = { kind: 'undo-result', requestId: 'r4', fileFolder: 'demo', applied: true, file: 'files/demo/src/frames/Hero.tsx' };
    expect(UndoResultSchema.parse(reply)).toEqual(reply);
  });

  it('accepts a not-applied result (empty stack) with a null file and no reason', () => {
    const reply = { kind: 'redo-result', requestId: 'r5', fileFolder: 'demo', applied: false, file: null };
    expect(RedoResultSchema.parse(reply)).toEqual(reply);
  });

  it('accepts a not-applied result carrying a failure reason', () => {
    const reply = {
      kind: 'undo-result',
      requestId: 'r4',
      fileFolder: 'demo',
      applied: false,
      file: null,
      reason: 'file changed, retry',
    };
    expect(UndoResultSchema.parse(reply)).toEqual(reply);
  });
});

describe('ControlRequestSchema', () => {
  it('discriminates between create-frame, get-canvas-json, duplicate-frame, undo, and redo', () => {
    const a = ControlRequestSchema.parse({ kind: 'create-frame', requestId: 'r1', fileFolder: 'demo', name: 'X' });
    const b = ControlRequestSchema.parse({ kind: 'get-canvas-json', requestId: 'r2', fileFolder: 'demo' });
    const c = ControlRequestSchema.parse({ kind: 'duplicate-frame', requestId: 'r3', fileFolder: 'demo', sourceName: 'Hero' });
    const d = ControlRequestSchema.parse({ kind: 'undo', requestId: 'r4', fileFolder: 'demo' });
    const e = ControlRequestSchema.parse({ kind: 'redo', requestId: 'r5', fileFolder: 'demo' });
    expect(a.kind).toBe('create-frame');
    expect(b.kind).toBe('get-canvas-json');
    expect(c.kind).toBe('duplicate-frame');
    expect(d.kind).toBe('undo');
    expect(e.kind).toBe('redo');
  });

  it('rejects an unknown kind', () => {
    expect(ControlRequestSchema.safeParse({ kind: 'not-a-real-kind', requestId: 'r1' }).success).toBe(false);
  });
});

describe('GetCanvasJsonResultSchema', () => {
  const validMeta = { frames: [{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }], comments: [], zoomBookmarks: [] };

  it('accepts a result carrying a valid FrameMeta', () => {
    const reply = { kind: 'get-canvas-json-result', requestId: 'r2', fileFolder: 'demo', meta: validMeta };
    expect(GetCanvasJsonResultSchema.parse(reply)).toEqual(reply);
  });

  it('rejects a result whose meta fails FrameMeta validation', () => {
    expect(
      GetCanvasJsonResultSchema.safeParse({
        kind: 'get-canvas-json-result',
        requestId: 'r2',
        fileFolder: 'demo',
        meta: { frames: 'not-an-array' },
      }).success,
    ).toBe(false);
  });
});

describe('DuplicateFrameResultSchema', () => {
  it('accepts a well-formed result', () => {
    const reply = {
      kind: 'duplicate-frame-result',
      requestId: 'r3',
      fileFolder: 'demo',
      sourceName: 'Hero',
      newName: 'HeroCopy',
      framePath: 'src/frames/HeroCopy.tsx',
    };
    expect(DuplicateFrameResultSchema.parse(reply)).toEqual(reply);
  });

  it('rejects a result missing newName', () => {
    expect(
      DuplicateFrameResultSchema.safeParse({
        kind: 'duplicate-frame-result',
        requestId: 'r3',
        fileFolder: 'demo',
        sourceName: 'Hero',
        framePath: 'src/frames/HeroCopy.tsx',
      }).success,
    ).toBe(false);
  });
});

describe('ControlErrorSchema', () => {
  it('accepts a well-formed error', () => {
    const err = { kind: 'control-error', requestId: 'r1', reason: 'invalid frame name' };
    expect(ControlErrorSchema.parse(err)).toEqual(err);
  });
});

describe('ControlReplySchema', () => {
  it('discriminates between get-canvas-json-result, duplicate-frame-result, and control-error', () => {
    const okReply = ControlReplySchema.parse({
      kind: 'get-canvas-json-result',
      requestId: 'r2',
      fileFolder: 'demo',
      meta: { frames: [], comments: [], zoomBookmarks: [] },
    });
    const dupReply = ControlReplySchema.parse({
      kind: 'duplicate-frame-result',
      requestId: 'r3',
      fileFolder: 'demo',
      sourceName: 'Hero',
      newName: 'HeroCopy',
      framePath: 'src/frames/HeroCopy.tsx',
    });
    const errReply = ControlReplySchema.parse({ kind: 'control-error', requestId: 'r1', reason: 'boom' });
    const undoReply = ControlReplySchema.parse({
      kind: 'undo-result',
      requestId: 'r4',
      fileFolder: 'demo',
      applied: true,
      file: 'files/demo/src/frames/Hero.tsx',
    });
    const redoReply = ControlReplySchema.parse({
      kind: 'redo-result',
      requestId: 'r5',
      fileFolder: 'demo',
      applied: false,
      file: null,
    });
    expect(okReply.kind).toBe('get-canvas-json-result');
    expect(dupReply.kind).toBe('duplicate-frame-result');
    expect(errReply.kind).toBe('control-error');
    expect(undoReply.kind).toBe('undo-result');
    expect(redoReply.kind).toBe('redo-result');
  });

  it('rejects a bare DaemonEvent-shaped message (has `t`, not `kind`)', () => {
    expect(ControlReplySchema.safeParse({ t: 'file-changed', file: 'x' }).success).toBe(false);
  });

  it('rejects a bare ProjectInfo-shaped message (neither `t` nor `kind`)', () => {
    expect(ControlReplySchema.safeParse({ frames: [], daemonPort: 4700 }).success).toBe(false);
  });
});
