/**
 * detachClassNameFold — DET-6: a detached `className` whose value is fully
 * known once the call site's values are in is written as the string it
 * computes, not as the join that computes it.
 *
 * `className={cn(styles.card, className)}` is never folded — `styles.card` is
 * a binding, and writing what it resolves to would delete it (invariant 5).
 * What IS folded is exactly two shapes, and only when EVERY part is a literal
 * after substitution:
 *
 *   - a template literal: `` `card card--${tone}` `` with `tone="warm"` →
 *     `className="card card--warm"` — JavaScript's own template semantics;
 *   - `clsx(…)` / `classnames(…)` imported from the `clsx` or `classnames`
 *     package: string parts joined with one space, `undefined`/`null`/`false`
 *     dropped — the documented semantics of both libraries.
 *
 * `cn` is NOT folded, whatever it is called. shadcn's `cn` is
 * `twMerge(clsx(…))`, and tailwind-merge drops a conflicting utility
 * (`cn('p-2', 'p-4')` is `'p-4'`), so the plain join could write a class list
 * the app never renders. A project-local join function is not folded for the
 * same reason: its body decides, and nothing here runs it.
 *
 * Pure: the caller supplies how each part reads after substitution.
 */
import { Node } from 'ts-morph'
import type { Value } from './detachSource'

/** The class-join packages whose call is a plain space join — see this module's doc. */
const PLAIN_JOIN_PACKAGES: ReadonlySet<string> = new Set(['clsx', 'clsx/lite', 'classnames'])

/**
 * What one part reads as once substituted: a string, `null` for a value a
 * class join drops (`undefined`, `null`, `false`), or `undefined` when it is
 * not a literal at all (then nothing folds).
 */
export type FoldPart = (part: Node) => string | null | undefined

function isPlainJoinCallee(callee: Node): boolean {
  if (!Node.isIdentifier(callee)) return false
  const decl = callee.getSymbol()?.getDeclarations()[0]
  if (!decl || !(Node.isImportSpecifier(decl) || Node.isImportClause(decl))) return false
  const importDecl = decl.getFirstAncestor((ancestor) => Node.isImportDeclaration(ancestor))
  return importDecl !== undefined && Node.isImportDeclaration(importDecl) && PLAIN_JOIN_PACKAGES.has(importDecl.getModuleSpecifierValue())
}

/**
 * One part as it reads after substitution: a literal of the component's own
 * source, or a substituted value (`siteValue`, read only when the part is not
 * a literal) that is a string or absent and reads no name.
 */
export function readFoldPart(part: Node, siteValue: () => Value | undefined): string | null | undefined {
  if (Node.isStringLiteral(part) || Node.isNoSubstitutionTemplateLiteral(part)) return part.getLiteralValue()
  if (Node.isFalseLiteral(part) || Node.isNullLiteral(part)) return null
  const value = siteValue()
  if (!value || value.free.size > 0) return undefined
  if (value.isUndefined) return null
  if (value.jsString !== undefined) return value.jsString
  return value.jsxString && !value.jsxString.raw.includes('&') ? value.jsxString.raw : undefined
}

/**
 * The string `expr` computes, or `undefined` when it is not one of the two
 * folded shapes or any part is not a literal after substitution.
 */
export function foldClassName(expr: Node, read: FoldPart): string | undefined {
  if (Node.isTemplateExpression(expr)) {
    let out = expr.getHead().getLiteralText()
    for (const span of expr.getTemplateSpans()) {
      const value = read(span.getExpression())
      // `${undefined}` is the text "undefined": only a string folds here.
      if (typeof value !== 'string') return undefined
      out += value + span.getLiteral().getLiteralText()
    }
    return out
  }
  if (Node.isCallExpression(expr) && isPlainJoinCallee(expr.getExpression())) {
    const parts: string[] = []
    for (const arg of expr.getArguments()) {
      const value = read(arg)
      if (value === undefined) return undefined
      if (value) parts.push(value)
    }
    return parts.join(' ')
  }
  return undefined
}
