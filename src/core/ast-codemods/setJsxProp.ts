/**
 * Sets (or replaces) one JSX attribute's literal value on the element found
 * at a source location, then writes the change back to disk.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 *
 * ## It never overwrites a binding (WB-11)
 *
 * Only a LITERAL initializer is replaced: `title="x"`, `title={'x'}`,
 * `` title={`x`} ``, `size={3}`, `size={-3}`, `open={true}`, or the bare
 * `open` shorthand. Anything else — `title={c.sheetTitle}`, `onClick={fn}`,
 * `items={[…]}` — is an expression, and baking a literal over it deletes the
 * binding from the user's source (Invariant 5). The client's `codeProps` guard
 * already declines to send such an edit, but the server is the boundary every
 * writer crosses (the editor, a plugin, the agent's `studio_apply_edits`), so
 * the codemod refuses by name — `JsxPropTargetError`, reason
 * `binding-overwrite` — rather than trusting that no caller ever asks.
 */
import { Node, Project } from 'ts-morph'
import { isLiteralJsxAttribute } from '@core/page-parser'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { jsxAttributeInitializerText, jsxAttributeQuote } from './stringSpelling'

export interface SetJsxPropParams {
  file: string
  line: number
  col: number
  prop: string
  value: string | number | boolean
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Builds the attribute initializer text ts-morph expects (quotes/braces
 * included).
 *
 * Unlike ordinary JS string literals, a plain JSX attribute string
 * (`prop="..."`) does NOT treat `\` as an escape character — `\"` does not
 * embed a quote, it ends the string early and produces a syntax error. So
 * embedded quotes are handled by picking whichever delimiter the value
 * doesn't contain; if the value contains *both* quote characters, fall back
 * to an expression container (`prop={"..."}`), where the initializer is an
 * ordinary JS string literal and backslash-escaping works as usual.
 */
/**
 * Thrown when the attribute exists but holds something a literal write would
 * destroy (see this module's doc). `reason` is the stable refusal code the
 * writeback batch reports; `path` is `<file>:<line>:<col>` of the element.
 */
export class JsxPropTargetError extends Error {
  readonly path: string
  /**
   * `binding-overwrite` — the attribute holds code a literal would delete;
   * `spread-attribute` — the name only exists inside a `{...spread}`.
   */
  readonly reason: 'binding-overwrite' | 'spread-attribute'

  constructor(message: string, path: string, reason: 'binding-overwrite' | 'spread-attribute' = 'binding-overwrite') {
    super(message)
    this.name = 'JsxPropTargetError'
    this.path = path
    this.reason = reason
  }
}

export function setJsxProp(params: SetJsxPropParams): void {
  const { file, line, col, prop, value } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  const existingAttribute = element.getAttribute(prop)
  const initializerText = jsxAttributeInitializerText(
    value,
    jsxAttributeQuote(existingAttribute && Node.isJsxAttribute(existingAttribute) ? existingAttribute : undefined),
  )

  if (existingAttribute && Node.isJsxAttribute(existingAttribute)) {
    if (!isLiteralJsxAttribute(existingAttribute)) {
      throw new JsxPropTargetError(
        `"${prop}" is set from code here (${existingAttribute.getInitializer()?.getText() ?? ''}), not a literal, so writing a value would replace that code and delete the binding. Change it in the code, or edit the value it reads.`,
        `${file}:${line}:${col}`,
      )
    }
    existingAttribute.setInitializer(initializerText)
  } else if (existingAttribute) {
    // `getAttribute(name)` only matches spread attributes if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real prop name — guard against silently clobbering one anyway.
    throw new JsxPropTargetError(
      `Attribute "${prop}" on the element at ${file}:${line}:${col} is a spread attribute and cannot be set as a literal prop.`,
      `${file}:${line}:${col}`,
      'spread-attribute',
    )
  } else {
    element.addAttribute({ name: prop, initializer: initializerText })
  }

  sourceFile.saveSync()
}
