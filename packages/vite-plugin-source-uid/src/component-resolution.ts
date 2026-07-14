import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

/**
 * `data-component` resolution — playbook §1/ADR-0016: "`data-component`
 * when the JSX tag resolves to an imported component; prefix `ds:` when
 * the import source resolves into `design-system`."
 *
 * Only plain-identifier tags starting with an uppercase letter (the JSX
 * convention distinguishing component references from host elements) are
 * considered. Only tags whose Babel scope binding resolves to an
 * `ImportDeclaration` count — a same-file local component (never imported)
 * deliberately gets no `data-component`, matching "resolves to an IMPORTED
 * component" in the spec. `<Foo.Bar/>` (`JSXMemberExpression` tags) are out
 * of scope (rare in this codebase's convention) and resolve to `null`.
 *
 * The real Almosafer DS package (ADR-0006) is published/imported as
 * `"design-system"` (see `design-system/package.json` `name` field and its
 * `templates/design-system` mirror) — matched here, plus any deep import
 * path under it (`design-system/...`), as "resolves into design-system".
 */

const DESIGN_SYSTEM_SOURCE_RE = /^design-system(\/.*)?$/;

export interface ResolvedComponentTag {
  /** The JSX tag name as written at the call site (e.g. "Button") — NOT
   * necessarily the export's original name if the import aliased it
   * (`import { Button as DsButton } from ...` -> tag name is "DsButton").
   * The tag name as used in code is what should be visible on the canvas. */
  name: string;
  fromDesignSystem: boolean;
}

export function resolveComponentTag(
  openingElementPath: NodePath<t.JSXOpeningElement>,
): ResolvedComponentTag | null {
  const nameNode = openingElementPath.node.name;
  if (nameNode.type !== 'JSXIdentifier') return null;

  const tagName = nameNode.name;
  if (!/^[A-Z]/.test(tagName)) return null;

  const binding = openingElementPath.scope.getBinding(tagName);
  if (!binding || binding.kind !== 'module') return null;

  const importDeclPath = binding.path.parentPath;
  if (!importDeclPath || !importDeclPath.isImportDeclaration()) return null;

  const source = importDeclPath.node.source.value;
  return { name: tagName, fromDesignSystem: DESIGN_SYSTEM_SOURCE_RE.test(source) };
}
