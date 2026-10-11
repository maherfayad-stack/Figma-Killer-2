/**
 * variantCallSites — which call sites of a component PASS a given value for a
 * given prop, and which other places spell the type that defines it.
 *
 * Remove variant is refused only when a call site uses the value, and the
 * refusal lists them. "Uses" is deliberately literal-minded: the attribute is
 * written as `prop="ghost"` or `prop={…}` with the string `'ghost'` somewhere
 * inside the expression (`prop={on ? 'ghost' : 'solid'}` passes it). A value
 * that arrives through a variable (`prop={tone}`) or a spread cannot be read
 * without evaluating, so it is not counted; the TypeScript compiler will flag
 * any such site that really passes the removed value.
 *
 * Parse, never execute: both questions are answered from syntax.
 */
import { Node, SyntaxKind, type Project } from 'ts-morph'
import type { ComponentCallSite } from './componentCallSites'

export interface VariantUse {
  /** Workspace-relative POSIX path. */
  file: string
  line: number
  col: number
}

function toPosix(path: string): string {
  return path.split(String.fromCharCode(92)).join('/')
}

function stringValueOf(node: Node): string | undefined {
  return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) ? node.getLiteralText() : undefined
}

/** The call sites among `sites` whose `prop` attribute passes `member` as a string literal. */
export function callSitesPassingVariant(
  project: Project,
  workspaceRoot: string,
  sites: readonly ComponentCallSite[],
  prop: string,
  member: string,
): VariantUse[] {
  const uses: VariantUse[] = []
  for (const site of sites) {
    const sourceFile = project.getSourceFile(`${toPosix(workspaceRoot).replace(/\/+$/, '')}/${site.file}`)
    if (!sourceFile) continue
    const offset = sourceFile.compilerNode.getPositionOfLineAndCharacter(site.line - 1, site.col - 1)
    const tag = sourceFile.getDescendantAtPos(offset)
    const opening = tag?.getFirstAncestor((ancestor) => Node.isJsxOpeningElement(ancestor) || Node.isJsxSelfClosingElement(ancestor))
    if (!opening || !(Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening))) continue
    const attribute = opening.getAttributes().find((candidate) => Node.isJsxAttribute(candidate) && candidate.getNameNode().getText() === prop)
    if (!attribute || !Node.isJsxAttribute(attribute)) continue
    const initializer = attribute.getInitializer()
    if (!initializer) continue
    const passes = stringValueOf(initializer) === member || initializer.getDescendants().some((descendant) => stringValueOf(descendant) === member)
    if (passes) uses.push({ file: site.file, line: site.line, col: site.col })
  }
  return uses
}

/**
 * Files OUTSIDE `ownFiles` that name the type alias `aliasName`, one entry per
 * type reference. A union shared with another component's file is several
 * targets, and Add/Remove variant writes exactly one; a lookup object typed
 * `Record<Alias, string>` beside the component is the same target and is not
 * counted.
 */
export function typeAliasReferences(project: Project, workspaceRoot: string, aliasName: string, ownFiles: ReadonlySet<string>): VariantUse[] {
  const root = toPosix(workspaceRoot).replace(/\/+$/, '')
  const references: VariantUse[] = []
  for (const sourceFile of project.getSourceFiles()) {
    const path = toPosix(sourceFile.getFilePath())
    if (!path.startsWith(`${root}/`) || path.includes('/node_modules/')) continue
    const rel = path.slice(root.length + 1)
    if (ownFiles.has(rel)) continue
    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      if (reference.getTypeName().getText() !== aliasName) continue
      const { line, column } = sourceFile.getLineAndColumnAtPos(reference.getStart())
      references.push({ file: rel, line, col: column })
    }
  }
  return references
}
