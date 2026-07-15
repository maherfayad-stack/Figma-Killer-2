import { describe, expect, it } from 'vitest';
import {
  deleteNodeRemap,
  insertNodeRemap,
  moveNodeRemap,
  parentAndIndexOf,
  rewritePrefix,
  shiftForInsertion,
  shiftForRemoval,
  wrapNodeRemap,
} from './uid-remap.js';

// A representative pre-image tree:
// d0                (root div)
//   d0.0             <span>
//   d0.1             <p>
//     d0.1.0          <em> (child of the p)
//   d0.2             <footer>
describe('parentAndIndexOf', () => {
  it('splits a non-root astPath', () => {
    expect(parentAndIndexOf('d0.1.0')).toEqual({ parentAstPath: 'd0.1', index: 0 });
    expect(parentAndIndexOf('d0.2')).toEqual({ parentAstPath: 'd0', index: 2 });
  });

  it('throws for a root astPath (documented scope limitation)', () => {
    expect(() => parentAndIndexOf('d0')).toThrow(/file root/);
  });
});

describe('shiftForInsertion', () => {
  const entries = ['d0.0', 'd0.1', 'd0.1.0', 'd0.2'];

  it('shifts siblings at/after the insertion index, cascading into descendants', () => {
    const remap = shiftForInsertion(entries, 'd0', 1);
    expect(Object.fromEntries(remap)).toEqual({
      'd0.1': 'd0.2',
      'd0.1.0': 'd0.2.0',
      'd0.2': 'd0.3',
    });
  });

  it('leaves siblings before the insertion index untouched (no entry)', () => {
    const remap = shiftForInsertion(entries, 'd0', 1);
    expect(remap.has('d0.0')).toBe(false);
  });

  it('is a no-op for unrelated ancestors', () => {
    const remap = shiftForInsertion(entries, 'd5', 0);
    expect(remap.size).toBe(0);
  });
});

describe('shiftForRemoval', () => {
  const entries = ['d0.0', 'd0.1', 'd0.1.0', 'd0.2'];

  it('omits the removed subtree and shifts later siblings down', () => {
    const remap = shiftForRemoval(entries, 'd0', 1);
    expect(remap.has('d0.1')).toBe(false);
    expect(remap.has('d0.1.0')).toBe(false);
    expect(Object.fromEntries(remap)).toEqual({ 'd0.2': 'd0.1' });
  });
});

describe('rewritePrefix', () => {
  it('rewrites the exact node and its descendants, preserving suffix', () => {
    const entries = ['d0.1', 'd0.1.0', 'd0.2'];
    const remap = rewritePrefix(entries, 'd0.1', 'd2.0');
    expect(Object.fromEntries(remap)).toEqual({ 'd0.1': 'd2.0', 'd0.1.0': 'd2.0.0' });
  });
});

describe('insertNodeRemap', () => {
  it('matches shiftForInsertion for a single insert', () => {
    const entries = ['d0.0', 'd0.1'];
    expect(insertNodeRemap(entries, 'd0', 0)).toEqual(shiftForInsertion(entries, 'd0', 0));
  });
});

describe('deleteNodeRemap', () => {
  it('matches shiftForRemoval derived from the target astPath', () => {
    const entries = ['d0.0', 'd0.1', 'd0.2'];
    expect(deleteNodeRemap(entries, 'd0.0')).toEqual(shiftForRemoval(entries, 'd0', 0));
  });
});

describe('moveNodeRemap', () => {
  it('same-parent reorder: simulates a splice, only touched indices get entries', () => {
    // [A@0, B@1, C@2] -> move A to index 2 -> [B@0, C@1, A@2]
    const entries = ['d0.0', 'd0.1', 'd0.2'];
    const remap = moveNodeRemap(entries, 'd0.0', 'd0', 2);
    expect(Object.fromEntries(remap)).toEqual({
      'd0.0': 'd0.2',
      'd0.1': 'd0.0',
      'd0.2': 'd0.1',
    });
  });

  it('same-parent reorder to the same position is a true no-op', () => {
    const entries = ['d0.0', 'd0.1', 'd0.2'];
    const remap = moveNodeRemap(entries, 'd0.1', 'd0', 1);
    expect(remap.size).toBe(0);
  });

  it('cross-parent reparent: old siblings shift down, new siblings shift up, moved subtree rewritten', () => {
    // d0 has children at 0,1 (moving d0.0 away); d1 has children at 0 (moving into index 0)
    const entries = ['d0.0', 'd0.0.5', 'd0.1', 'd1.0'];
    const remap = moveNodeRemap(entries, 'd0.0', 'd1', 0);
    expect(Object.fromEntries(remap)).toEqual({
      'd0.0': 'd1.0', // moved node itself
      'd0.0.5': 'd1.0.5', // moved node's descendant, suffix preserved
      'd0.1': 'd0.0', // old sibling shifts down
      'd1.0': 'd1.1', // new sibling shifts up
    });
  });
});

describe('wrapNodeRemap', () => {
  it('wraps a contiguous range: wrapped nodes nest one level, later siblings shift by (count-1)', () => {
    // d0 children: 0,1,2,3 — wrap [1,2] into one new wrapper at index 1
    const entries = ['d0.0', 'd0.1', 'd0.1.0', 'd0.2', 'd0.3'];
    const remap = wrapNodeRemap(entries, 'd0', [1, 2]);
    expect(Object.fromEntries(remap)).toEqual({
      'd0.1': 'd0.1.0',
      'd0.1.0': 'd0.1.0.0',
      'd0.2': 'd0.1.1',
      'd0.3': 'd0.2',
    });
    expect(remap.has('d0.0')).toBe(false);
  });

  it('wrapping a single node still adds one nesting level (count=1, no sibling shift)', () => {
    const entries = ['d0.0', 'd0.1'];
    const remap = wrapNodeRemap(entries, 'd0', [0]);
    expect(Object.fromEntries(remap)).toEqual({ 'd0.0': 'd0.0.0' });
    // sibling after: shift by (count-1) = 0, so d0.1 unchanged -> no entry
    expect(remap.has('d0.1')).toBe(false);
  });
});
