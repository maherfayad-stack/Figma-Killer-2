/**
 * ADR-0017/ADR-0018's golden CONFORMANCE CORPUS — WS-A's FIRST task (per
 * ADR-0018 item 3): prove the ts-morph uid resolver (`uid-path.ts`,
 * `dynamic.ts`) produces BYTE-IDENTICAL astPaths (and identical
 * dynamic-lock decisions) to the REAL `@ccs/vite-plugin-source-uid` babel
 * plugin, on a shared set of fixtures (incl. Arabic/RTL + dynamic cases).
 *
 * Method: run each fixture through the ACTUAL babel transform
 * (`transformSourceUid`, imported — not reimplemented — from the frozen P2
 * package) to get real `data-uid`/`data-dynamic` attributes baked into the
 * transformed source as literal JSX attributes. Parse that transformed
 * output with ts-morph and read the attributes back off in document order
 * — this is the babel plugin's actual, executed output, not a
 * reimplementation of its internals. Separately, run OUR ts-morph resolver
 * + dynamic detector directly against the ORIGINAL (untransformed) source.
 * Compare the two ordered sequences (JSXElement-only — JSXFragment nodes
 * never carry a `data-uid` DOM attribute in EITHER implementation, contract
 * point 8, so they're not part of either sequence, though they still
 * silently consume numbering slots identically in both trackers).
 *
 * If the ts-morph port ever diverges from the babel plugin's real behavior
 * — an off-by-one in sibling counting, a missed dynamic-lock case, a
 * different self-closing-vs-element node-kind assumption — this test fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { transformSourceUid } from '@ccs/vite-plugin-source-uid';
import { deriveUidPathsForFile } from './uid-path.js';
import { isDynamicJsxNode } from './dynamic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__', 'conformance');

interface BabelExtractedEntry {
  uid: string;
  dynamic: boolean;
}

/** Parse the babel-transformed code (real `data-uid`/`data-dynamic`
 * attributes already baked in as JSX attribute literals) and read them
 * back off in document order, JSXElement-only. */
function extractBabelTaggedEntries(transformedCode: string): BabelExtractedEntry[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('babel-output.tsx', transformedCode);
  const entries: BabelExtractedEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    const kind = node.getKind();
    if (kind !== SyntaxKind.JsxElement && kind !== SyntaxKind.JsxSelfClosingElement) return;

    const openingElement =
      kind === SyntaxKind.JsxSelfClosingElement
        ? node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement)
        : node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement();

    let uid: string | undefined;
    let dynamic = false;
    for (const attr of openingElement.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const name = attr.getNameNode().getText();
      if (name === 'data-uid') {
        const init = attr.getInitializer();
        if (init && Node.isStringLiteral(init)) uid = init.getLiteralText();
      }
      if (name === 'data-dynamic') dynamic = true;
    }

    if (uid === undefined) {
      throw new Error('conformance corpus: babel-transformed element missing data-uid');
    }
    entries.push({ uid, dynamic });
  });

  return entries;
}

interface AstEngineEntry {
  astPath: string;
  dynamic: boolean;
}

function extractAstEngineEntries(source: string): AstEngineEntry[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('original.tsx', source);

  return deriveUidPathsForFile(sourceFile)
    .filter((entry) => entry.type === 'JSXElement')
    .map((entry) => ({
      astPath: entry.astPath,
      dynamic: isDynamicJsxNode(entry.node),
    }));
}

function listFixtures(): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.tsx'))
    .sort();
}

describe('ast-engine ts-morph resolver conforms to the babel plugin (ADR-0017/0018)', () => {
  const fixtures = listFixtures();

  it('has fixtures to check', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixtureName of fixtures) {
    it(`byte-identical astPath + dynamic-lock sequence: ${fixtureName}`, () => {
      const source = readFileSync(join(fixturesDir, fixtureName), 'utf8');
      const relPath = `src/${fixtureName}`;

      const { code: transformedCode } = transformSourceUid(source, { relPath });
      const babelEntries = extractBabelTaggedEntries(transformedCode).map((e) => ({
        // strip the `<relPath>:` prefix baked into the real data-uid value
        // so we compare bare astPath tokens against our resolver's output.
        astPath: e.uid.slice(relPath.length + 1),
        dynamic: e.dynamic,
      }));

      const astEngineEntries = extractAstEngineEntries(source);

      expect(astEngineEntries).toEqual(babelEntries);
    });
  }
});
