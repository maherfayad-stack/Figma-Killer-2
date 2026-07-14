import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

/**
 * astPath derivation — THE single canonical algorithm for the `<astPath>`
 * half of a `NodeUid` (`packages/protocol/src/uid.ts`:
 * `${relPath}.tsx:${astPath}`). Frozen by `.orchestrator/DECISIONS.md`
 * ADR-0016 ("P2 kickoff... freeze the Selection-Bridge interface").
 *
 * WHY THIS FILE IS THE SOURCE OF TRUTH (read before touching):
 * ADR-0016 requires the derivation to live in "ONE shared, exported,
 * golden-tested module... so P3's ast-engine consumes the identical
 * algorithm rather than reimplementing it." P3's `ast-engine` is built on
 * ts-morph (a wholly different AST/traversal API from Babel — see
 * `packages/ast-engine`), so a single function literally callable from both
 * parsers is not possible without inventing a third, parser-agnostic AST
 * layer (a bigger architectural change than P2 WS-A's scope). What CAN be
 * — and is — shared is the exact SEMANTIC CONTRACT below, spelled out
 * precisely enough to port verbatim. `createUidPathTracker` is the tested
 * reference implementation of that contract for Babel; `deriveUidPaths` is
 * a convenience wrapper any consumer (including a future P3 port, or ad hoc
 * tooling) can call directly against raw source text without touching the
 * Vite/babel-plugin machinery. THIS IS AN EXPLICIT INTERFACE GAP — flagged
 * in the P2 WS-A worker report as a CR: P3 must port these rules against
 * ts-morph's `Node`/traversal API, not literally import this module (it
 * depends on `@babel/traverse`'s `NodePath`).
 *
 * ALGORITHM CONTRACT (do not change without a new ADR — it breaks uid
 * stability for every already-tagged file):
 *
 *  1. Every `JSXElement`/`JSXFragment` node in the file gets an astPath.
 *  2. A node's NEAREST JSX ANCESTOR is the closest enclosing
 *     `JSXElement`/`JSXFragment` found by walking up the AST parent chain,
 *     skipping over every non-JSX construct in between — arbitrarily many
 *     layers of `JSXExpressionContainer`, `CallExpression` (`.map()`
 *     callbacks etc.), `ConditionalExpression`, `LogicalExpression`,
 *     function bodies, `JSXAttribute` values, and so on.
 *  3. A node with NO JSX ancestor is a ROOT. Roots are numbered `d0`, `d1`,
 *     `d2`, ... in the order they are first ENTERED during a single
 *     pre-order (parent-before-children), left-to-right traversal of the
 *     whole file — i.e. source order. (`d0` is typically, but not
 *     necessarily, the default export's returned JSX — a file with helper
 *     components/renders earlier in the file gets a lower root index for
 *     those instead; this is fine, see point 7.)
 *  4. A non-root node's astPath is `<nearestAncestorAstPath>.<index>`,
 *     where `index` is the 0-based ordinal position of this node among ALL
 *     path-nodes sharing that same nearest ancestor, counted in the same
 *     pre-order/source-order traversal.
 *  5. The final astPath string is exactly the root token for roots
 *     (`d0`), or the dot-joined chain for non-roots (`d0.1.2`). No other
 *     separators or characters are introduced.
 *  6. Whitespace, comments, and `JSXText` content NEVER affect numbering —
 *     only `JSXElement`/`JSXFragment` node identity and traversal order do.
 *     This is what makes the path HMR-stable across reformatting/comment
 *     edits (playbook §4/P2 pitfall: "derive from AST path not byte
 *     offsets").
 *  7. Renumbering happens if and only if the actual JSX structure changes
 *     (nodes added/removed/reordered before a given node in traversal
 *     order) — exactly when the daemon's `uid-remap` event (Appendix B) is
 *     expected to fire. Stability is promised only across non-structural
 *     (formatting/comment) edits, never across arbitrary code changes.
 *  8. `JSXFragment` (`<>...</>`) nodes ARE counted in this numbering (so
 *     sibling indices stay consistent) but — DEVIATION, called out loudly
 *     in the worker report — cannot receive a `data-uid` DOM attribute:
 *     shorthand JSX fragments have no `openingElement`/props in the AST at
 *     all, and `React.Fragment` renders no DOM node to carry one even if
 *     written out explicitly. The astPath is still computed and reserved
 *     for fragments so numbering doesn't depend on whether a given root
 *     happens to be a fragment or an element.
 */

export type JsxPathNode = t.JSXElement | t.JSXFragment;

export interface UidPathTracker {
  /**
   * Compute (and cache) the astPath for one JSXElement/JSXFragment path.
   * MUST be invoked in `enter` order of a pre-order traversal (parent
   * before descendants) — Babel's default traversal order — because a
   * non-root node's path is derived from its nearest ancestor's
   * already-computed path (contract point 2/4 above).
   */
  pathFor(path: NodePath<t.JSXElement> | NodePath<t.JSXFragment>): string;
}

/**
 * Reference implementation of the algorithm contract above, for Babel's
 * `NodePath`. One tracker instance = one file's worth of state; create a
 * fresh one per file transform (never reuse across files — see
 * `babel-plugin.ts`, which creates one per `transformSync` call via
 * closure, sidestepping Babel's PluginPass-state lifecycle entirely).
 */
export function createUidPathTracker(): UidPathTracker {
  let rootCount = 0;
  const childCounters = new WeakMap<t.Node, number>();
  const paths = new WeakMap<t.Node, string>();

  return {
    pathFor(path) {
      const cached = paths.get(path.node);
      if (cached !== undefined) return cached;

      const ancestorPath = path.findParent(
        (p) => p.isJSXElement() || p.isJSXFragment(),
      ) as NodePath<JsxPathNode> | null;

      if (!ancestorPath) {
        const astPath = `d${rootCount}`;
        rootCount += 1;
        paths.set(path.node, astPath);
        return astPath;
      }

      const ancestorAstPath = paths.get(ancestorPath.node);
      if (ancestorAstPath === undefined) {
        // Contract violation guard: this only happens if a descendant is
        // visited before its ancestor, which shouldn't be possible under
        // Babel's default pre-order `enter` traversal. Fail loudly rather
        // than silently mis-numbering (would corrupt uid stability).
        throw new Error(
          '@ccs/vite-plugin-source-uid: astPath ancestor not yet computed — ' +
            'pathFor() must be called in pre-order (enter) traversal order',
        );
      }

      const childIndex = childCounters.get(ancestorPath.node) ?? 0;
      childCounters.set(ancestorPath.node, childIndex + 1);
      const astPath = `${ancestorAstPath}.${childIndex}`;
      paths.set(path.node, astPath);
      return astPath;
    },
  };
}

export interface DerivedUidPathEntry {
  type: 'JSXElement' | 'JSXFragment';
  /** Opening tag name for a `JSXElement` (e.g. "div", "Button"); `null` for
   * `JSXFragment` (shorthand fragments have no name) and for elements whose
   * tag isn't a plain identifier (e.g. `<Foo.Bar/>`, out of scope — see
   * `component-resolution.ts`). */
  tagName: string | null;
  /** Byte offsets into the ORIGINAL source, for test/debug correlation
   * only. Never used to derive the astPath itself (contract point 6). */
  start: number;
  end: number;
  astPath: string;
}

/**
 * Convenience/spec-reference entry point: parse `source` fresh and return
 * every JSXElement/JSXFragment's astPath, in encounter order. This is the
 * function golden/unit tests exercise directly (including the
 * reformat/add-comment stability test — call twice with two source variants
 * and diff the `astPath` sequence while ignoring `start`/`end`).
 *
 * The real Vite/babel-plugin transform (`babel-plugin.ts`) does NOT call
 * this — it uses `createUidPathTracker()` directly inside its own single
 * traversal pass (so attribute-injection and astPath derivation share one
 * walk, and there is exactly one code path computing astPaths, never two
 * that could drift).
 */
export function deriveUidPaths(source: string, filename = 'file.tsx'): DerivedUidPathEntry[] {
  const ast = parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    sourceFilename: filename,
  });

  const tracker = createUidPathTracker();
  const entries: DerivedUidPathEntry[] = [];

  traverse(ast, {
    JSXElement(path) {
      const astPath = tracker.pathFor(path);
      const nameNode = path.node.openingElement.name;
      const tagName = nameNode.type === 'JSXIdentifier' ? nameNode.name : null;
      entries.push({
        type: 'JSXElement',
        tagName,
        start: path.node.start ?? -1,
        end: path.node.end ?? -1,
        astPath,
      });
    },
    JSXFragment(path) {
      const astPath = tracker.pathFor(path);
      entries.push({
        type: 'JSXFragment',
        tagName: null,
        start: path.node.start ?? -1,
        end: path.node.end ?? -1,
        astPath,
      });
    },
  });

  return entries;
}
