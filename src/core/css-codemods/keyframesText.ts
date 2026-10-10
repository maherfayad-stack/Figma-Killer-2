/**
 * keyframesText — the postcss-free half of the `@keyframes` codemods: reading
 * a block's steps, matching its name, and printing a fresh block.
 *
 * Why this is not in `keyframes.ts` beside the writers: the editor's save path
 * and the launcher read `@keyframes` bodies in the BROWSER (`keyframesWriteback`
 * diffs two bodies; the animation section lists steps), and postcss — which the
 * writers need for their formatting-preserving CST round-trip — pulls `path`,
 * `url`, `fs` and `source-map-js` shims that the browser answers with a
 * "has been externalized for browser compatibility" warning on every access.
 * A READ needs no CST: it needs the steps and their declarations, so it is a
 * small scanner here, and the one implementation the server (`studioCss*`) and
 * the editor both call. The writers stay in `keyframes.ts` and are reached by
 * the browser only through a dynamic `import()` at the moment a user edits an
 * animation (`keyframesStepEdit.ts` in the PropertiesPanel) — gated by
 * `postcss-not-in-admin-bundle.test.ts`.
 *
 * ## What it accepts, mirroring postcss
 *
 * - Top-level `@keyframes <name>` / `@-vendor-keyframes <name>`; the FIRST block
 *   with that exact (trimmed) name wins, as `keyframes.ts`'s writers also pick.
 * - Comments are removed everywhere (postcss's cleaned `value`/`selector`).
 * - Strings and `( … )` groups are opaque, so `;`/`{`/`}` inside `url(a;b)` or
 *   `content: "}"` do not split anything.
 * - A trailing `!important` is not part of the value (postcss keeps it in a
 *   separate `important` flag).
 * - Unbalanced braces, a stray `}`, or a declaration with no `:` are a parse
 *   failure, i.e. `null` — the same "no block here, not a crash" answer the
 *   postcss version gave for text it threw on.
 */

/** One step of an `@keyframes` block, as authored. */
export interface KeyframeStep {
  /** The offset exactly as written — `from`, `to`, `0%`, or a list like `0%, 100%`. */
  keyText: string
  /** kebab-cased property → value, in source order. */
  declarations: Record<string, string>
}

/** `@keyframes`, `@-webkit-keyframes`, `@-moz-keyframes`, … */
export const KEYFRAMES_AT_RULE_RE = /^(?:-[a-z]+-)?keyframes$/i

/** The same at-rule name family, written as a whole prelude: `@keyframes fade-in`. */
const KEYFRAMES_PRELUDE_RE = /^@(?:-[a-z]+-)?keyframes\s+(.+)$/i

/**
 * The animation name in a `@keyframes fade-in` prelude, or `null` when the
 * text is not one.
 *
 * Studio stores a keyframes block as a `StyleRule` whose `selector` IS that
 * prelude (`siteImport/keyframesToStyleRule.ts`), so this is how both the
 * inspector and the save path get from a rule to the `name` every keyframes
 * function matches on. It lives with the matcher it has to agree with, rather
 * than beside either caller — the two would otherwise each own a copy of the
 * vendor-prefix spelling, and a copy that drifts is a copy that writes to the
 * wrong block.
 */
export function keyframesNameFromSelector(selector: string): string | null {
  const match = KEYFRAMES_PRELUDE_RE.exec(selector.trim())
  return match ? match[1]!.trim() : null
}

type Node =
  | { kind: 'decl'; text: string }
  | { kind: 'block'; prelude: string; children: Node[] }

class ScanError extends Error {}

/** Index just past the end of the block comment starting at `i`, or the end of input for an unterminated one. */
function skipComment(src: string, i: number): number {
  const end = src.indexOf('*/', i + 2)
  return end === -1 ? src.length : end + 2
}

/** Index just past the string literal starting at `i` (a backslash escapes the next character). */
function skipString(src: string, i: number): number {
  const quote = src[i]
  let j = i + 1
  while (j < src.length) {
    const ch = src[j]
    if (ch === '\\') j += 2
    else if (ch === quote) return j + 1
    else j += 1
  }
  return src.length
}

/**
 * Parse one block body (or the whole sheet when `topLevel`) starting at
 * `from`. Returns the nodes and the index just past the closing `}` (or the
 * end of input at top level).
 */
function parseSequence(src: string, from: number, topLevel: boolean): { nodes: Node[]; end: number } {
  const nodes: Node[] = []
  let text = ''
  let parenDepth = 0
  let i = from

  const flushDecl = (): void => {
    const trimmed = text.trim()
    if (trimmed) nodes.push({ kind: 'decl', text: trimmed })
    text = ''
  }

  while (i < src.length) {
    const ch = src[i]!
    if (ch === '/' && src[i + 1] === '*') {
      i = skipComment(src, i)
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = skipString(src, i)
      text += src.slice(i, end)
      i = end
      continue
    }
    if (ch === '(') parenDepth += 1
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1
    if (parenDepth > 0) {
      text += ch
      i += 1
      continue
    }
    if (ch === '{') {
      const inner = parseSequence(src, i + 1, false)
      nodes.push({ kind: 'block', prelude: text.trim(), children: inner.nodes })
      text = ''
      i = inner.end
      continue
    }
    if (ch === '}') {
      if (topLevel) throw new ScanError('unexpected }')
      flushDecl()
      return { nodes, end: i + 1 }
    }
    if (ch === ';') {
      flushDecl()
      i += 1
      continue
    }
    text += ch
    i += 1
  }

  if (!topLevel) throw new ScanError('unclosed block')
  flushDecl()
  return { nodes, end: i }
}

const IMPORTANT_RE = /\s*!\s*important\s*$/i

/** `prop: value` → the pair, with a trailing `!important` dropped; `null` when there is no `:`. */
function splitDeclaration(text: string): [string, string] | null {
  const colon = text.indexOf(':')
  if (colon === -1) return null
  const prop = text.slice(0, colon).trim()
  const value = text.slice(colon + 1).replace(IMPORTANT_RE, '').trim()
  return [prop, value]
}

/**
 * The steps of `@keyframes <name>` in `cssText`, in source order, or `null`
 * when the file declares no such block (or the text cannot be parsed).
 *
 * The read side of the keyframes codemods, and the reason they exist at all: a
 * `@keyframes` block reaches the editor as one opaque `StyleRule.rawCss`
 * string (`siteImport/keyframesToStyleRule.ts`), so the inspector has no way
 * to show a step, let alone edit one, without parsing it back. Declarations
 * keep their authored kebab-case names — this is a view of CSS text, not of a
 * `CSSPropertyBag`, and the caller converts if it needs the editor's camelCase
 * convention.
 *
 * A step whose block holds only comments contributes an empty `declarations`
 * rather than being dropped: it is a step the user wrote, and the editor must
 * be able to see it to add the first declaration to it.
 */
export function readKeyframeSteps(cssText: string, name: string): KeyframeStep[] | null {
  let nodes: Node[]
  try {
    nodes = parseSequence(cssText, 0, true).nodes
  } catch (err) {
    if (err instanceof ScanError) {
      // Unparseable text is "no block here", not a crash — the caller is often
      // rendering a panel for CSS that arrived from an arbitrary repository.
      return null
    }
    throw err
  }

  const wanted = name.trim()
  const block = nodes.find((node): node is Extract<Node, { kind: 'block' }> => {
    if (node.kind !== 'block') return false
    const match = /^@(\S+)\s+(.+)$/s.exec(node.prelude)
    return match !== null && KEYFRAMES_AT_RULE_RE.test(match[1]!) && match[2]!.trim() === wanted
  })
  if (!block) return null

  const steps: KeyframeStep[] = []
  for (const step of block.children) {
    if (step.kind !== 'block') continue
    const declarations: Record<string, string> = {}
    for (const child of step.children) {
      if (child.kind !== 'decl') continue
      const pair = splitDeclaration(child.text)
      if (!pair) return null
      declarations[pair[0]] = pair[1]
    }
    steps.push({ keyText: step.prelude, declarations })
  }
  return steps
}

/**
 * The literal CSS text of a whole `@keyframes` block — the one reliable way to
 * get correct nested indentation (see `setDeclarationAtMedia`'s note). The
 * writers parse this back into a CST to append it; the editor uses it as-is
 * for a brand-new animation, so both start from byte-identical text.
 */
export function keyframesBlockText(name: string, steps: readonly KeyframeStep[]): string {
  const body = steps
    .map((step) => {
      const decls = Object.entries(step.declarations)
        .map(([property, value]) => `    ${property}: ${value};`)
        .join('\n')
      return `  ${step.keyText} {\n${decls}\n  }`
    })
    .join('\n')
  return `@keyframes ${name} {\n${body}\n}`
}
