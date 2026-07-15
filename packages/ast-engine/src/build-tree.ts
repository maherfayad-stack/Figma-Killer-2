import { Node, Project, type SourceFile } from 'ts-morph';
import type { NodeUid, TreeNode, TreeNodeKind } from '@ccs/protocol';
import { deriveUidPathsForFile, type DerivedUidPathEntry } from './uid-path.js';
import { isDynamicJsxNode } from './dynamic.js';
import { resolveComponentTagName } from './component-resolution.js';
import { getJsxElementChildren } from './jsx-helpers.js';

/**
 * `buildTree(sourceText, relPath): TreeNode` — pure, zero-IO (no fs, no
 * network — same discipline as `applyOp`). Produces the FROZEN `TreeNode`
 * shape (`packages/protocol/src/tree.ts`, ADR-0009) that backs the
 * `tree-snapshot` DaemonEvent (`packages/protocol/src/events.ts`
 * `TreeSnapshotEventSchema`) consumed by the studio LayersPanel/Inspector.
 *
 * CRITICAL (ADR-0017): every `uid` this emits MUST be byte-identical to
 * what `@ccs/vite-plugin-source-uid`'s babel plugin tags in the DOM
 * (`data-uid`) and what `applyOp`'s uid resolver accepts — otherwise a node
 * clicked in the LayersPanel would not correspond to what the canvas
 * selection bridge selects, nor to a resolvable `applyOp` target. This is
 * achieved by construction, NOT by re-deriving astPaths independently:
 * `buildTree` reuses this package's EXISTING, already-conformance-tested
 * `deriveUidPathsForFile` (`uid-path.ts`) and `isDynamicJsxNode`
 * (`dynamic.ts`) — the exact same functions `applyOp`'s resolver
 * (`resolveAstPath`) and the ADR-0017 golden conformance corpus
 * (`conformance-corpus.test.ts`) already prove byte-identical to the babel
 * plugin's real output. `buildTree` adds ZERO new astPath/dynamic logic; it
 * only WALKS the already-derived entries into a nested `TreeNode` shape and
 * layers on `kind`/`component` (via the new, non-uid-affecting
 * `component-resolution.ts` port — see that file's doc for why that one
 * piece is a fresh, narrower port rather than a shared/critical dependency).
 *
 * Root selection: a `.tsx` frame file conventionally has exactly one JSX
 * root (`export default function Name() { return <JSX>; }` — see
 * `files/demo/src/frames/*.tsx`), which is `d0` (ADR-0016 point 3: "d0 is
 * typically, but not necessarily, the default export's returned JSX").
 * For the general case (a file with multiple top-level components/roots),
 * `buildTree` prefers whichever root sits lexically inside the file's
 * DEFAULT EXPORT (resolved via `getExportedDeclarations().get('default')`,
 * which already follows `export default Identifier;`/re-export forms) —
 * this is deterministic and matches how every real frame file is authored.
 * Falls back to the first-entered root in source order (`d0` by
 * definition) if there is no default export, or the default export's
 * declaration contains no JSX root.
 */

function findDefaultExportRoot(
  sourceFile: SourceFile,
  roots: readonly DerivedUidPathEntry[],
): DerivedUidPathEntry | undefined {
  let defaultExportDecls: Node[];
  try {
    defaultExportDecls = sourceFile.getExportedDeclarations().get('default') ?? [];
  } catch {
    // Defensive: a source file with unresolvable module references can
    // make ts-morph's export-resolution machinery throw; buildTree must
    // still degrade gracefully to the source-order fallback rather than
    // propagate an unrelated resolution error.
    return undefined;
  }

  for (const decl of defaultExportDecls) {
    const declStart = decl.getPos();
    const declEnd = decl.getEnd();
    const match = roots.find((r) => r.start >= declStart && r.end <= declEnd);
    if (match) return match;
  }
  return undefined;
}

function toNodeUid(uid: string): NodeUid {
  return uid as NodeUid;
}

export function buildTree(sourceText: string, relPath: string): TreeNode {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.tsx', sourceText);

  const entries = deriveUidPathsForFile(sourceFile);
  const roots = entries.filter((e) => !e.astPath.includes('.'));
  if (roots.length === 0) {
    throw new Error(
      `@ccs/ast-engine: buildTree found no JSX element/fragment in "${relPath}" — nothing to build a tree from`,
    );
  }

  const rootEntry = findDefaultExportRoot(sourceFile, roots) ?? roots[0]!;
  const entryByNode = new Map<Node, DerivedUidPathEntry>(entries.map((e) => [e.node, e] as const));

  function build(node: Node): TreeNode {
    const entry = entryByNode.get(node);
    if (!entry) {
      throw new Error('@ccs/ast-engine: buildTree internal invariant violated — node missing from entry map');
    }

    const uid = toNodeUid(`${relPath}:${entry.astPath}`);
    const dynamic = isDynamicJsxNode(node);
    const children = getJsxElementChildren(node).map(build);

    if (entry.type === 'JSXFragment') {
      const kind: TreeNodeKind = 'fragment';
      return { uid, kind, tag: null, dynamic, children };
    }

    const tag = entry.tagName;
    const resolved = tag ? resolveComponentTagName(tag, sourceFile) : null;
    if (resolved) {
      const component = resolved.fromDesignSystem ? `ds:${resolved.name}` : resolved.name;
      const kind: TreeNodeKind = 'component-instance';
      return { uid, kind, tag, dynamic, component, children };
    }

    const kind: TreeNodeKind = 'element';
    return { uid, kind, tag, dynamic, children };
  }

  return build(rootEntry.node);
}
