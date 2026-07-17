import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@ccs/protocol';
import { childUid, findParent, findPath } from './tree-nav.js';

const tree: TreeNode = {
  uid: 'src/frames/Hero.tsx:d0',
  kind: 'element',
  tag: 'section',
  dynamic: false,
  children: [
    { uid: 'src/frames/Hero.tsx:d0.0', kind: 'element', tag: 'h1', dynamic: false, children: [] },
    {
      uid: 'src/frames/Hero.tsx:d0.1',
      kind: 'element',
      tag: 'div',
      dynamic: false,
      children: [{ uid: 'src/frames/Hero.tsx:d0.1.0', kind: 'element', tag: 'span', dynamic: false, children: [] }],
    },
  ],
};

describe('findParent', () => {
  it('finds a top-level child’s parent and index', () => {
    const result = findParent(tree, 'src/frames/Hero.tsx:d0.1');
    expect(result?.parent.uid).toBe('src/frames/Hero.tsx:d0');
    expect(result?.index).toBe(1);
  });

  it('finds a nested grandchild’s parent', () => {
    const result = findParent(tree, 'src/frames/Hero.tsx:d0.1.0');
    expect(result?.parent.uid).toBe('src/frames/Hero.tsx:d0.1');
    expect(result?.index).toBe(0);
  });

  it('returns null for the root (no parent) or an unknown uid', () => {
    expect(findParent(tree, 'src/frames/Hero.tsx:d0')).toBeNull();
    expect(findParent(tree, 'src/frames/Hero.tsx:nope')).toBeNull();
  });
});

describe('childUid', () => {
  it('appends the sibling index to the parent astPath (ADR-0017 encoding)', () => {
    expect(childUid('src/frames/Hero.tsx:d0', 2)).toBe('src/frames/Hero.tsx:d0.2');
  });
});

describe('findPath', () => {
  it('returns the single-entry path for the root itself', () => {
    const path = findPath(tree, 'src/frames/Hero.tsx:d0');
    expect(path?.map((n) => n.uid)).toEqual(['src/frames/Hero.tsx:d0']);
  });

  it('returns the full outermost -> innermost chain for a nested grandchild', () => {
    const path = findPath(tree, 'src/frames/Hero.tsx:d0.1.0');
    expect(path?.map((n) => n.uid)).toEqual([
      'src/frames/Hero.tsx:d0',
      'src/frames/Hero.tsx:d0.1',
      'src/frames/Hero.tsx:d0.1.0',
    ]);
  });

  it('returns null for an unknown uid', () => {
    expect(findPath(tree, 'src/frames/Hero.tsx:nope')).toBeNull();
  });
});
