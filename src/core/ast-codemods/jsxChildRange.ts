/**
 * The text range a JSX child element occupies, and the one question the
 * structural codemods (`moveJsxElement`, `deleteJsxElement`) both have to
 * answer first: is the element at this location an ordinary child of an
 * ordinary JSX parent, and which bytes are exclusively its own?
 *
 * WHY A TEXT RANGE, NOT AN AST REWRITE
 * ------------------------------------
 * Structural edits are held to `panel-02`'s standard: the file after the write
 * must be byte-identical to the file before it, except for the one thing that
 * moved. A ts-morph `insertText`/`removeText` round trip through the printer
 * reformats whatever it re-emits, which on a real project means an unrelated
 * sibling silently losing its blank line or its attribute wrapping — a defect,
 * not a cosmetic difference. So the AST is used only to LOCATE, and the write
 * itself is a splice of the original bytes.
 *
 * WHOLE-LINE VS INLINE
 * --------------------
 * An element that sits alone on its own line(s) owns its indentation and its
 * trailing newline; moving it means moving those too, or the file gains a
 * ragged blank line where it used to be. An element sharing a line with a
 * sibling owns only itself. The two cases are distinguished here and never
 * mixed: an element that is whole-line cannot be written against an anchor
 * that is not (there is no correct answer for where the newline goes), which
 * `moveJsxElement` refuses as `mixed-indentation`.
 *
 * Whitespace between JSX children is a `JsxText` node, not trivia, so an
 * element child's `getStart()`/`getEnd()` are exactly its own bytes — there is
 * no leading-trivia ambiguity to reason about.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Node, SyntaxKind, type SourceFile } from 'ts-morph'
import { findJsxElementAtLocation, type JsxOpeningLikeElement } from './locateJsxElement'

/** A JSX child element resolved from a `line:col`, with the byte range that is exclusively its own. */
export interface JsxChildRange {
  /** The opening (or self-closing) tag the location pointed at. */
  opening: JsxOpeningLikeElement
  /** The whole element node — the `JsxElement` for a paired tag, the tag itself when self-closing. */
  element: Node
  /** The `JsxElement`/`JsxFragment` this element is a child of. */
  parent: Node
  /** First byte of the range this element owns. */
  start: number
  /** One past the last byte of the range this element owns. */
  end: number
  /** True when the element sits alone on its own line(s), so the range includes its indentation and trailing newline. */
  wholeLine: boolean
}

/** Why a location could not be resolved to an ordinary, relocatable JSX child. */
export type JsxChildRangeReason = 'not-found' | 'no-jsx-parent' | 'expression-child' | 'stale-source'

export type JsxChildRangeResult =
  | { ok: true; range: JsxChildRange }
  | { ok: false; reason: JsxChildRangeReason; message: string }

/**
 * Resolve the JSX element whose tag name starts at `line:col` and the bytes it
 * owns, or explain why it is not something a structural edit can address.
 *
 * Requiring a `JsxElement`/`JsxFragment` parent is the load-bearing check, and
 * it rules out two genuinely different shapes the canvas cannot tell apart:
 *
 *  - **`no-jsx-parent`** — the element is what the component RETURNS. Removing
 *    or relocating it leaves `return ;`, a file that no longer parses.
 *  - **`expression-child`** — the element is produced by an expression the code
 *    evaluates (`{cond && <X/>}`, a `.map`, a helper call). The canvas shows it
 *    as an ordinary child because the parser chose that branch, but the source
 *    has no fixed child position for it: moving the JSX would move the
 *    condition's result, not the element. `parser-06`'s branch selection makes
 *    these nodes UNLOCKED — correctly, since their values are editable — so
 *    this is the check that keeps their POSITION honest.
 */
export function resolveJsxChildRange(sourceFile: SourceFile, line: number, col: number): JsxChildRangeResult {
  const opening = findJsxElementAtLocation(sourceFile, line, col)
  if (!opening) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No JSX element is written at line ${line}, column ${col} any more — the file changed since the canvas last read it. Reload and try again.`,
    }
  }

  const element = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParentOrThrow()
  const parent = element.getParent()
  if (!parent || !(Node.isJsxElement(parent) || Node.isJsxFragment(parent))) {
    return element.getFirstAncestorByKind(SyntaxKind.JsxExpression)
      ? {
          ok: false,
          reason: 'expression-child',
          message:
            'In the code this element is produced by an expression — a condition, a list, or a helper — rather than written directly as a child. Its position is decided when the app runs, so there is no place in the file to write a new one.',
        }
      : {
          ok: false,
          reason: 'no-jsx-parent',
          message:
            'This element is the outermost thing its component returns, so it has no siblings in the code to be placed among — and removing it would leave the component returning nothing.',
        }
  }

  const full = sourceFile.getFullText()
  const start = element.getStart()
  const end = element.getEnd()

  const lineStart = full.lastIndexOf('\n', start - 1) + 1
  const newlineAfter = full.indexOf('\n', end)
  const lineEnd = newlineAfter === -1 ? full.length : newlineAfter + 1

  const leadIsBlank = full.slice(lineStart, start).trim() === ''
  const tailIsBlank = full.slice(end, lineEnd).trim() === ''
  const wholeLine = leadIsBlank && tailIsBlank

  return {
    ok: true,
    range: wholeLine
      ? { opening, element, parent, start: lineStart, end: lineEnd, wholeLine: true }
      : { opening, element, parent, start, end, wholeLine: false },
  }
}

/**
 * Cut `[start, end)` out of `text` and re-insert it at `at`, where `at` is a
 * position in the ORIGINAL text. Pure, so the splice arithmetic (the part that
 * corrupts a file when it is wrong) is unit-testable on strings alone.
 *
 * `at` must not fall inside the cut range — callers resolve it from a distinct
 * sibling, which `resolveJsxChildRange` guarantees cannot overlap.
 */
export function spliceRange(text: string, start: number, end: number, at: number): string {
  const moved = text.slice(start, end)
  const without = text.slice(0, start) + text.slice(end)
  const target = at >= end ? at - (end - start) : at
  return without.slice(0, target) + moved + without.slice(target)
}

/**
 * The text every offset in this module is measured against, or `null` when the
 * bytes on disk are not the bytes ts-morph parsed.
 *
 * That mismatch is a refusal, not something to reconcile: every offset a
 * structural edit splices at came from the parsed text, so writing them into a
 * different string is precisely how a codemod cuts a file in the wrong place.
 * It also catches the quieter failure — a project configured to normalize
 * newlines or re-add a byte-order mark on save would rewrite the whole file as
 * a side effect of moving one element, which is the reformatting defect these
 * codemods exist to avoid.
 */
export function verbatimSourceText(sourceFile: SourceFile, file: string): string | null {
  const parsed = sourceFile.getFullText()
  let onDisk: string
  try {
    onDisk = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return onDisk === parsed ? parsed : null
}

/** Write spliced bytes back verbatim and re-sync the parsed copy so a shared project stays honest. */
export function writeVerbatimSource(sourceFile: SourceFile, file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
  sourceFile.refreshFromFileSystemSync()
}
