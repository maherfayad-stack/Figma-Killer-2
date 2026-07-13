import { describe, expect, it } from 'vitest';
import {
  CanvasOpSchema,
  SetTextOpSchema,
  SetPropOpSchema,
  SetClassesOpSchema,
  InsertNodeOpSchema,
  DeleteNodeOpSchema,
  MoveNodeOpSchema,
  WrapNodeOpSchema,
} from './ops.js';

const uid = 'src/frames/Hero.tsx:JSXElement[3]';
const uid2 = 'src/frames/Hero.tsx:JSXElement[4]';

describe('CanvasOp — valid ops parse (one per Appendix B variant)', () => {
  it('set-text', () => {
    const op = { t: 'set-text', uid, text: 'Book your next trip' };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
    expect(SetTextOpSchema.parse(op)).toEqual(op);
  });

  it('set-text — Arabic/RTL content round-trips byte-exact (playbook §5.9)', () => {
    const arabic = 'احجز رحلتك القادمة الآن';
    const op = { t: 'set-text', uid, text: arabic };
    const parsed = CanvasOpSchema.parse(op);
    expect(parsed).toEqual(op);
    if (parsed.t === 'set-text') {
      expect(parsed.text).toBe(arabic);
    }
  });

  it('set-prop with a literal string value', () => {
    const op = { t: 'set-prop', uid, name: 'label', value: 'Book now' };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('set-prop with a number/boolean/null value', () => {
    expect(() => CanvasOpSchema.parse({ t: 'set-prop', uid, name: 'max', value: 9 })).not.toThrow();
    expect(() =>
      CanvasOpSchema.parse({ t: 'set-prop', uid, name: 'disabled', value: true }),
    ).not.toThrow();
    expect(() =>
      CanvasOpSchema.parse({ t: 'set-prop', uid, name: 'icon', value: null }),
    ).not.toThrow();
  });

  it('set-prop with a token reference value', () => {
    const op = { t: 'set-prop', uid, name: 'color', value: { token: 'color.primary' } };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('set-classes with add/remove', () => {
    const op = { t: 'set-classes', uid, add: ['bg-red-500'], remove: ['bg-blue-500'] };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('insert-node with a ds-component source', () => {
    const op = {
      t: 'insert-node',
      parentUid: uid,
      index: 0,
      source: { kind: 'ds-component', name: 'Button' },
    };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('insert-node with an element source', () => {
    const op = {
      t: 'insert-node',
      parentUid: uid,
      index: 2,
      source: { kind: 'element', tag: 'div', classes: 'flex gap-2' },
    };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('delete-node', () => {
    const op = { t: 'delete-node', uid };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('move-node', () => {
    const op = { t: 'move-node', uid, newParentUid: uid2, index: 1 };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });

  it('wrap-node', () => {
    const op = {
      t: 'wrap-node',
      uids: [uid, uid2],
      wrapper: { tag: 'div', classes: 'flex flex-col' },
    };
    expect(CanvasOpSchema.parse(op)).toEqual(op);
  });
});

describe('CanvasOp — invalid ops reject', () => {
  it('rejects an unknown discriminant', () => {
    expect(() => CanvasOpSchema.parse({ t: 'set-color', uid, value: 'red' })).toThrow();
  });

  it('rejects a malformed uid', () => {
    expect(() => SetTextOpSchema.parse({ t: 'set-text', uid: 'not-a-uid', text: 'x' })).toThrow();
  });

  it('rejects set-text missing the text field', () => {
    expect(() => CanvasOpSchema.parse({ t: 'set-text', uid })).toThrow();
  });

  it('rejects set-prop with an extra unknown key (strict object)', () => {
    expect(() =>
      SetPropOpSchema.parse({ t: 'set-prop', uid, name: 'x', value: '1', extra: true }),
    ).toThrow();
  });

  it('rejects set-prop with a function-shaped value (not JSON-representable) — the "expression" case', () => {
    // A JS *expression* (e.g. `count + 1`) has no JSON representation at all —
    // it can never even reach the wire as a `value`. What CAN reach the wire
    // is a value shape that isn't a plain literal, e.g. `undefined` (which
    // JSON.stringify drops, so a real op could never legitimately carry it).
    // Schema-level: an actual JS function fails to parse as Json | token | null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notJson: any = () => 'expression';
    expect(() =>
      SetPropOpSchema.parse({ t: 'set-prop', uid, name: 'onClick', value: notJson }),
    ).toThrow();
  });

  it('rejects insert-node with a negative index', () => {
    expect(() =>
      InsertNodeOpSchema.parse({
        t: 'insert-node',
        parentUid: uid,
        index: -1,
        source: { kind: 'element', tag: 'div' },
      }),
    ).toThrow();
  });

  it('rejects insert-node with a non-integer index', () => {
    expect(() =>
      InsertNodeOpSchema.parse({
        t: 'insert-node',
        parentUid: uid,
        index: 1.5,
        source: { kind: 'element', tag: 'div' },
      }),
    ).toThrow();
  });

  it('rejects insert-node with an unknown source kind', () => {
    expect(() =>
      InsertNodeOpSchema.parse({
        t: 'insert-node',
        parentUid: uid,
        index: 0,
        source: { kind: 'raw-jsx', code: '<div/>' },
      }),
    ).toThrow();
  });

  it('rejects delete-node with a malformed uid', () => {
    expect(() => DeleteNodeOpSchema.parse({ t: 'delete-node', uid: 'nope' })).toThrow();
  });

  it('rejects move-node with a negative index', () => {
    expect(() =>
      MoveNodeOpSchema.parse({ t: 'move-node', uid, newParentUid: uid2, index: -5 }),
    ).toThrow();
  });

  it('rejects wrap-node with an empty uids array', () => {
    expect(() =>
      WrapNodeOpSchema.parse({ t: 'wrap-node', uids: [], wrapper: { tag: 'div', classes: '' } }),
    ).toThrow();
  });

  it('rejects wrap-node with a non-div wrapper tag (Appendix B locks this to "div")', () => {
    expect(() =>
      WrapNodeOpSchema.parse({
        t: 'wrap-node',
        uids: [uid],
        wrapper: { tag: 'span', classes: '' },
      }),
    ).toThrow();
  });

  it('rejects set-classes where add/remove are not string arrays', () => {
    expect(() =>
      SetClassesOpSchema.parse({ t: 'set-classes', uid, add: [1, 2], remove: [] }),
    ).toThrow();
  });
});
