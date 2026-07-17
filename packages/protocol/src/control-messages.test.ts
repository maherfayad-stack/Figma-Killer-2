import { describe, expect, it } from 'vitest';
import {
  ControlErrorSchema,
  ControlReplySchema,
  ControlRequestSchema,
  CreateFrameRequestSchema,
  CreateTokenRequestSchema,
  DeleteTokenRequestSchema,
  DuplicateFrameRequestSchema,
  DuplicateFrameResultSchema,
  GetCanvasJsonRequestSchema,
  GetCanvasJsonResultSchema,
  ReadSourceRequestSchema,
  ReadSourceResultSchema,
  RedoRequestSchema,
  RedoResultSchema,
  SetTokenRequestSchema,
  TokenWriteResultSchema,
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

// ---- P4 (playbook §4/P4, ADR-0022) — additive token-CRUD messages -------

describe('SetTokenRequestSchema / CreateTokenRequestSchema / DeleteTokenRequestSchema', () => {
  it('accepts a well-formed set-token request (string value)', () => {
    const req = { kind: 'set-token', requestId: 'r1', group: 'color', theme: 'light', key: 'aqua100', value: '#123456' };
    expect(SetTokenRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts a numeric value (spacing/rounded groups)', () => {
    const req = { kind: 'set-token', requestId: 'r1', group: 'spacing', theme: 'light', key: 'md', value: 20 };
    expect(SetTokenRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects an unknown group (typography is out of v1 CRUD scope)', () => {
    expect(
      SetTokenRequestSchema.safeParse({
        kind: 'set-token',
        requestId: 'r1',
        group: 'typography',
        theme: 'light',
        key: 'display.fontSize',
        value: '34px',
      }).success,
    ).toBe(false);
  });

  it('rejects extra/unknown fields (strict)', () => {
    expect(
      SetTokenRequestSchema.safeParse({
        kind: 'set-token',
        requestId: 'r1',
        group: 'color',
        theme: 'light',
        key: 'aqua100',
        value: '#123456',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed create-token request', () => {
    const req = { kind: 'create-token', requestId: 'r2', group: 'color', theme: 'dark', key: 'coral300', value: '#ABCDEF' };
    expect(CreateTokenRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts a well-formed delete-token request (no value field)', () => {
    const req = { kind: 'delete-token', requestId: 'r3', group: 'rounded', theme: 'light', key: 'xxl' };
    expect(DeleteTokenRequestSchema.parse(req)).toEqual(req);
  });

  it('is part of the ControlRequestSchema union', () => {
    const parsed = ControlRequestSchema.parse({
      kind: 'set-token',
      requestId: 'r1',
      group: 'color',
      theme: 'light',
      key: 'aqua100',
      value: '#123456',
    });
    expect(parsed.kind).toBe('set-token');
  });

  // ---- CR (AUDIT-7 blocker close-out) — narrowed key/value wire schema ---
  //
  // Additive/narrowing only (no field added/removed): a `key` outside the
  // CSS-custom-property-safe identifier charset, or a string `value`
  // containing a declaration/rule-breaking sequence, is now rejected at
  // parse time. This is a cheap early filter, NOT the authoritative gate —
  // see `packages/sync-daemon/src/token-crud.ts`'s `validateTokenKey`/
  // `validateTokenValue` for the real (per-group) check.
  describe('narrowed key/value validation (CR)', () => {
    it('rejects the AUDIT-7 injection payload delivered via key', () => {
      expect(
        SetTokenRequestSchema.safeParse({
          kind: 'set-token',
          requestId: 'r1',
          group: 'color',
          theme: 'light',
          key: 'x: red; } body { display:none } /* pwned',
          value: '#000',
        }).success,
      ).toBe(false);
    });

    it('rejects an equivalent injection payload delivered via value', () => {
      expect(
        CreateTokenRequestSchema.safeParse({
          kind: 'create-token',
          requestId: 'r2',
          group: 'color',
          theme: 'light',
          key: 'legitname',
          value: 'red; } body { display:none } /* pwned */',
        }).success,
      ).toBe(false);
    });

    it('rejects a key exceeding the max length', () => {
      expect(
        SetTokenRequestSchema.safeParse({
          kind: 'set-token',
          requestId: 'r1',
          group: 'color',
          theme: 'light',
          key: 'a'.repeat(65),
          value: '#000',
        }).success,
      ).toBe(false);
    });

    it('still accepts digit-leading and hyphenated keys (no false-positive regression)', () => {
      expect(
        SetTokenRequestSchema.safeParse({
          kind: 'set-token',
          requestId: 'r1',
          group: 'spacing',
          theme: 'light',
          key: '2xl',
          value: 40,
        }).success,
      ).toBe(true);
    });

    it('delete-token also validates key (no value field to worry about)', () => {
      expect(
        DeleteTokenRequestSchema.safeParse({
          kind: 'delete-token',
          requestId: 'r3',
          group: 'color',
          theme: 'light',
          key: 'x; } body {}',
        }).success,
      ).toBe(false);
    });
  });
});

// ---- FP-INS-b — additive, read-only Inspect-tab source-read message -----

describe('ReadSourceRequestSchema', () => {
  it('accepts a whole-frame request (no uid)', () => {
    const req = { kind: 'read-source', requestId: 'r1', fileFolder: 'demo', framePath: 'src/frames/Hero.tsx' };
    expect(ReadSourceRequestSchema.parse(req)).toEqual(req);
  });

  it('accepts a node-slice request (uid present)', () => {
    const req = {
      kind: 'read-source',
      requestId: 'r1',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      uid: 'src/frames/Hero.tsx:d0.1',
    };
    expect(ReadSourceRequestSchema.parse(req)).toEqual(req);
  });

  it('rejects a missing framePath', () => {
    expect(ReadSourceRequestSchema.safeParse({ kind: 'read-source', requestId: 'r1', fileFolder: 'demo' }).success).toBe(
      false,
    );
  });

  it('rejects extra/unknown fields (strict)', () => {
    expect(
      ReadSourceRequestSchema.safeParse({
        kind: 'read-source',
        requestId: 'r1',
        fileFolder: 'demo',
        framePath: 'src/frames/Hero.tsx',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });

  it('is part of the ControlRequestSchema union', () => {
    const parsed = ControlRequestSchema.parse({
      kind: 'read-source',
      requestId: 'r1',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
    });
    expect(parsed.kind).toBe('read-source');
  });
});

describe('ReadSourceResultSchema', () => {
  it('accepts a whole-frame result (uid: null)', () => {
    const reply = {
      kind: 'read-source-result',
      requestId: 'r1',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      uid: null,
      source: 'export default function Hero() { return null; }\n',
    };
    expect(ReadSourceResultSchema.parse(reply)).toEqual(reply);
  });

  it('accepts a node-slice result', () => {
    const reply = {
      kind: 'read-source-result',
      requestId: 'r1',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      uid: 'src/frames/Hero.tsx:d0.1',
      source: '<h1>Hero</h1>',
    };
    expect(ReadSourceResultSchema.parse(reply)).toEqual(reply);
  });

  it('is part of the ControlReplySchema union', () => {
    const parsed = ControlReplySchema.parse({
      kind: 'read-source-result',
      requestId: 'r1',
      fileFolder: 'demo',
      framePath: 'src/frames/Hero.tsx',
      uid: null,
      source: 'x',
    });
    expect(parsed.kind).toBe('read-source-result');
  });
});

describe('TokenWriteResultSchema', () => {
  it('accepts a successful reply', () => {
    const reply = { kind: 'token-write-result', requestId: 'r1', applied: true };
    expect(TokenWriteResultSchema.parse(reply)).toEqual(reply);
  });

  it('accepts a failed reply with a reason', () => {
    const reply = { kind: 'token-write-result', requestId: 'r1', applied: false, reason: 'token already exists' };
    expect(TokenWriteResultSchema.parse(reply)).toEqual(reply);
  });

  it('is part of the ControlReplySchema union', () => {
    const parsed = ControlReplySchema.parse({ kind: 'token-write-result', requestId: 'r1', applied: true });
    expect(parsed.kind).toBe('token-write-result');
  });
});
