/**
 * Sets (or replaces) one JSX attribute's literal value on the element found
 * at a source location, then writes the change back to disk.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node, Project } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

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
function buildInitializerText(value: string | number | boolean): string {
  if (typeof value === 'string') {
    const hasDouble = value.includes('"')
    const hasSingle = value.includes("'")
    if (!hasDouble) return `"${value}"`
    if (!hasSingle) return `'${value}'`
    return `{${JSON.stringify(value)}}`
  }
  return `{${value}}`
}

export function setJsxProp(params: SetJsxPropParams): void {
  const { file, line, col, prop, value } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  const initializerText = buildInitializerText(value)
  const existingAttribute = element.getAttribute(prop)

  if (existingAttribute && Node.isJsxAttribute(existingAttribute)) {
    existingAttribute.setInitializer(initializerText)
  } else if (existingAttribute) {
    // `getAttribute(name)` only matches spread attributes if `name` happens
    // to equal the literal text "...expr", which should never occur for a
    // real prop name — guard against silently clobbering one anyway.
    throw new Error(
      `Attribute "${prop}" on the element at ${file}:${line}:${col} is a spread attribute and cannot be set as a literal prop.`,
    )
  } else {
    element.addAttribute({ name: prop, initializer: initializerText })
  }

  sourceFile.saveSync()
}
