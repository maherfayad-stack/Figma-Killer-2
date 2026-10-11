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
 *
 * ## ...unless the caller says it means to (G-6, OD-20)
 *
 * Typing into a field that shows a code-bound value is explicit intent, so
 * `unbind: true` replaces a plain VALUE expression (`title={count}`,
 * `label={t('x')}`) with the literal. The editor shows what was replaced and
 * offers Undo - the undo journal puts the bytes back. Even then, markup
 * (`icon={<svg/>}`), a function (`onClick={fn}`) and a whole array or object are
 * not values the field showed, so they still refuse (`unbindableExpression.ts`).
 */
import { Node, Project, type JsxAttribute } from 'ts-morph'
import { isLiteralJsxAttribute } from '@core/page-parser'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'
import { jsxAttributeInitializerText, jsxAttributeQuote } from './stringSpelling'
import { isUnbindableExpression } from './unbindableExpression'

export interface SetJsxPropParams {
  file: string
  line: number
  col: number
  prop: string
  value: string | number | boolean
  /** G-6 - replace a code-bound value with `value`. Without it, code is never overwritten. */
  unbind?: boolean
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

/** `title={count}` - an attribute whose code is a plain value, not markup, a function or a whole array/object. */
function isUnbindableAttribute(attribute: JsxAttribute): boolean {
  const initializer = attribute.getInitializer()
  return initializer !== undefined && Node.isJsxExpression(initializer) && isUnbindableExpression(initializer.getExpression())
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
    if (!isLiteralJsxAttribute(existingAttribute) && !(params.unbind === true && isUnbindableAttribute(existingAttribute))) {
      throw new JsxPropTargetError(
        params.unbind === true
          ? `"${prop}" holds markup, a function or a whole list or object (${existingAttribute.getInitializer()?.getText() ?? ''}), not a value a typed literal can replace. Change it in the code.`
          : `"${prop}" is set from code here (${existingAttribute.getInitializer()?.getText() ?? ''}), so a typed value would delete that binding. Edit the value it reads in the code.`,
        `${file}:${line}:${col}`,
      )
    }
    existingAttribute.setInitializer(initializerText)
  } else if (existingAttribute) {
    // `getAttribute(name)` only matches spread attributes if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real prop name — guard against silently clobbering one anyway.
    throw new JsxPropTargetError(
      `The "${prop}" attribute only comes from a spread, so there is no attribute to set. Change it in the code.`,
      `${file}:${line}:${col}`,
      'spread-attribute',
    )
  } else {
    element.addAttribute({ name: prop, initializer: initializerText })
  }

  sourceFile.saveSync()
}
