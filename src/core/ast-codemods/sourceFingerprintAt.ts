/**
 * What is written at a `line:col` NOW, as a fingerprint — the writeback
 * guard's half of P1-A's identity check (`@core/page-parser`'s
 * `sourceFingerprint.ts` is the parser's half, and the only place a
 * fingerprint is computed, so the two cannot disagree about the same bytes).
 *
 * A location is one of the two things a studio edit can name:
 *
 *   - a JSX element, by its tag-name position (`locateJsxElement.ts`'s
 *     convention — every structural and JSX value kind);
 *   - a literal token (`literal` edits aim at a dictionary string, `asset`
 *     edits at an import's module specifier).
 *
 * `undefined` means nothing either kind of edit could land on sits there any
 * more — which the guard reads exactly like a different element: the file is
 * not the one the board read.
 */
import { Node, type SourceFile } from 'ts-morph'
import { jsxElementFingerprint, literalFingerprint } from '@core/page-parser'
import { findJsxElementAtLocation } from './locateJsxElement'

export function readSourceFingerprintAt(sourceFile: SourceFile, line: number, col: number): string | undefined {
  const element = findJsxElementAtLocation(sourceFile, line, col)
  if (element) {
    const whole = Node.isJsxOpeningElement(element) ? element.getParent() : element
    return Node.isJsxElement(whole) || Node.isJsxSelfClosingElement(whole) ? jsxElementFingerprint(whole) : undefined
  }
  // `findJsxElementAtLocation` already bounds-checked nothing for us on the
  // miss path, so do it here: a position past the end is "nothing there".
  const lineStarts = sourceFile.compilerNode.getLineStarts()
  if (line < 1 || line > lineStarts.length || col < 1) return undefined
  const pos = lineStarts[line - 1]! + col - 1
  if (pos >= sourceFile.getEnd()) return undefined
  const token = sourceFile.getDescendantAtPos(pos)
  if (!token || token.getStart() !== pos) return undefined
  const isLiteral =
    Node.isStringLiteral(token) || Node.isNoSubstitutionTemplateLiteral(token) || Node.isNumericLiteral(token)
  return isLiteral ? literalFingerprint(token) : undefined
}
