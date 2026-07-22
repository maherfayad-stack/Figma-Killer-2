/**
 * Reads the literal-valued attributes (string / number / boolean literals
 * only) of the JSX element found at a source location. Attributes with
 * complex expressions (identifiers, calls, template strings, objects, etc.)
 * are skipped rather than guessed at.
 *
 * See `locateJsxElement.ts` for the (line, col) → node resolution algorithm.
 */
import { Node } from 'ts-morph'
import { createProject, findJsxElementAtLocationOrThrow, loadSourceFile } from './locateJsxElement'

export interface ReadJsxPropsParams {
  file: string
  line: number
  col: number
}

export type JsxLiteralProps = Record<string, string | number | boolean>

export function readJsxProps(params: ReadJsxPropsParams): JsxLiteralProps {
  const { file, line, col } = params
  const project = createProject()
  const sourceFile = loadSourceFile(project, file)
  const element = findJsxElementAtLocationOrThrow(sourceFile, file, line, col)

  const result: JsxLiteralProps = {}

  for (const attribute of element.getAttributes()) {
    if (!Node.isJsxAttribute(attribute)) continue // skip {...spread} attributes

    const name = attribute.getNameNode().getText()
    const initializer = attribute.getInitializer()

    if (initializer === undefined) {
      // Valueless shorthand (`<Foo disabled />`) is JSX sugar for `true`.
      result[name] = true
      continue
    }

    if (Node.isStringLiteral(initializer)) {
      result[name] = initializer.getLiteralValue()
      continue
    }

    if (Node.isJsxExpression(initializer)) {
      const expression = initializer.getExpression()
      if (expression === undefined) continue

      if (Node.isNumericLiteral(expression)) {
        result[name] = expression.getLiteralValue()
      } else if (Node.isStringLiteral(expression)) {
        result[name] = expression.getLiteralValue()
      } else if (Node.isTrueLiteral(expression)) {
        result[name] = true
      } else if (Node.isFalseLiteral(expression)) {
        result[name] = false
      }
      // Any other expression kind (identifier, call, template, object, …)
      // is not a literal — intentionally skipped.
      continue
    }

    // JsxElement / JsxFragment / JsxSelfClosingElement initializers are not
    // literal values — skip.
  }

  return result
}
