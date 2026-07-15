import type { SourceFile } from 'ts-morph';

/**
 * `data-component` resolution — the ts-morph PORT of
 * `packages/vite-plugin-source-uid/src/component-resolution.ts`'s
 * `resolveComponentTag`, for `buildTree`'s `TreeNode.kind`/`.component`
 * fields (`packages/protocol/src/tree.ts`). Same semantic contract as the
 * babel original: a JSX tag resolves to a "component instance" when its
 * name is an uppercase identifier bound by an `ImportDeclaration`; the
 * `ds:` prefix is added when that import's module specifier resolves into
 * the `design-system` package (ADR-0006/ADR-0016).
 *
 * DELIBERATE SIMPLIFICATION vs the babel port: babel's version walks a full
 * scope-binding chain (`path.scope.getBinding`) to find where an identifier
 * is declared, which correctly handles local shadowing. ts-morph's
 * equivalent requires the TypeScript type-checker's symbol resolution,
 * meaningfully heavier for what this is used for. Since frame components in
 * this codebase's convention never locally shadow an imported component name
 * (and this result feeds ONLY the LayersPanel's display — it is NOT part of
 * the uid-derivation critical path ADR-0017 guards), a direct lookup against
 * the file's own top-level `ImportDeclaration`s is sufficient: does any
 * import introduce a local binding with this exact name? This is NOT a
 * shared/reused module with the babel version (ADR-0017's "corpus, not
 * shared code" precedent applies equally here) — it is a fresh, narrower
 * port of the same semantic rule.
 */

const DESIGN_SYSTEM_SOURCE_RE = /^design-system(\/.*)?$/;

export interface ResolvedComponentTag {
  /** The JSX tag name as written at the call site — see the babel port's
   * doc for why this (not the export's original name) is what should be
   * visible on the canvas. */
  name: string;
  fromDesignSystem: boolean;
}

/**
 * Resolve a JSX tag name (e.g. "Button") against `sourceFile`'s import
 * declarations. Returns `null` for lowercase tags (host elements, e.g.
 * "div") and for uppercase tags with no matching import (locally-declared
 * components deliberately get no `data-component`, matching the babel
 * port's "resolves to an IMPORTED component" rule).
 */
export function resolveComponentTagName(
  tagName: string,
  sourceFile: SourceFile,
): ResolvedComponentTag | null {
  if (!/^[A-Z]/.test(tagName)) return null;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport && defaultImport.getText() === tagName) {
      return {
        name: tagName,
        fromDesignSystem: DESIGN_SYSTEM_SOURCE_RE.test(importDecl.getModuleSpecifierValue()),
      };
    }

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport && namespaceImport.getText() === tagName) {
      return {
        name: tagName,
        fromDesignSystem: DESIGN_SYSTEM_SOURCE_RE.test(importDecl.getModuleSpecifierValue()),
      };
    }

    for (const namedImport of importDecl.getNamedImports()) {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      if (localName === tagName) {
        return {
          name: tagName,
          fromDesignSystem: DESIGN_SYSTEM_SOURCE_RE.test(importDecl.getModuleSpecifierValue()),
        };
      }
    }
  }

  return null;
}
