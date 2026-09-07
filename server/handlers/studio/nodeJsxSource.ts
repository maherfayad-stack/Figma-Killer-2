/**
 * nodeJsxSource — the JSX a node was parsed from, read back out of the file.
 *
 * "Copy JSX" is the differentiator this whole tool is built around: the thing
 * on the canvas is not a picture of code, it IS code, and copying it should
 * hand back the user's own source — their formatting, their prop expressions,
 * their comments — not a regenerated approximation. So this reads the exact
 * character range ts-morph reports for the element and returns it verbatim.
 *
 * ## Why ts-morph and not a text slice
 *
 * A node id carries `rel:line:col`, which points at the TAG NAME, not at the
 * element's extent. Finding where the element ENDS means matching its closing
 * tag through however many nested elements, string literals containing `<`,
 * and `{/* comments *​/}` sit in between — a job for the parser that already
 * knows, not a regex. `locateJsxElement.ts` is the same locator every codemod
 * in `@core/ast-codemods` uses to find its write target, so "the JSX you
 * copied" and "the JSX an edit would rewrite" are by construction the same
 * span.
 *
 * ## Path safety
 *
 * `rel` arrives inside a node id the client sent, so it gets the same
 * treatment `studioWriteback.ts` gives a write target: `isWritableSourceRel`
 * rejects absolute paths, `..` traversal on either separator, and any
 * extension that is not app source, and the resolved file is then required to
 * be contained in the project. This route only READS, but "read any file on
 * the host" is not a smaller hole than writing one.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSourceNodeId } from '@core/page-tree'
import {
  createProject,
  findJsxElementAtLocation,
  loadSourceFile,
  resolveJsxWholeElement,
} from '@core/ast-codemods'
import { isWritableSourceRel } from '../studioWriteback'
import { isRealpathContained } from './workspacePackageResolve'

export type ReadNodeJsxResult = { ok: true; jsx: string; rel: string } | { ok: false; error: string }

/**
 * The JSX source of `nodeId` inside `dir`, or a named reason it cannot be
 * read. Every failure here is an ordinary outcome — a synthetic root, a
 * `.map` iteration, a file the user has since edited — not an exception.
 */
export function readNodeJsx(dir: string, nodeId: string): ReadNodeJsxResult {
  const location = decodeSourceNodeId(nodeId)
  if (!location) {
    return {
      ok: false,
      error: 'This element has no single place in the source to copy from — it is either a synthetic node (a page root) or one instance of a list the code generates.',
    }
  }
  if (!isWritableSourceRel(location.rel)) {
    return { ok: false, error: 'This element does not resolve to a source file inside the project.' }
  }

  const file = join(dir, location.rel)
  if (!existsSync(file) || !isRealpathContained(file, dir)) {
    return { ok: false, error: 'This element does not resolve to a source file inside the project.' }
  }

  const opening = findJsxElementAtLocation(loadSourceFile(createProject(), file), location.line, location.col)
  if (!opening) {
    return {
      ok: false,
      error: `No JSX element is written at ${location.rel}:${location.line}:${location.col} any more — the file changed since this board was loaded. Reload and try again.`,
    }
  }

  return { ok: true, jsx: resolveJsxWholeElement(opening).root.getText(), rel: location.rel }
}
