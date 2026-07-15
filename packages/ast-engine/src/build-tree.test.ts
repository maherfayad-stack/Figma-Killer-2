import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { transformSourceUid } from '@ccs/vite-plugin-source-uid';
import type { TreeNode } from '@ccs/protocol';
import { buildTree } from './build-tree.js';

/**
 * Unit + conformance tests for `buildTree` (packages/ast-engine/src/
 * build-tree.ts). Two concerns:
 *
 * 1. Structural correctness — exact `uid`/`kind`/`tag`/`dynamic`/`component`
 *    values for hand-derived fixtures (basic static tree, Arabic/RTL,
 *    `.map()`/ternary dynamic, root-selection with a non-default-exported
 *    helper component, and a fragment root).
 * 2. ADR-0017 conformance — `buildTree`'s uids are byte-identical to the
 *    REAL `@ccs/vite-plugin-source-uid` babel plugin's `data-uid` output on
 *    the same fixture (same method `conformance-corpus.test.ts` uses: run
 *    the actual babel transform, read `data-uid` back off the tagged
 *    output, and diff against our result — not a reimplementation of
 *    either side).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__', 'build-tree');

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function flattenUids(node: TreeNode, out: string[] = []): string[] {
  if (node.kind !== 'fragment') out.push(node.uid);
  for (const child of node.children) flattenUids(child, out);
  return out;
}

/** Babel-tagged `data-uid` values, in document order, JSXElement-only
 * (mirrors `conformance-corpus.test.ts`'s `extractBabelTaggedEntries`). */
function babelTaggedUids(source: string, relPath: string): string[] {
  const { code } = transformSourceUid(source, { relPath });
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('babel-output.tsx', code);
  const uids: string[] = [];

  sourceFile.forEachDescendant((node) => {
    const kind = node.getKind();
    if (kind !== SyntaxKind.JsxElement && kind !== SyntaxKind.JsxSelfClosingElement) return;

    const openingElement =
      kind === SyntaxKind.JsxSelfClosingElement
        ? node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement)
        : node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement();

    for (const attr of openingElement.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      if (attr.getNameNode().getText() !== 'data-uid') continue;
      const init = attr.getInitializer();
      if (init && Node.isStringLiteral(init)) uids.push(init.getLiteralText());
    }
  });

  return uids;
}

describe('buildTree — structural correctness', () => {
  it('basic static frame: element root, ds-component + local-component children', () => {
    const relPath = 'src/frames/BasicFrame.tsx';
    const tree = buildTree(readFixture('basic-frame.tsx'), relPath);

    expect(tree).toEqual<TreeNode>({
      uid: `${relPath}:d0`,
      kind: 'element',
      tag: 'section',
      dynamic: false,
      children: [
        { uid: `${relPath}:d0.0`, kind: 'element', tag: 'h1', dynamic: false, children: [] },
        {
          uid: `${relPath}:d0.1`,
          kind: 'element',
          tag: 'p',
          dynamic: false,
          children: [
            { uid: `${relPath}:d0.1.0`, kind: 'element', tag: 'span', dynamic: false, children: [] },
          ],
        },
        { uid: `${relPath}:d0.2`, kind: 'element', tag: 'img', dynamic: false, children: [] },
        {
          uid: `${relPath}:d0.3`,
          kind: 'component-instance',
          tag: 'Button',
          dynamic: false,
          component: 'ds:Button',
          children: [],
        },
        {
          uid: `${relPath}:d0.4`,
          kind: 'component-instance',
          tag: 'Helper',
          dynamic: false,
          component: 'Helper',
          children: [],
        },
      ],
    });
  });

  it('Arabic/RTL frame: byte-preserved structure, no astPath disruption from RTL text', () => {
    const relPath = 'src/frames/ArabicFrame.tsx';
    const tree = buildTree(readFixture('arabic-frame.tsx'), relPath);

    expect(tree).toEqual<TreeNode>({
      uid: `${relPath}:d0`,
      kind: 'element',
      tag: 'section',
      dynamic: false,
      children: [
        { uid: `${relPath}:d0.0`, kind: 'element', tag: 'h2', dynamic: false, children: [] },
        {
          uid: `${relPath}:d0.1`,
          kind: 'element',
          tag: 'p',
          dynamic: false,
          children: [
            { uid: `${relPath}:d0.1.0`, kind: 'element', tag: 'span', dynamic: false, children: [] },
          ],
        },
        { uid: `${relPath}:d0.2`, kind: 'element', tag: 'button', dynamic: false, children: [] },
      ],
    });
  });

  it('.map()/ternary dynamic frame: dynamic flag true only inside the dynamic subtrees', () => {
    const relPath = 'src/frames/DynamicMapFrame.tsx';
    const tree = buildTree(readFixture('dynamic-map-frame.tsx'), relPath);

    expect(tree).toEqual<TreeNode>({
      uid: `${relPath}:d0`,
      kind: 'element',
      tag: 'div',
      dynamic: false,
      children: [
        { uid: `${relPath}:d0.0`, kind: 'element', tag: 'h2', dynamic: false, children: [] },
        {
          uid: `${relPath}:d0.1`,
          kind: 'element',
          tag: 'ul',
          dynamic: false,
          children: [
            {
              uid: `${relPath}:d0.1.0`,
              kind: 'element',
              tag: 'li',
              dynamic: true,
              children: [
                { uid: `${relPath}:d0.1.0.0`, kind: 'element', tag: 'span', dynamic: true, children: [] },
              ],
            },
          ],
        },
        { uid: `${relPath}:d0.2`, kind: 'element', tag: 'button', dynamic: true, children: [] },
        { uid: `${relPath}:d0.3`, kind: 'element', tag: 'span', dynamic: true, children: [] },
        { uid: `${relPath}:d0.4`, kind: 'element', tag: 'footer', dynamic: false, children: [] },
      ],
    });
  });

  it('prefers the default-exported root over an earlier, non-exported helper component root', () => {
    const relPath = 'src/frames/RealFrame.tsx';
    const tree = buildTree(readFixture('multi-fn-default-export.tsx'), relPath);

    // Root must be RealFrame's `<div>` (d1), NOT Helper's `<span>` (d0) —
    // Helper is declared first (source order) but is not the default
    // export, so a naive "first root" fallback would pick the wrong tree.
    expect(tree.uid).toBe(`${relPath}:d1`);
    expect(tree.tag).toBe('div');
    expect(tree.children).toEqual<TreeNode[]>([
      // Helper is a LOCAL (non-imported) component — same rule the babel
      // plugin uses for data-component: "resolves to an IMPORTED
      // component" excludes same-file local declarations, so this stays
      // kind:'element' with no `component` field, not 'component-instance'.
      { uid: `${relPath}:d1.0`, kind: 'element', tag: 'Helper', dynamic: false, children: [] },
      { uid: `${relPath}:d1.1`, kind: 'element', tag: 'p', dynamic: false, children: [] },
    ]);
  });

  it('a default export returning a fragment produces a fragment-kind root', () => {
    const relPath = 'src/frames/FragmentRoot.tsx';
    const tree = buildTree(readFixture('fragment-root.tsx'), relPath);

    expect(tree).toEqual<TreeNode>({
      uid: `${relPath}:d0`,
      kind: 'fragment',
      tag: null,
      dynamic: false,
      children: [
        { uid: `${relPath}:d0.0`, kind: 'element', tag: 'h1', dynamic: false, children: [] },
        { uid: `${relPath}:d0.1`, kind: 'element', tag: 'p', dynamic: false, children: [] },
      ],
    });
  });

  it('throws a clear error for source with no JSX root', () => {
    expect(() => buildTree('export default function Empty() { return null; }', 'src/frames/Empty.tsx')).toThrow(
      /buildTree found no JSX/,
    );
  });
});

describe('buildTree — ADR-0017 conformance: uids byte-identical to the real babel plugin', () => {
  const singleRootFixtures = ['basic-frame.tsx', 'arabic-frame.tsx', 'dynamic-map-frame.tsx', 'fragment-root.tsx'];

  for (const fixtureName of singleRootFixtures) {
    it(`${fixtureName}`, () => {
      const relPath = `src/frames/${fixtureName}`;
      const source = readFixture(fixtureName);

      const tree = buildTree(source, relPath);
      const ourUids = flattenUids(tree);
      const babelUids = babelTaggedUids(source, relPath);

      expect(ourUids).toEqual(babelUids);
    });
  }
});
