import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

/**
 * astPath derivation — the ts-morph PORT of the canonical algorithm frozen
 * in `packages/vite-plugin-source-uid/src/uid-path.ts` (ADR-0016, ratified
 * as a golden-CORPUS relationship rather than shared code by ADR-0017 —
 * see `conformance-corpus.test.ts` for the byte-identical proof).
 *
 * ALGORITHM CONTRACT (copied verbatim from the babel reference — do not
 * change without a new ADR, it breaks uid stability for every tagged file):
 *
 *  1. Every JSX "path node" gets an astPath. In Babel's AST a `JSXElement`
 *     covers BOTH self-closing and non-self-closing tags; the TypeScript
 *     compiler API (which ts-morph wraps) instead splits these into two
 *     distinct SyntaxKinds — `JsxElement` (has open+close) and
 *     `JsxSelfClosingElement`. Both, plus `JsxFragment`, are "path nodes"
 *     here — the union is the ts-morph equivalent of Babel's
 *     `JSXElement | JSXFragment`.
 *  2. A node's NEAREST JSX ANCESTOR is the closest enclosing path node
 *     found by walking up the real AST parent chain (`getParent()`),
 *     skipping every non-JSX construct in between.
 *  3. A node with NO JSX ancestor is a ROOT. Roots are numbered `d0`, `d1`,
 *     ... in the order first ENTERED during a single pre-order
 *     (parent-before-children), left-to-right traversal of the whole file.
 *  4. A non-root node's astPath is `<nearestAncestorAstPath>.<index>`,
 *     `index` = 0-based ordinal among ALL path-nodes sharing that nearest
 *     ancestor, counted in the same pre-order traversal.
 *  5. The final astPath is the root token (`d0`) or the dot-joined chain
 *     (`d0.1.2`) — no other separators/characters.
 *  6. Whitespace/comments/text NEVER affect numbering — only path-node
 *     identity and traversal order do.
 *  7. Renumbering happens iff the JSX structure actually changes.
 *  8. `JsxFragment` nodes count in numbering but never carry a `data-uid`
 *     DOM attribute (no DOM node to carry one).
 */

export function isJsxPathNode(node: Node): boolean {
  const kind = node.getKind();
  return (
    kind === SyntaxKind.JsxElement ||
    kind === SyntaxKind.JsxSelfClosingElement ||
    kind === SyntaxKind.JsxFragment
  );
}

export interface UidPathTracker {
  /**
   * Compute (and cache) the astPath for one JSX path node. MUST be invoked
   * in pre-order (enter) traversal order — a non-root node's path derives
   * from its nearest ancestor's already-computed path.
   */
  pathFor(node: Node): string;
}

export function createUidPathTracker(): UidPathTracker {
  let rootCount = 0;
  const childCounters = new Map<Node, number>();
  const paths = new Map<Node, string>();

  return {
    pathFor(node: Node): string {
      const cached = paths.get(node);
      if (cached !== undefined) return cached;

      let ancestor: Node | undefined = node.getParent();
      while (ancestor && !isJsxPathNode(ancestor)) {
        ancestor = ancestor.getParent();
      }

      if (!ancestor) {
        const astPath = `d${rootCount}`;
        rootCount += 1;
        paths.set(node, astPath);
        return astPath;
      }

      const ancestorAstPath = paths.get(ancestor);
      if (ancestorAstPath === undefined) {
        throw new Error(
          '@ccs/ast-engine: astPath ancestor not yet computed — ' +
            'pathFor() must be called in pre-order (enter) traversal order',
        );
      }

      const childIndex = childCounters.get(ancestor) ?? 0;
      childCounters.set(ancestor, childIndex + 1);
      const astPath = `${ancestorAstPath}.${childIndex}`;
      paths.set(node, astPath);
      return astPath;
    },
  };
}

export interface DerivedUidPathEntry {
  type: 'JSXElement' | 'JSXFragment';
  tagName: string | null;
  start: number;
  end: number;
  astPath: string;
  node: Node;
}

function getTagNameForPathNode(node: Node): string | null {
  const kind = node.getKind();

  if (kind === SyntaxKind.JsxFragment) return null;

  const tagNameNode =
    kind === SyntaxKind.JsxSelfClosingElement
      ? node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement).getTagNameNode()
      : node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement().getTagNameNode();

  return Node.isIdentifier(tagNameNode) ? tagNameNode.getText() : null;
}

/**
 * Walk a whole SourceFile in pre-order and derive every JSX path node's
 * astPath, in encounter order — the ts-morph analogue of
 * `deriveUidPaths()` in the babel package, used both by the real
 * resolver (`resolveUid`) and by the conformance-corpus test (which
 * compares this output field-for-field against the babel plugin's).
 */
export function deriveUidPathsForFile(sourceFile: SourceFile): DerivedUidPathEntry[] {
  const tracker = createUidPathTracker();
  const entries: DerivedUidPathEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!isJsxPathNode(node)) return;

    const astPath = tracker.pathFor(node);
    const kind = node.getKind();
    entries.push({
      type: kind === SyntaxKind.JsxFragment ? 'JSXFragment' : 'JSXElement',
      tagName: getTagNameForPathNode(node),
      start: node.getStart(),
      end: node.getEnd(),
      astPath,
      node,
    });
  });

  return entries;
}

/**
 * Resolve a single astPath string (the half of a NodeUid after the `:`) to
 * its ts-morph Node within `sourceFile`. Returns `undefined` if no path
 * node in this file carries that astPath (caller maps this to
 * `ApplyOpError('uid-not-found')`).
 */
export function resolveAstPath(sourceFile: SourceFile, astPath: string): Node | undefined {
  const entries = deriveUidPathsForFile(sourceFile);
  return entries.find((entry) => entry.astPath === astPath)?.node;
}
