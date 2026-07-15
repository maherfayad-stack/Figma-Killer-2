import { describe, expect, it } from 'vitest';
import { flattenTree } from './Tree.js';

interface Node {
  id: string;
  children: Node[];
}

const tree: Node[] = [
  { id: 'a', children: [{ id: 'a1', children: [] }, { id: 'a2', children: [] }] },
  { id: 'b', children: [] },
];

describe('flattenTree', () => {
  it('flattens only expanded branches, preserving depth', () => {
    const rows = flattenTree(tree, (n) => n.id, (n) => n.children, new Set());
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[1]?.hasChildren).toBe(false);
  });

  it('expands a branch when its id is in expandedIds', () => {
    const rows = flattenTree(tree, (n) => n.id, (n) => n.children, new Set(['a']));
    expect(rows.map((r) => `${r.id}@${r.depth}`)).toEqual(['a@0', 'a1@1', 'a2@1', 'b@0']);
  });

  it('recurses into nested expanded branches', () => {
    const deep: Node[] = [{ id: 'x', children: [{ id: 'y', children: [{ id: 'z', children: [] }] }] }];
    const rows = flattenTree(deep, (n) => n.id, (n) => n.children, new Set(['x', 'y']));
    expect(rows.map((r) => r.id)).toEqual(['x', 'y', 'z']);
  });
});
