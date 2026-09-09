/**
 * idStamp — stamps `data-node-id` on every host/intrinsic JSX element in one
 * file's source text, using the exact id `parsePageFile` mints for the SAME
 * source position (`toRuntimeStampId`, `@core/page-tree`).
 *
 * Parses with `@babel/core`'s own parser (`parserOpts.plugins: ['jsx',
 * 'typescript']`), no transform preset — so TS syntax survives the walk and
 * Vite's own esbuild pass strips it afterwards, exactly as if this plugin had
 * never run. Only `@babel/core` + `@babel/types`, both already
 * `dependencies` — zero new npm packages (`NodePath`/`traverse`/`parseSync`
 * are all re-exported from `@babel/core`'s own `.d.ts`, so nothing here
 * imports `@babel/parser`/`@babel/traverse` directly, even as a type).
 *
 * ## The column-offset landmine
 *
 * Babel's `loc.start.column` is 0-based. `sourceNodeId.ts`'s id grammar (and
 * ts-morph's `getLineAndColumnAtPos`) is 1-based. Forgetting the `+1` below
 * produces an id that LOOKS plausible — a real file, a real line, a column one
 * off — and silently never matches the id the parser minted for the same
 * element. This is the single most likely place this file drifts; if the
 * id-parity gate (`src/__tests__/studio-runtime/idParity.test.ts`) ever fails
 * after touching this file, check here first.
 *
 * ## What gets stamped
 *
 * Host/intrinsic elements only (`classifyJsxTagKind(name) === 'element'`) — a
 * component call site (`<PlanCard/>`) renders none of its OWN DOM (see
 * `inlineLocalComponents.ts`'s "instance" model, `@core/page-parser`); stamping
 * it would put an attribute nowhere React actually renders one.
 * `classifyJsxTagKind` is the exact function `parsePageFile` uses for the
 * identical question, so a `motion.div`-shaped dotted-lowercase name is
 * classified `'element'` here too — reproducing the parser's quirk, not
 * fixing it, is what keeps the two sides agreeing.
 */
import { parseSync, transformFromAstSync, traverse, types as t } from '@babel/core'
import type { NodePath } from '@babel/core'
import { classifyJsxTagKind, toRuntimeStampId } from '@core/page-tree'

/** The attribute the plugin stamps and `liveNodeResolve` reads back. */
export const STUDIO_NODE_ID_ATTR = 'data-node-id'

export interface StampResult {
  code: string
  /** `false` when nothing changed (no host elements, or the file could not be parsed) — lets a caller skip writing an identical string back to Vite's pipeline. */
  changed: boolean
}

type JsxNameNode = t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName

/** Reconstructs a JSX tag name's source text (`div`, `Foo.Bar`, `svg:title`) the way ts-morph's `getTagNameNode().getText()` would — `classifyJsxTagKind` and the id both depend on matching that text exactly. */
function jsxNameToString(node: JsxNameNode): string {
  if (t.isJSXIdentifier(node)) return node.name
  if (t.isJSXNamespacedName(node)) return `${node.namespace.name}:${node.name.name}`
  return `${jsxNameToString(node.object as JsxNameNode)}.${node.property.name}`
}

/**
 * Stamps every host element in `code` (the source text of `relFile`, a
 * workspace-relative POSIX path — the same string `parsePageFile` computes)
 * with `data-node-id`.
 *
 * Never throws. A file this cannot parse (a syntax error mid-edit, a dialect
 * neither `jsx` nor `typescript` syntax plugins cover) is returned unchanged —
 * matching `parsePageFile`'s own never-throw contract, because a stale stamp
 * is strictly better than a broken dev server.
 */
export function stampHostElementIds(code: string, relFile: string): StampResult {
  try {
    const ast = parseSync(code, {
      filename: relFile,
      sourceType: 'module',
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ['jsx', 'typescript'] },
    })
    if (!ast) return { code, changed: false }

    let changed = false

    traverse(ast, {
      JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
        const node = path.node
        const name = jsxNameToString(node.name as JsxNameNode)
        if (classifyJsxTagKind(name) !== 'element') return
        if (node.attributes.some((a) => t.isJSXAttribute(a) && a.name.name === STUDIO_NODE_ID_ATTR)) return

        // The tag name node's own loc — the character immediately after `<` —
        // is exactly what ts-morph's `getTagNameNode().getStart()` addresses.
        const loc = node.name.loc
        if (!loc) return
        const id = toRuntimeStampId(relFile, loc.start.line, loc.start.column + 1)

        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(STUDIO_NODE_ID_ATTR), t.stringLiteral(id)))
        changed = true
      },
    })

    if (!changed) return { code, changed: false }

    const result = transformFromAstSync(ast, code, {
      cloneInputAst: false,
      code: true,
      ast: false,
      configFile: false,
      babelrc: false,
      comments: true,
    })
    if (!result?.code) return { code, changed: false }
    return { code: result.code, changed: true }
  } catch {
    return { code, changed: false }
  }
}
