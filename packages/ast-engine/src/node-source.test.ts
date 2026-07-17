import { describe, expect, it } from 'vitest';
import { buildTree } from './build-tree.js';
import { getNodeSource } from './node-source.js';

/**
 * `getNodeSource` (FP-INS-b) — verifies the Inspect tab's "Code (JSX)"
 * source-slice resolver: same uid <-> AST-node mapping `buildTree` already
 * proves conformant (ADR-0017), so every uid `buildTree` emits for a fixture
 * must resolve here to a real, non-empty slice of that fixture's own source
 * text — and a component-instance uid's slice must be its `<Component .../>`
 * usage, not its expanded internals (this package never inlines a design-
 * system component's implementation).
 */
describe('getNodeSource', () => {
  const RELPATH = 'src/frames/Hero.tsx';

  it('resolves the whole root node to its own opening tag', () => {
    const source = `export default function Hero() {
  return (
    <section>
      <h1>Title</h1>
      <p>Body</p>
    </section>
  );
}
`;
    const tree = buildTree(source, RELPATH);
    const result = getNodeSource(source, tree.uid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toContain('<section>');
      expect(result.source).toContain('<h1>Title</h1>');
    }
  });

  it('resolves a leaf child node to exactly its own slice, not a sibling\'s', () => {
    const source = `export default function Hero() {
  return (
    <section>
      <h1>Title</h1>
      <p>Body</p>
    </section>
  );
}
`;
    const tree = buildTree(source, RELPATH);
    const h1 = tree.children[0]!;
    const p = tree.children[1]!;
    expect(h1.tag).toBe('h1');
    expect(p.tag).toBe('p');

    const h1Result = getNodeSource(source, h1.uid);
    const pResult = getNodeSource(source, p.uid);
    expect(h1Result).toEqual({ ok: true, source: '<h1>Title</h1>' });
    expect(pResult).toEqual({ ok: true, source: '<p>Body</p>' });
  });

  it('resolves a component-instance node to its <Component .../> usage, not its (unavailable) internals', () => {
    const source = `import { Button } from '@ds/components';

export default function Hero() {
  return (
    <section>
      <Button variant="primary">Click me</Button>
    </section>
  );
}
`;
    const tree = buildTree(source, RELPATH);
    const buttonNode = tree.children[0]!;
    expect(buttonNode.kind).toBe('component-instance');

    const result = getNodeSource(source, buttonNode.uid);
    expect(result).toEqual({ ok: true, source: '<Button variant="primary">Click me</Button>' });
  });

  it('rejects a malformed uid (no ".tsx:" marker)', () => {
    const result = getNodeSource('export default function X() { return null; }\n', 'not-a-real-uid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/malformed NodeUid/);
  });

  it('reports not-found for a well-formed uid whose astPath does not exist in this source', () => {
    const source = `export default function Hero() {
  return <div>only one node</div>;
}
`;
    const result = getNodeSource(source, `${RELPATH}:d0.99`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no JSX node found/);
  });

  it('a fragment child uid still resolves (fragments are path nodes even though they carry no DOM data-uid)', () => {
    const source = `export default function Hero() {
  return (
    <>
      <span>A</span>
      <span>B</span>
    </>
  );
}
`;
    const tree = buildTree(source, RELPATH);
    expect(tree.kind).toBe('fragment');
    const first = tree.children[0]!;
    const result = getNodeSource(source, first.uid);
    expect(result).toEqual({ ok: true, source: '<span>A</span>' });
  });
});
