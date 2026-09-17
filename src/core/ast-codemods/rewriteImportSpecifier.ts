/**
 * Rewrites every import in ONE source file that names a given module —
 * `import … from '<from>'` and its sub-path forms `'<from>/…'` — to a
 * different specifier, preserving formatting and quote style.
 *
 * ## What this is for
 *
 * Studio's design system stopped being an npm package and became a
 * Studio-written `<project>/design-system/` folder that pages import
 * relatively. The two workspace projects that already exist import the retired
 * package in 13 files between them, and there is no version of "no backward
 * compatibility" that fixes that by leaving the user's source alone: their
 * repository has to be rewritten, once, into the shape that still builds.
 *
 * `setImportSpecifier` (the sibling) rewrites ONE literal at an exact
 * (line, col) — the honest target for "pick a different image", where the
 * board knows precisely which import it means. This one is the other shape:
 * the caller knows the module NAME and nothing about where in the file it
 * appears, so the match is on the specifier's value and every occurrence is
 * rewritten together.
 *
 * ## The three specifier shapes, and the one that is deleted
 *
 * | in | out |
 * |---|---|
 * | `'<from>'` | `'<to>'` |
 * | `'<from>/src/icons/x.svg?raw'` | `'<to>/icons/x.svg?raw'` |
 * | `'<from>/dist/anything'` | `'<to>'` |
 * | `'<from>/dist/index.css'` (side-effect only) | the import is REMOVED |
 *
 * The `src/` prefix is dropped because the package published its source under
 * `src/` and the folder IS the source — `<to>/icons/...` is where that file
 * now lives. Everything under `dist/` was a BUILD of that source and has no
 * counterpart in the folder at all, so the only honest target is the folder
 * root, whose `index.js` re-exports the same surface. A query string (`?raw`,
 * `?inline`) rides along untouched, since it belongs to the bundler and not to
 * the path.
 *
 * The stylesheet import is removed rather than repointed because the folder's
 * own `index.js` imports the token CSS, so a second import of it would be a
 * duplicate side effect — and because there is no file at the old path to
 * point at. It is removed ONLY when it is a bare side-effect import (`import
 * '…css'`), never when something is bound from it: deleting a declaration that
 * introduces a binding would break the file, which is the one thing a codemod
 * over a user's repository may never do.
 *
 * ## Formatting
 *
 * ts-morph edits the existing AST in place, so everything this does not touch
 * comes back byte-identical, and the quote style of each rewritten specifier is
 * read off the literal it replaces (same technique as `setImportSpecifier`) so
 * a migration does not show up as a quote-style diff across the repository.
 *
 * The caller owns the `SourceFile` and therefore the save: a migration rewrites
 * many files in one ts-morph `Project` and saves once at the end.
 */
import { Node, type SourceFile, type StringLiteral } from 'ts-morph'

export interface RewriteImportSpecifierParams {
  /** The module name to match — exactly, or as the prefix of a `'<from>/…'` sub-path. */
  from: string
  /** What it becomes. For the design-system migration, the relative path from THIS file to `<root>/design-system`. */
  to: string
}

export interface RewriteImportSpecifierResult {
  /** Import declarations whose specifier was rewritten. */
  rewritten: number
  /** Import declarations removed outright (a side-effect stylesheet import with nowhere to point). */
  removed: number
}

/**
 * Re-quotes `value` the way `literal` is quoted, so a rewrite never shows up as
 * a quote-style diff. `JSON.stringify` does the escaping; the single-quote case
 * then un-escapes `\"` and escapes `'`.
 */
function quotedLike(literal: StringLiteral, value: string): string {
  const doubleQuoted = JSON.stringify(value)
  if (!literal.getText().startsWith("'")) return doubleQuoted
  return `'${doubleQuoted.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
}

/**
 * The specifier `'<from>/<subPath>'` becomes, or `null` when the declaration
 * should be removed instead. `to` is the new module root.
 */
function rewriteSubPath(subPath: string, to: string, sideEffectOnly: boolean): string | null {
  const [path = '', query] = splitQuery(subPath)

  if (path === 'dist' || path.startsWith('dist/')) {
    // The published package's stylesheet bundle. The folder's `index.js`
    // imports the token CSS itself, so a bare side-effect import of it is now
    // noise with no file behind it.
    if (sideEffectOnly && path.endsWith('.css')) return null
    // Everything else under `dist/` was a BUILD of `src/`, and the folder
    // carries the source instead — so the only honest target is the folder
    // root, whose `index.js` re-exports the same surface.
    return withQuery(to, query)
  }

  const rest = path.startsWith('src/') ? path.slice('src/'.length) : path
  return withQuery(rest.length > 0 ? `${to}/${rest}` : to, query)
}

function withQuery(specifier: string, query: string | undefined): string {
  return query === undefined ? specifier : `${specifier}?${query}`
}

/** `'icons/x.svg?raw'` -> `['icons/x.svg', 'raw']`. A specifier with no query yields `[path, undefined]`. */
function splitQuery(specifier: string): [string, string | undefined] {
  const at = specifier.indexOf('?')
  return at === -1 ? [specifier, undefined] : [specifier.slice(0, at), specifier.slice(at + 1)]
}

/**
 * Rewrites (or removes) every import of `from` in `sourceFile`. Does NOT save —
 * see the module doc.
 */
export function rewriteImportSpecifier(
  sourceFile: SourceFile,
  params: RewriteImportSpecifierParams,
): RewriteImportSpecifierResult {
  const { from, to } = params
  const result: RewriteImportSpecifierResult = { rewritten: 0, removed: 0 }
  const prefix = `${from}/`

  // Snapshot first: removing a declaration invalidates the live child list, so
  // iterating it while mutating skips the declaration after every removal.
  for (const declaration of [...sourceFile.getImportDeclarations()]) {
    const literal = declaration.getModuleSpecifier()
    if (!Node.isStringLiteral(literal)) continue
    const specifier = literal.getLiteralValue()

    let next: string | null
    if (specifier === from) {
      next = to
    } else if (specifier.startsWith(prefix)) {
      // A declaration binds nothing when it has no import clause at all —
      // `import './x.css'`. Anything with a clause is load-bearing and is
      // rewritten, never removed.
      const sideEffectOnly = declaration.getImportClause() === undefined
      next = rewriteSubPath(specifier.slice(prefix.length), to, sideEffectOnly)
    } else {
      continue
    }

    if (next === null) {
      declaration.remove()
      result.removed += 1
      continue
    }
    if (next === specifier) continue
    literal.replaceWithText(quotedLike(literal, next))
    result.rewritten += 1
  }

  return result
}
