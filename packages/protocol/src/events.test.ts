import { describe, expect, it } from 'vitest';
import { DaemonEventSchema } from './events.js';

const uid = 'src/frames/Hero.tsx:JSXElement[3]';
const uid2 = 'src/frames/Hero.tsx:JSXElement[4]';

describe('DaemonEvent — valid events parse', () => {
  it('file-changed (added per §4/P0, not in Appendix B)', () => {
    const evt = { t: 'file-changed', file: 'src/frames/Hero.tsx' };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });

  it('hmr-update', () => {
    const evt = { t: 'hmr-update', file: 'src/frames/Hero.tsx' };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });

  it('uid-remap with a NodeUid -> NodeUid map', () => {
    const evt = { t: 'uid-remap', file: 'src/frames/Hero.tsx', map: { [uid]: uid2 } };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });

  it('tree-snapshot with a nested tree', () => {
    const evt = {
      t: 'tree-snapshot',
      file: 'src/frames/Hero.tsx',
      tree: {
        uid,
        kind: 'element',
        tag: 'div',
        dynamic: false,
        children: [{ uid: uid2, kind: 'text', tag: null, dynamic: false, children: [] }],
      },
    };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });

  it('tokens-changed and components-changed (no payload)', () => {
    expect(DaemonEventSchema.parse({ t: 'tokens-changed' })).toEqual({ t: 'tokens-changed' });
    expect(DaemonEventSchema.parse({ t: 'components-changed' })).toEqual({
      t: 'components-changed',
    });
  });

  it('op-applied carries an inverse CanvasOp[]', () => {
    const evt = {
      t: 'op-applied',
      opId: 'op_1',
      inverse: [{ t: 'set-text', uid, text: 'previous text' }],
    };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });

  it('op-rejected — demonstrates a set-prop-with-expression rejection is representable', () => {
    // This is the "expression value must be representable as rejectable"
    // requirement: ast-engine (P3) detects a non-literal prop value at
    // apply-time and answers with op-rejected, not a schema failure.
    const evt = {
      t: 'op-rejected',
      opId: 'op_2',
      reason: 'set-prop value is not a literal (expression detected): edit in code',
    };
    expect(DaemonEventSchema.parse(evt)).toEqual(evt);
  });
});

describe('DaemonEvent — invalid events reject', () => {
  it('rejects an unknown discriminant', () => {
    expect(() => DaemonEventSchema.parse({ t: 'file-deleted', file: 'x' })).toThrow();
  });

  it('rejects uid-remap with a malformed key', () => {
    expect(() =>
      DaemonEventSchema.parse({ t: 'uid-remap', file: 'x', map: { 'not-a-uid': uid2 } }),
    ).toThrow();
  });

  it('rejects uid-remap with a malformed value', () => {
    expect(() =>
      DaemonEventSchema.parse({ t: 'uid-remap', file: 'x', map: { [uid]: 'not-a-uid' } }),
    ).toThrow();
  });

  it('rejects tokens-changed with an unexpected payload (strict)', () => {
    expect(() => DaemonEventSchema.parse({ t: 'tokens-changed', extra: 1 })).toThrow();
  });

  it('rejects op-rejected missing reason', () => {
    expect(() => DaemonEventSchema.parse({ t: 'op-rejected', opId: 'op_3' })).toThrow();
  });

  it('rejects tree-snapshot with a dynamic field of the wrong type', () => {
    expect(() =>
      DaemonEventSchema.parse({
        t: 'tree-snapshot',
        file: 'x',
        tree: { uid, kind: 'element', tag: 'div', dynamic: 'yes', children: [] },
      }),
    ).toThrow();
  });
});
