/**
 * babelPluginSourceTags — stamps every JSX element with its source location.
 *
 * For each `JSXOpeningElement` encountered, this plugin injects two
 * attributes (unless the element already carries `data-src-file`, in which
 * case it is left untouched — this makes repeated transforms idempotent):
 *
 *   - `data-src-file` — the file path containing the element, relative to
 *     the `root` plugin option, using POSIX (`/`) separators regardless of
 *     the host OS.
 *   - `data-src-loc`  — `"<line>:<col>"` pinpointing the JSX element's name
 *     (the identifier right after `<`), using **1-based line, 1-based
 *     column**. Babel locations report `line` as 1-based and `column` as
 *     0-based, so the column is adjusted by +1 here.
 *
 * COORDINATE CONVENTION (must stay in sync with any consumer, e.g. a
 * ts-morph-based peer module that maps these tags back to source ranges):
 *   line -> 1-based, counting from the first line of the file as line 1.
 *   col  -> 1-based, counting from the first character of the line as
 *           column 1. The position points at the first character of the
 *           JSX element's tag name (the character immediately following
 *           `<`), not the `<` itself.
 *
 * `JSXFragment` (`<>...</>`) nodes use `JSXOpeningFragment`, a distinct AST
 * node from `JSXOpeningElement`, so this visitor never sees them and they
 * are never tagged.
 *
 * Elements are skipped entirely (left untouched) when `state.filename` is
 * not available, since there would be nothing meaningful to record for
 * `data-src-file` / `data-src-loc`.
 */

import path from 'node:path'
import type * as BabelCore from '@babel/core'
import jsxSyntax from '@babel/plugin-syntax-jsx'

export interface SourceTagsPluginOptions {
  /** Directory that `data-src-file` paths are made relative to. Defaults to `process.cwd()`. */
  root?: string
}

const FILE_ATTR = 'data-src-file'
const LOC_ATTR = 'data-src-loc'

export default function babelPluginSourceTags(
  babel: typeof BabelCore
): BabelCore.PluginObject<BabelCore.PluginPass & { opts: SourceTagsPluginOptions }> {
  const { types: t } = babel

  return {
    name: 'source-tags',
    // Babel 8's `@babel/preset-typescript` no longer auto-enables JSX
    // parsing for `.tsx` files (that now requires the `jsx` parser plugin
    // to be registered explicitly). Inheriting `@babel/plugin-syntax-jsx`
    // registers it, so this plugin works standalone alongside
    // `@babel/preset-typescript` without the consumer having to wire up
    // JSX syntax support themselves.
    inherits: jsxSyntax,
    visitor: {
      JSXOpeningElement(elementPath, state) {
        const filename = state.filename
        if (!filename) return

        const attributes = elementPath.node.attributes
        const alreadyTagged = attributes.some(
          (attr) => t.isJSXAttribute(attr) && attr.name.name === FILE_ATTR
        )
        if (alreadyTagged) return

        const nameLoc = elementPath.node.name.loc
        if (!nameLoc) return

        const root = state.opts.root ?? process.cwd()
        const relativeFile = path.relative(root, filename).split(path.sep).join('/')

        const line = nameLoc.start.line
        const col = nameLoc.start.column + 1

        elementPath.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(FILE_ATTR), t.stringLiteral(relativeFile)),
          t.jsxAttribute(t.jsxIdentifier(LOC_ATTR), t.stringLiteral(`${line}:${col}`))
        )
      },
    },
  }
}
