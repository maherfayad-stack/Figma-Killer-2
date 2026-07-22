/**
 * Sets or merges a `style={{ ... }}` object-literal attribute on the JSX
 * element found at a source location, then writes the change back to disk.
 *
 * FAILS CLOSED when the existing `style` attribute isn't a plain object
 * literal (an identifier, spread, call expression, or a literal containing a
 * spread element) — mirrors `setJsxProp`'s spread-attribute guard: rather
 * than guess at merge semantics for an expression it can't fully account for,
 * it refuses to touch it.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node, Project } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

export interface SetJsxStyleParams {
  file: string
  line: number
  col: number
  /** camelCase CSS property names → values (values may be `var(--token)` strings). */
  style: Record<string, string | number>
  /** Optional pre-existing project to reuse (e.g. across multiple edits). */
  project?: Project
}

/**
 * Thrown when `setJsxStyle`'s target `style` attribute can't be safely
 * written or merged into — a non-object initializer (identifier, spread,
 * call expression) or an object literal containing a spread element.
 * `path` is `<file>:<line>:<col>` of the target element.
 */
export class JsxStyleTargetError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(`[ast-codemods/setJsxStyle] ${path}: ${message}`)
    this.name = 'JsxStyleTargetError'
    this.path = path
  }
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Quote a property key only when it isn't a valid bare identifier. */
function buildPropertyName(key: string): string {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)
}

/** Numbers serialize as-is; strings as double-quoted JS string literals. */
function buildPropertyValueText(value: string | number): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value)
}

/** Builds a full `style={{ ... }}` attribute initializer (braces included). */
function buildStyleInitializerText(style: Record<string, string | number>): string {
  const entries = Object.entries(style).map(
    ([key, value]) => `${buildPropertyName(key)}: ${buildPropertyValueText(value)}`,
  )
  return `{{ ${entries.join(', ')} }}`
}

export function setJsxStyle(params: SetJsxStyleParams): void {
  const { file, line, col, style } = params
  const project = params.project ?? createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)
  const path = `${file}:${line}:${col}`

  const existingAttribute = element.getAttribute('style')

  if (!existingAttribute) {
    element.addAttribute({ name: 'style', initializer: buildStyleInitializerText(style) })
    sourceFile.saveSync()
    return
  }

  if (!Node.isJsxAttribute(existingAttribute)) {
    // `getAttribute(name)` only matches spread attributes if `name` happens to
    // equal the literal text "...expr", which should never occur for a real
    // attribute name — guard against silently clobbering one anyway.
    throw new JsxStyleTargetError(
      'the "style" attribute is a spread attribute — cannot merge a literal style object into it',
      path,
    )
  }

  const initializer = existingAttribute.getInitializer()
  const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined

  if (expression === undefined) {
    // Covers a valueless shorthand (`<Foo style />`) and a raw string literal
    // (`style="color:red"`, invalid at runtime but syntactically legal) — neither
    // is an object-literal expression this codemod can merge into.
    throw new JsxStyleTargetError(
      'the "style" attribute has no object-literal expression to merge into',
      path,
    )
  }

  if (!Node.isObjectLiteralExpression(expression)) {
    throw new JsxStyleTargetError(
      'the "style" attribute is not a plain object literal (identifier, spread, or call expression) — refusing to overwrite it',
      path,
    )
  }

  if (expression.getProperties().some((prop) => Node.isSpreadAssignment(prop))) {
    throw new JsxStyleTargetError(
      'the "style" object literal contains a spread element — cannot safely merge without knowing what it contributes',
      path,
    )
  }

  for (const [key, value] of Object.entries(style)) {
    const valueText = buildPropertyValueText(value)
    const existingProp = expression.getProperty(key)
    if (existingProp === undefined) {
      expression.addPropertyAssignment({ name: buildPropertyName(key), initializer: valueText })
    } else if (Node.isPropertyAssignment(existingProp)) {
      existingProp.setInitializer(valueText)
    } else {
      // Shorthand property (`{ color }`) or anything else non-literal —
      // fail closed rather than guess at what overwriting it should mean.
      throw new JsxStyleTargetError(
        `style key "${key}" is not a plain "key: value" property — refusing to overwrite it`,
        path,
      )
    }
  }

  sourceFile.saveSync()
}
