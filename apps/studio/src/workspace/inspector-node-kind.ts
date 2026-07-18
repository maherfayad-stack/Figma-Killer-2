import type { TreeNode } from '@ccs/protocol';

/**
 * FIX-W4b-1 Part A — per-node-type section visibility (Penpot
 * `options.cljs`/`options/shapes/*.cljs` parity: "text focus -> text
 * controls, frame focus -> frame controls").
 *
 * ## The `TreeNodeKind` gap this file works around
 * `packages/protocol/src/tree.ts`'s FROZEN `TreeNodeKindSchema` already has a
 * `'text'` member — but `@ccs/ast-engine`'s `buildTree`
 * (`packages/ast-engine/src/build-tree.ts`) never actually PRODUCES it: every
 * JSX element that isn't a `JSXFragment` and doesn't resolve to a known
 * component becomes `kind: 'element'`, including a real `<h1>`/`<p>`/`<span>`
 * (confirmed by reading `build-tree.ts`'s `build()` — its only two outcomes
 * per non-fragment node are `'component-instance'` or `'element'`; nothing
 * ever assigns `'text'`). So a literal `node.kind === 'text'` branch would be
 * correct but practically DEAD CODE today — selecting a real `<h1>` in this
 * session's browser would never take it, which fails this task's own
 * "actually work" / real-browser-dogfood bar.
 *
 * Fixing that properly means teaching `buildTree` to classify a leaf,
 * text-holding element as `kind: 'text'` — a `packages/ast-engine` change,
 * outside this task's `apps/studio/src/workspace/` scope (hard constraint:
 * touching `packages/` beyond zero-diff requires stopping to document why,
 * not doing it inline). That CR is flagged in the worker report as the real
 * fix.
 *
 * Until then, `isTextFocused` below is how `Inspector.tsx` still delivers
 * the human's literal ask THIS session: it treats a node as "text-focused"
 * when `node.kind === 'text'` (forward-compatible — the day `buildTree`
 * starts emitting it, this already handles it) OR when `node.kind ===
 * 'element'` and its tag is one of a curated set of typical inline/text HTML
 * tags. Penpot has no DOM-tag concept at all (its shapes are drawn vectors,
 * not `<h1>`/`<div>`), so there is no upstream Penpot source to cite for this
 * specific tag list — it is a new, narrow, additive heuristic, not a port.
 * `button` is deliberately EXCLUDED: this tool already exercises `button` in
 * its full "generic element" stack (`apps/studio/e2e/tests/acceptance.spec.ts`
 * test "(d)" sets a Layout-container `gap-2` class on a real `<button>`), and
 * a button is routinely a flex container (icon + label) in real markup, so
 * it stays on the fuller stack rather than the lean text one.
 */
export const TEXT_LIKE_TAGS: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'label',
  'li',
  'blockquote',
  'figcaption',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'caption',
  'legend',
  'dt',
  'dd',
  'td',
  'th',
  'summary',
  'time',
  'mark',
  'q',
  'cite',
  'abbr',
]);

export function isTextFocused(node: Pick<TreeNode, 'kind' | 'tag'>): boolean {
  if (node.kind === 'text') return true;
  return node.kind === 'element' && node.tag !== null && TEXT_LIKE_TAGS.has(node.tag);
}
