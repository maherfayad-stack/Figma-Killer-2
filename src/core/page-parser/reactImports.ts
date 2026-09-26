/**
 * reactImports — "does this name refer to one of React's OWN exports?"
 *
 * Three ordinary spellings in a React repo are only special because React
 * gives them a meaning: `memo(X)` / `forwardRef(fn)` (a component whose render
 * IS `X`'s / `fn`'s, P3-B WB-4) and `<Fragment>` / `<React.Fragment>` (zero
 * DOM, WB-26). A user-defined `memo` or `Fragment` means whatever its own
 * source says, so the parser treats a name as React's only when the file
 * IMPORTS it from `'react'`:
 *
 * | Spelling | Import it needs |
 * |---|---|
 * | `memo(…)`, `<Fragment>` | `import { memo } from 'react'` (an alias counts: `import { memo as m }` makes `m(…)` React's `memo`) |
 * | `React.memo(…)`, `<React.Fragment>` | `import React from 'react'` or `import * as React from 'react'`, under any local name |
 *
 * A file that reaches React some other way — a global `React` with no import, a
 * re-exporting local module — is not recognised, and the shape falls back to
 * whatever the parser does for an unknown call or component. Declining is the
 * honest failure: it renders less, it never renders something else.
 *
 * Pure AST reads; nothing is resolved through the type checker, so this costs
 * one pass over the file's import declarations.
 */
import { Node } from 'ts-morph'

const REACT_SPECIFIER = 'react'

/**
 * The name of the React export `expr` refers to (`'memo'`, `'forwardRef'`,
 * `'Fragment'`, …), or `undefined` when it does not provably refer to one.
 * `expr` is an identifier or a one-level property access — a callee
 * (`React.memo`) or a JSX tag name (`React.Fragment`) alike.
 */
export function reactExportNameOf(expr: Node): string | undefined {
  if (Node.isIdentifier(expr)) return namedReactImport(expr)
  if (Node.isPropertyAccessExpression(expr)) {
    const receiver = expr.getExpression()
    if (!Node.isIdentifier(receiver) || !isReactNamespaceBinding(receiver)) return undefined
    return expr.getName()
  }
  return undefined
}

/**
 * WB-26 — whether a JSX tag name is React's own `Fragment` (`<Fragment>`,
 * `<React.Fragment>`, or an alias of either).
 *
 * A cheap text gate first: an HTML tag, or a member tag not ending in
 * `.Fragment`, never pays for the import scan. A bare capitalized name still
 * does, because `import { Fragment as F }` makes `<F>` React's Fragment.
 */
export function isReactFragmentTag(tagNameNode: Node): boolean {
  const text = tagNameNode.getText()
  if (!/^[A-Z]/.test(text)) return false
  if (text.includes('.') && !text.endsWith('.Fragment')) return false
  return reactExportNameOf(tagNameNode) === 'Fragment'
}

/** `memo` in `import { memo } from 'react'` → `'memo'`; `m` in `import { memo as m } …` → `'memo'`. */
function namedReactImport(identifier: Node): string | undefined {
  const localName = identifier.getText()
  for (const declaration of identifier.getSourceFile().getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== REACT_SPECIFIER) continue
    if (declaration.isTypeOnly()) continue
    for (const named of declaration.getNamedImports()) {
      if (named.isTypeOnly()) continue
      const bound = named.getAliasNode()?.getText() ?? named.getNameNode().getText()
      if (bound === localName) return named.getNameNode().getText()
    }
  }
  return undefined
}

/** True when `identifier` is the default or namespace binding of an `import … from 'react'`. */
function isReactNamespaceBinding(identifier: Node): boolean {
  const localName = identifier.getText()
  for (const declaration of identifier.getSourceFile().getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== REACT_SPECIFIER) continue
    if (declaration.isTypeOnly()) continue
    if (declaration.getDefaultImport()?.getText() === localName) return true
    if (declaration.getNamespaceImport()?.getText() === localName) return true
  }
  return false
}
