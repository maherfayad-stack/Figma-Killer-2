/**
 * relativeImportSpecifier — pure POSIX relative-path math for the browser
 * side of E2.5's slot-fill picker (`SlotControl.tsx`).
 *
 * `insertJsxIntoSlotProp`/`insertJsxElement` (server, `@core/ast-codemods`)
 * write whatever `importSpecifier` string the CALLER hands them verbatim
 * (`addNamedImport({ moduleSpecifier: importSpecifier })`) — they do not
 * resolve a workspace-relative path into a relative-to-the-call-site one.
 * Every existing caller of that field (`writeInsertToSource` in
 * `nodeActions.ts`) sidesteps this because it only ever inserts an ALREADY-
 * REGISTERED module (`alm.*`/`pkg.*`), whose `sourceImport.specifier` is a
 * real npm package specifier, never a relative path. E1's local-component
 * catalog (`LocalComponentSpec.file`) is the first source of "insert a
 * component the user hasn't dragged in before" that names a file INSIDE the
 * SAME project — so this is the first caller that actually needs to compute
 * one client-side, mirroring (not importing — that module is ts-morph/Node,
 * server-only) `importReconcile.ts`'s `relativeSpecifier`.
 *
 * Both `fromFileRel`/`toFileRel` are workspace-root-relative POSIX paths, the
 * shape every studio node id and `LocalComponentSpec.file` already use — no
 * leading `/`, no drive letter, `/`-separated regardless of OS.
 */

const EXTENSION_RE = /\.(tsx|ts|jsx|js|mjs|cjs)$/

function splitPosix(relPath: string): string[] {
  return relPath.split('/').filter((segment) => segment.length > 0)
}

/** The directory portion of a workspace-relative file path, as path segments. */
function dirSegments(fileRel: string): string[] {
  const parts = splitPosix(fileRel)
  return parts.slice(0, -1)
}

/**
 * A relative ES-module specifier from `fromFileRel` to `toFileRel` —
 * extension-stripped (`./Card`, never `./Card.tsx`), always starting with
 * `.` or `..` so it can never be mistaken for a bare package specifier.
 */
export function relativeImportSpecifier(fromFileRel: string, toFileRel: string): string {
  const fromDir = dirSegments(fromFileRel)
  const toParts = splitPosix(toFileRel.replace(EXTENSION_RE, ''))
  const toDir = toParts.slice(0, -1)
  const toBase = toParts[toParts.length - 1] ?? ''

  let common = 0
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++
  }
  const ups = fromDir.length - common
  const downSegments = [...toDir.slice(common), toBase]

  const parts = [...Array<string>(ups).fill('..'), ...downSegments]
  const joined = parts.join('/')
  return joined.startsWith('.') ? joined : `./${joined}`
}
