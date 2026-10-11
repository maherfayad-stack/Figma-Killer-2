/**
 * promoteOverrideToDefault — OD-19's "Apply to all": the value ONE instance
 * overrides (`<Card heading="New text" />`, written by `exposeLiteralAsProp`)
 * becomes the component's own default (`heading = 'New text'`) and the call
 * site stops passing it, so every instance that did not override it now shows
 * the new value and this one is no different from them.
 *
 *     <Card heading="New text" />        →   <Card />
 *     ({ heading = 'Old text' })         →   ({ heading = 'New text' })
 *
 * An instance that passes its OWN `heading` keeps it — an override is the one
 * thing "all" does not mean.
 *
 * Nothing here executes the component: it reads the call site's attribute and
 * the parameter's default as source text, both of which must be plain
 * literals, and writes two literals' worth of bytes.
 *
 * Refuses, with every file byte-identical:
 *   - `unresolvable` / `package-component` — the call site is not a local
 *     component (the same resolution detach uses);
 *   - `not-an-override` — the call site does not pass `propName` as a plain
 *     literal (nothing to promote, or a binding, which is never baked);
 *   - `no-default` — the component's parameter has no `propName = <literal>`
 *     binding to rewrite (an override Studio did not write, or one since
 *     edited by hand into an expression);
 *   - `not-in-component` — the element the caller named (whose file the
 *     dispatcher already contained) is not in the file the call site's import
 *     resolves to, so the file this would write is not the one that was vetted.
 */
import * as path from 'node:path'
import { Node, QuoteKind, type Project, type SourceFile } from 'ts-morph'
import { createWorkspaceProject } from '@core/page-parser'
import { jsStringLiteral } from './detachSource'
import { findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { resolveComponentCallSite } from './resolveComponentCallSite'
import { introducesSyntaxErrors } from './syntaxRegression'

export type PromoteOverrideRefusalReason = 'unresolvable' | 'package-component' | 'not-an-override' | 'no-default' | 'not-in-component'

export interface PromoteOverrideParams {
  /** The call site (the instance): absolute file and its tag-name `line:col`. */
  callSiteFile: string
  callSiteLine: number
  callSiteCol: number
  workspaceRoot: string
  /** The props the instance overrides — the names `exposeLiteralAsProp` gave them. */
  propNames: readonly string[]
  /**
   * The component's file as the caller decoded and contained it (the tail of
   * the edit's inlined id). The file the import graph resolves to must be
   * this one: it is the only component file whose path was vetted.
   */
  componentFile: string
  project?: Project
}

export type PromoteOverrideResult =
  | { ok: true }
  | { ok: false; refusal: { reason: PromoteOverrideRefusalReason; message: string } }

class PromoteRefusal extends Error {
  readonly reason: PromoteOverrideRefusalReason
  constructor(reason: PromoteOverrideRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

function refuse(reason: PromoteOverrideRefusalReason, message: string): never {
  throw new PromoteRefusal(reason, message)
}

/** A scalar literal as JS source, or `undefined` for anything that is not one. */
function literalSource(expr: Node | undefined): string | undefined {
  if (!expr) return undefined
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return jsStringLiteral(expr.getLiteralValue())
  if (Node.isNumericLiteral(expr) || Node.isTrueLiteral(expr) || Node.isFalseLiteral(expr)) return expr.getText()
  return undefined
}

export function promoteOverrideToDefault(params: PromoteOverrideParams): PromoteOverrideResult {
  if (params.propNames.length === 0) throw new Error('[promoteOverrideToDefault] nothing to apply.')
  const project = params.project ?? createWorkspaceProject(params.workspaceRoot)
  project.manipulationSettings.set({ quoteKind: QuoteKind.Single })
  const callFile = loadSourceFile(project, params.callSiteFile)
  const callSite = findJsxElementAtLocationOrThrow(callFile, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  const identifier = callSite.getTagNameNode().getText().split('.')[0]!

  const resolved = resolveComponentCallSite(project, callFile, params.workspaceRoot, identifier, params.callSiteFile, params.callSiteLine, params.callSiteCol)
  if (!resolved.ok) return { ok: false, refusal: { reason: resolved.failure.reason, message: resolved.failure.message } }
  const { fn, target } = resolved.result
  const componentFile: SourceFile = target.sourceFile
  const originals = new Map([[componentFile, componentFile.getFullText()], [callFile, callFile.getFullText()]])

  try {
    if (path.relative(componentFile.getFilePath(), params.componentFile) !== '') {
      refuse('not-in-component', `That element is not part of <${identifier}>'s own markup. Select an element inside it.`)
    }

    // One splice per file, last position first; the call site and the
    // component may be the same file, in either order.
    const edits = new Map<SourceFile, { pos: number; remove: number; text: string }[]>()
    const push = (file: SourceFile, edit: { pos: number; remove: number; text: string }) => edits.set(file, [...(edits.get(file) ?? []), edit])
    const pattern = fn.getParameters()[0]?.getNameNode()

    for (const propName of new Set(params.propNames)) {
      const attribute = callSite.getAttributes().find((attr) => Node.isJsxAttribute(attr) && attr.getNameNode().getText() === propName)
      const initializer = attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined
      const value = initializer && Node.isJsxExpression(initializer) ? literalSource(initializer.getExpression()) : literalSource(initializer)
      // A JSX attribute string decodes entities and a JS string does not, so an entity would mean something else once it is a default.
      const entity = initializer !== undefined && Node.isStringLiteral(initializer) && initializer.getLiteralText().includes('&')
      if (!attribute || value === undefined || entity) {
        refuse('not-an-override', `This <${identifier}> does not pass \`${propName}\` as a plain value, so there is nothing to apply to the others. Override the value on this instance first.`)
      }

      const binding = pattern && Node.isObjectBindingPattern(pattern)
        ? pattern.getElements().find((element) => !element.getDotDotDotToken() && (element.getPropertyNameNode() ?? element.getNameNode()).getText() === propName)
        : undefined
      const defaultNode = binding?.getInitializer()
      if (!defaultNode || literalSource(defaultNode) === undefined) {
        refuse('no-default', `${identifier} has no plain default for \`${propName}\` to replace. Add a default in the code.`)
      }

      push(componentFile, { pos: defaultNode.getStart(), remove: defaultNode.getEnd() - defaultNode.getStart(), text: value })
      // The attribute and the whitespace in front of it go together, so `<Card a="1" b="2" />` loses `b` cleanly.
      push(callFile, { pos: attribute.getPos(), remove: attribute.getEnd() - attribute.getPos(), text: '' })
    }
    for (const [file, fileEdits] of edits) {
      let out = file.getFullText()
      for (const edit of [...fileEdits].sort((x, y) => y.pos - x.pos)) out = out.slice(0, edit.pos) + edit.text + out.slice(edit.pos + edit.remove)
      file.replaceWithText(out)
    }

    for (const [file, original] of originals) {
      if (introducesSyntaxErrors(file.getFilePath(), original, file.getFullText())) {
        throw new Error(`[promoteOverrideToDefault] ${path.basename(file.getFilePath())} would not parse after applying \`${params.propNames.join('`, `')}\` to all — nothing was written.`)
      }
    }
    for (const file of originals.keys()) if (file.getFullText() !== originals.get(file)) file.saveSync()
    return { ok: true }
  } catch (err) {
    for (const [file, original] of originals) if (file.getFullText() !== original) file.replaceWithText(original)
    if (err instanceof PromoteRefusal) return { ok: false, refusal: { reason: err.reason, message: err.message } }
    throw err
  }
}
