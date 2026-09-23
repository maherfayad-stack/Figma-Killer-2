/**
 * idStamp — stamps `data-node-id` on every host/intrinsic JSX element AND
 * every component call site in one file's source text, using the exact id
 * `parsePageFile` mints for the SAME source position (`toRuntimeStampId`,
 * `@core/page-tree`).
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
 * ## What gets stamped, and where the attribute lands
 *
 * BOTH host/intrinsic elements (`classifyJsxTagKind(name) === 'element'`) AND
 * component call sites (`=== 'component'`, e.g. `<Button/>`) are stamped — a
 * call site is not always a no-op for DOM purposes: any component that
 * spreads `...props`/`...rest` onto its own root element (every design-system
 * component in this repo's corpus does) renders exactly that attribute on a
 * real element. `parsePageFile` mints the identical id for a `'component'`
 * node at this same tag-name position (`buildSourceNodeId`, computed BEFORE
 * it branches on `kind` — see `processElement`), so the two sides already
 * agree on what this id should be; the plugin only had to start writing it.
 * A component that does NOT forward its props renders nothing extra — the
 * attribute lands on an ordinary, ignored prop, which is harmless.
 *
 * `classifyJsxTagKind` is the exact function `parsePageFile` uses for the
 * identical question, so a `motion.div`-shaped dotted-lowercase name is
 * classified `'element'` here too — reproducing the parser's quirk, not
 * fixing it, is what keeps the two sides agreeing.
 *
 * **Attribute ORDER is load-bearing, and differs by kind.** A host element's
 * OWN stamp is `unshift`ed to the FRONT of its attribute list — before
 * `className`, before everything the author wrote — so that a LATER
 * `{...props}` spread (which, textually, still comes after it) can override
 * it. JSX/`createElement` attribute merging applies later attributes over
 * earlier ones, so an element's own internal stamp only wins when nothing
 * downstream overrides it, and LOSES to a forwarded call-site stamp the
 * moment the component spreads props through. Before this file stamped call
 * sites at all, this ordering had no visible effect (there was never anything
 * in `...props` to lose to) — it matters starting now. A component call
 * site's OWN stamp is still `push`ed onto the END of ITS attribute list — it
 * has nothing of its own to lose to; pushing last only means it wins over any
 * spread the CALL SITE itself received (e.g. `<Button {...linkProps}/>`),
 * which is the same "the more specific, closer-to-the-user write wins" rule.
 *
 * This is why a design-system component (`Button.jsx`'s own `<button
 * {...props}>`) now resolves to the CALL SITE the user actually clicked,
 * never to `Button.jsx`'s own internal, per-file id — see
 * `docs/agent-refs/canvas-internals.md`'s bridge/"stamp index" section and
 * `liveNodeResolve.ts` for how the occurrence-pairing side of this is kept
 * consistent.
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
        const kind = classifyJsxTagKind(name)
        if (node.attributes.some((a) => t.isJSXAttribute(a) && a.name.name === STUDIO_NODE_ID_ATTR)) return

        // The tag name node's own loc — the character immediately after `<` —
        // is exactly what ts-morph's `getTagNameNode().getStart()` addresses.
        // Same computation for both kinds — `parsePageFile` mints the id
        // before it ever looks at `kind` (see this file's header).
        const loc = node.name.loc
        if (!loc) return
        const id = toRuntimeStampId(relFile, loc.start.line, loc.start.column + 1)
        const attr = t.jsxAttribute(t.jsxIdentifier(STUDIO_NODE_ID_ATTR), t.stringLiteral(id))

        // See this file's header, "Attribute ORDER is load-bearing" — a host
        // element's own stamp goes FIRST so a later `{...props}` spread from
        // its call site can override it; a call site's own stamp goes LAST on
        // its own (unrelated) attribute list.
        if (kind === 'element') node.attributes.unshift(attr)
        else node.attributes.push(attr)
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
