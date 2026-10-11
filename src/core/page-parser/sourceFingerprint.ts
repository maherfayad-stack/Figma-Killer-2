/**
 * The COMPUTATION half of a studio node's identity fingerprint (P1-A). The
 * wire shape and why it exists live in `@core/page-tree`'s
 * `sourceFingerprint.ts`; this is the one place a fingerprint is minted, used
 * by the parser when it reads a node and by the writeback guard when it checks
 * one (`@core/ast-codemods`' `readSourceFingerprintAt`). Two callers, one
 * function: a guard that hashed differently from the parser would refuse every
 * write.
 *
 * ## What an element's fingerprint covers, and why exactly that
 *
 * The OPENING TAG, verbatim, plus the element's own DIRECT text — its
 * `JsxText` children and any `{…}` child that contains no JSX.
 *
 * - The opening tag alone is not enough. `<li>One</li>` and `<li>Two</li>`
 *   have identical opening tags, and the neighbour that slides into a shifted
 *   position is usually exactly that: a sibling of the same tag. Their text
 *   tells them apart.
 * - The whole subtree would be too much. Every value edit on a DESCENDANT would
 *   change every ancestor's fingerprint, so the board would have to refresh the
 *   identity of an element nobody wrote to. With direct text only, a write
 *   changes the fingerprint of the element it targets and nothing else — which
 *   is what lets the client keep its recorded identities current from the
 *   save response alone (`StudioEditBatchResult.fingerprints`).
 * - A `{…}` child that contains JSX (`{items.map(…)}`, `{open && <Menu/>}`) is
 *   left out for the same reason: the elements inside it are nodes with
 *   fingerprints of their own, and an edit to one must not move this one.
 *
 * Whitespace runs collapse to one space before hashing, and whitespace-only
 * text contributes nothing. A CRLF checkout therefore hashes like its LF twin
 * (the guard reads the file raw; the parser reads it LF-normalised), and a
 * structural edit that only re-indents or removes a neighbour's line does not
 * change a surviving element's identity.
 *
 * ## A literal's fingerprint
 *
 * The literal token's own text, quotes included, labelled `literal`. That is
 * the target of a `literal` edit (a dictionary string the text resolved from)
 * and of an `asset` edit (an import's module specifier).
 *
 * The hash is FNV-1a, 32 bit: deterministic, dependency-free, and far more
 * than a guard needs — it answers "is this the element I read", not "is this
 * text secure".
 */
import { Node, type JsxElement, type JsxSelfClosingElement } from 'ts-morph'

/** The label a literal token's fingerprint carries in place of a tag name. */
export const LITERAL_FINGERPRINT_LABEL = 'literal'

/** A JSX element's fingerprint — see this module's doc for what it covers. */
export function jsxElementFingerprint(element: JsxElement | JsxSelfClosingElement): string {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element
  const parts = [opening.getText()]
  if (Node.isJsxElement(element)) {
    for (const child of element.getJsxChildren()) {
      if (Node.isJsxText(child)) parts.push(child.getText())
      else if (Node.isJsxExpression(child) && !containsJsx(child)) parts.push(child.getText())
    }
  }
  return `${opening.getTagNameNode().getText()}#${fnv1a32(normalizeSourceText(parts.join(' ')))}`
}

/** A string/template/numeric literal token's fingerprint. */
export function literalFingerprint(literal: Node): string {
  return `${LITERAL_FINGERPRINT_LABEL}#${fnv1a32(normalizeSourceText(literal.getText()))}`
}

function containsJsx(node: Node): boolean {
  return node.getFirstDescendant(
    (descendant) =>
      Node.isJsxElement(descendant) || Node.isJsxSelfClosingElement(descendant) || Node.isJsxFragment(descendant),
  ) !== undefined
}

/**
 * Whitespace runs become one space, and whitespace touching `<` `>` `=` `{` `}`
 * goes entirely — so `<a\n  href="x"\n>` (a formatter breaking a long tag)
 * hashes like `<a href="x">`. Both the parser and the guard normalise through
 * here, so any loss of detail is the same on both sides.
 */
function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/ ?([<>={}]) ?/g, '$1').trim()
}

/** FNV-1a over UTF-16 code units, as 8 lowercase hex digits. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
