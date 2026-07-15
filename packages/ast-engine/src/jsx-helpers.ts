import { Node, SyntaxKind } from 'ts-morph';
import type { JsxOpeningElement, JsxSelfClosingElement } from 'ts-morph';
import { isJsxPathNode } from './uid-path.js';
import { ApplyOpError } from './errors.js';

/**
 * Shared ts-morph JSX plumbing used by every op handler in `apply-op.ts`.
 * Kept in one place so the "never the AST default printer, only structured
 * ts-morph edits + a final prettier pass" discipline (playbook §4/P3
 * pitfall #1) is applied consistently: every helper here either uses a
 * dedicated ts-morph structural method (`setBodyText`, `addAttribute`,
 * `replaceWithText`, `remove`) or a narrowly-scoped `SourceFile#replaceText
 * /insertText` range edit — never a whole-tree reprint.
 */

export function getJsxChildrenOf(node: Node): Node[] {
  if (node.getKind() === SyntaxKind.JsxElement) {
    return node.asKindOrThrow(SyntaxKind.JsxElement).getJsxChildren();
  }
  if (node.getKind() === SyntaxKind.JsxFragment) {
    return node.asKindOrThrow(SyntaxKind.JsxFragment).getJsxChildren();
  }
  return [];
}

/**
 * The path-node "children" of `node`, per the SAME definition
 * `uid-path.ts`'s astPath algorithm uses (contract point 2): a
 * descendant's nearest JSX ancestor, found by walking up and skipping
 * every non-JSX construct — `JsxExpression`, `CallExpression` (`.map()`
 * callbacks), `ConditionalExpression`, `LogicalExpression`, etc. This is
 * NOT the same as `node.getJsxChildren()` filtered to path-node kinds:
 * that only sees DIRECT array children, missing anything nested inside a
 * dynamic wrapper (`{items.map((i) => <li key={i}>...)}` — the `<li>`'s
 * nearest JSX ancestor is still `node`, even though it isn't a direct
 * `JsxChild` of it). `insert-node`/`move-node`'s `index` must count
 * against this SAME set, or positioning silently desyncs from the
 * astPath numbering the moment a parent has any dynamic-wrapped children
 * alongside static ones (a real bug caught by the property test).
 */
export function getJsxElementChildren(node: Node): Node[] {
  const children: Node[] = [];

  node.forEachDescendant((descendant, traversal) => {
    if (!isJsxPathNode(descendant)) return;

    let ancestor = descendant.getParent();
    while (ancestor && !isJsxPathNode(ancestor)) ancestor = ancestor.getParent();

    if (ancestor === node) children.push(descendant);
    traversal.skip(); // this path-node's own descendants belong to IT, not to `node`
  });

  return children;
}

/**
 * `getJsxElementChildren` returns path-nodes that may be nested several
 * layers inside a dynamic wrapper (`{items.map((i) => <li key={i}>...)}` —
 * the `<li>` counts as a child of `parent` for astPath/index purposes,
 * but it is NOT itself a direct array child of `parent`'s JSX children —
 * splicing new sibling TEXT at the `<li>`'s own start/end position would
 * insert it INSIDE the `.map()` callback (or worse, glue two elements
 * together with no wrapper, invalid JSX — a real bug caught by the
 * property test: "JSX expressions must have one parent element").
 *
 * This walks UP from `pathNode` to the actual direct child of `parent`
 * (the outermost wrapper — e.g. the whole `{items.map(...)}`
 * `JsxExpression`) whose OWN start/end is safe to splice text
 * before/after. For an already-direct/static child, this returns the
 * node itself (no-op).
 */
export function getPositionalBoundaryNode(pathNode: Node, parent: Node): Node {
  let current = pathNode;
  while (current.getParent() !== parent) {
    const next = current.getParent();
    if (!next) return pathNode; // defensive: shouldn't happen if pathNode is truly under parent
    current = next;
  }
  return current;
}

export interface ContainerBodyRange {
  openEnd: number;
  closeStart: number;
}

/** The body range (between opening and closing tag/fragment markers) for
 * a JsxElement or JsxFragment. Throws for a self-closing element (no
 * body) — callers must `ensureContainerElement` first if a body is
 * required. */
export function getContainerBodyRange(node: Node): ContainerBodyRange {
  if (node.getKind() === SyntaxKind.JsxElement) {
    const el = node.asKindOrThrow(SyntaxKind.JsxElement);
    return { openEnd: el.getOpeningElement().getEnd(), closeStart: el.getClosingElement().getStart() };
  }
  if (node.getKind() === SyntaxKind.JsxFragment) {
    const fr = node.asKindOrThrow(SyntaxKind.JsxFragment);
    return { openEnd: fr.getOpeningFragment().getEnd(), closeStart: fr.getClosingFragment().getStart() };
  }
  throw new ApplyOpError('unsupported', 'node has no body (self-closing element) — call ensureContainerElement first');
}

/**
 * Converts a `JsxSelfClosingElement` (`<Foo />`) into an empty
 * `JsxElement` (`<Foo></Foo>`) so it can receive children — the
 * "self-closing conversion" golden case (playbook §4/P3 required cases).
 * No-op (returns the same node) for anything already container-shaped.
 * Uses `Node#replaceWithText`, a real structured ts-morph method that
 * returns the new node at that position — never a whole-file reprint.
 */
export function ensureContainerElement(node: Node): Node {
  if (node.getKind() !== SyntaxKind.JsxSelfClosingElement) return node;
  const selfClosing = node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement);
  const tagName = selfClosing.getTagNameNode().getText();
  const attributesText = selfClosing
    .getAttributes()
    .map((attr) => attr.getText())
    .join(' ');
  const openTag = attributesText ? `<${tagName} ${attributesText}>` : `<${tagName}>`;
  return selfClosing.replaceWithText(`${openTag}</${tagName}>`);
}

export type AttributesOwner = JsxOpeningElement | JsxSelfClosingElement;

/** The node that actually owns JSX attributes for a given path node:
 * a JsxElement's opening element, or a JsxSelfClosingElement itself.
 * JsxFragment has no attributes at all (shorthand `<>` has no
 * openingElement in the AST) — refused as `not-editable`. */
export function getAttributesOwner(node: Node): AttributesOwner {
  if (node.getKind() === SyntaxKind.JsxElement) {
    return node.asKindOrThrow(SyntaxKind.JsxElement).getOpeningElement();
  }
  if (node.getKind() === SyntaxKind.JsxSelfClosingElement) {
    return node.asKindOrThrow(SyntaxKind.JsxSelfClosingElement);
  }
  throw new ApplyOpError('not-editable', 'JSX fragments have no attributes to set/remove — edit in code');
}

/** Walks backward over sibling JsxText nodes that are pure whitespace to
 * find "the sibling immediately before this one, ignoring whitespace
 * formatting" — then checks whether THAT sibling is a comment-only
 * `JsxExpression` (`{/* comment *\/}`, parsed with no `.getExpression()`).
 * Used by `move-node` to keep a leading comment attached to the node it
 * documents when the node moves (playbook §4/P3 required golden case:
 * "moving a node with leading comments"). */
export function findLeadingCommentContainer(node: Node): Node | undefined {
  let sibling = node.getPreviousSibling();
  while (sibling && sibling.getKind() === SyntaxKind.JsxText && sibling.getText().trim() === '') {
    sibling = sibling.getPreviousSibling();
  }
  if (sibling && sibling.getKind() === SyntaxKind.JsxExpression) {
    const container = sibling.asKindOrThrow(SyntaxKind.JsxExpression);
    if (!container.getExpression()) return sibling;
  }
  return undefined;
}

export function isVoidHtmlTag(tag: string): boolean {
  return [
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ].includes(tag);
}
