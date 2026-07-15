import { Node, Project, SyntaxKind } from 'ts-morph';
import type {
  CanvasOp,
  DeleteNodeOp,
  InsertNodeOp,
  MoveNodeOp,
  NodeUid,
  SetClassesOp,
  SetPropOp,
  SetTextOp,
  WrapNodeOp,
} from '@ccs/protocol';
import { ApplyOpError } from './errors.js';
import type { ApplyOpResult } from './apply-op.js';
import { applyOp } from './apply-op.js';
import { formatWithEmbeddedConfig, type FormatOptions } from './prettier-config.js';
import { deriveUidPathsForFile, resolveAstPath } from './uid-path.js';
import {
  getAttributesOwner,
  getContainerBodyRange,
  getJsxChildrenOf,
  getJsxElementChildren,
  getPositionalBoundaryNode,
  ensureContainerElement,
} from './jsx-helpers.js';
import { ensureDesignSystemImport } from './apply-op.js';
import { mergeClassNames } from './tailwind-groups.js';
import {
  insertNodeRemap,
  moveNodeRemap,
  parentAndIndexOf,
  unwrapNodeRemap,
  type AstPathRemap,
} from './uid-remap.js';

/**
 * `invertOp` (ADR-0018 item 9) — computes the inverse of a `CanvasOp`
 * against its PRE-image, for the daemon's (WS-B) undo stack.
 *
 * SCOPE NOTE / CR (flagged, not silently guessed): the frozen `CanvasOp`
 * union (7 ops) cannot losslessly express the inverse of `delete-node` (its
 * `insert-node` counterpart only supports inserting a `ds-component`
 * reference or a bare `element` — never arbitrary captured JSX with real
 * children/attributes/text) or `wrap-node` (there is no "unwrap" op in the
 * 7). Rather than force a lossy approximation into the existing schema,
 * this module exports a small ast-engine-OWNED `InverseOp` union — the 5
 * ops that invert cleanly as themselves, plus two new-but-related shapes
 * (`restore-node`, `unwrap-node`) — and a companion `applyInverseOp` that
 * knows how to apply all of them (delegating to `applyOp` for the 5 plain
 * `CanvasOp` cases). This is additive-only: it does not touch
 * `@ccs/protocol`'s frozen `CanvasOpSchema`.
 *
 * `restore-node.dsImports` (also ast-engine-owned, additive): a
 * `delete-node` on a subtree containing the LAST usage of a
 * `design-system` component prunes that now-unused import
 * (`pruneUnusedDesignSystemImports` in apply-op.ts — a good general
 * clean-up behavior on its own). Undoing that delete must therefore also
 * re-add the import, which a bare captured-text restore can't express —
 * `dsImports` carries the component names the restored text needs.
 */
export type InverseOp =
  | CanvasOp
  | { t: 'restore-node'; parentUid: NodeUid; index: number; text: string; dsImports: string[] }
  | { t: 'unwrap-node'; wrapperUid: NodeUid };

function splitNodeUid(uid: string): { relPath: string; astPath: string } {
  const marker = '.tsx:';
  const idx = uid.indexOf(marker);
  if (idx === -1) throw new ApplyOpError('uid-not-found', `malformed NodeUid: "${uid}"`);
  return { relPath: uid.slice(0, idx + 4), astPath: uid.slice(idx + marker.length) };
}

function resolveOrThrow(sourceFile: ReturnType<Project['createSourceFile']>, astPath: string, uid: string): Node {
  const node = resolveAstPath(sourceFile, astPath);
  if (!node) throw new ApplyOpError('uid-not-found', `no node found for uid "${uid}"`);
  return node;
}

function parseSourceFile(sourceText: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('source.tsx', sourceText);
}

// ---- per-op inverse computation ------------------------------------------

function invertSetText(sourceText: string, op: SetTextOp): CanvasOp {
  const sourceFile = parseSourceFile(sourceText);
  const { astPath } = splitNodeUid(op.uid);
  const node = resolveOrThrow(sourceFile, astPath, op.uid);
  return { t: 'set-text', uid: op.uid, text: readPlainJsxText(node) };
}

function readPlainJsxText(node: Node): string {
  if (node.getKind() === SyntaxKind.JsxSelfClosingElement) return '';
  const children = getJsxChildrenOf(node);
  if (children.length === 0) return '';

  if (children.length === 1) {
    const only = children[0]!;
    if (only.getKind() === SyntaxKind.JsxText) return only.getText();
    if (only.getKind() === SyntaxKind.JsxExpression) {
      const expr = only.asKindOrThrow(SyntaxKind.JsxExpression).getExpression();
      if (expr && Node.isStringLiteral(expr)) return expr.getLiteralText();
    }
  }

  if (children.every((c) => c.getKind() === SyntaxKind.JsxText)) {
    return children.map((c) => c.getText()).join('');
  }

  throw new ApplyOpError(
    'unsupported',
    'invertOp: original body is not plain text — cannot invert set-text losslessly within the CanvasOp schema',
  );
}

function invertSetProp(sourceText: string, op: SetPropOp): CanvasOp {
  const sourceFile = parseSourceFile(sourceText);
  const { astPath } = splitNodeUid(op.uid);
  const node = resolveOrThrow(sourceFile, astPath, op.uid);
  const owner = getAttributesOwner(node);
  const existing = owner.getAttribute(op.name);

  if (!existing) {
    return { t: 'set-prop', uid: op.uid, name: op.name, value: null };
  }
  if (!Node.isJsxAttribute(existing)) {
    throw new ApplyOpError('unsupported', `invertOp: "${op.name}" is a spread attribute, cannot invert`);
  }
  return { t: 'set-prop', uid: op.uid, name: op.name, value: readLiteralAttributeValue(existing) };
}

function readLiteralAttributeValue(attr: Node): string | number | boolean {
  const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
  const init = jsxAttr.getInitializer();
  if (!init) return true;
  if (Node.isStringLiteral(init)) return init.getLiteralText();
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (!expr) throw new ApplyOpError('unsupported', 'invertOp: empty JSX expression attribute value');
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralText();
    if (Node.isNumericLiteral(expr)) return Number(expr.getText());
    if (expr.getKind() === SyntaxKind.TrueKeyword) return true;
    if (expr.getKind() === SyntaxKind.FalseKeyword) return false;
  }
  throw new ApplyOpError('unsupported', 'invertOp: attribute value is not a plain literal');
}

function readClassNameString(node: Node): string {
  const owner = getAttributesOwner(node);
  const classNameAttr = owner.getAttribute('className');
  if (!classNameAttr) return '';
  if (!Node.isJsxAttribute(classNameAttr)) {
    throw new ApplyOpError('unsupported', 'invertOp: className is a spread attribute');
  }
  const init = classNameAttr.getInitializer();
  if (!init) throw new ApplyOpError('unsupported', 'invertOp: className has no value');
  if (Node.isStringLiteral(init)) return init.getLiteralText();
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (expr && (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr))) {
      return expr.getLiteralText();
    }
    if (expr && Node.isCallExpression(expr)) {
      const calleeName = expr.getExpression().getText();
      if (calleeName === 'cn' || calleeName === 'clsx') {
        const firstArg = expr.getArguments()[0];
        if (firstArg && (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg))) {
          return firstArg.getLiteralText();
        }
      }
    }
  }
  throw new ApplyOpError('unsupported', 'invertOp: className is a dynamic expression');
}

function invertSetClasses(sourceText: string, op: SetClassesOp): CanvasOp {
  const sourceFile = parseSourceFile(sourceText);
  const { astPath } = splitNodeUid(op.uid);
  const node = resolveOrThrow(sourceFile, astPath, op.uid);
  const originalClassString = readClassNameString(node);

  // Simulate the forward merge (pure, no mutation) to know the post-image
  // class list, then build an inverse that clears everything and restores
  // the exact original list (in original order) — see module doc in
  // apply-op.ts's set-classes handler for why order-preservation matters.
  const mergedClassString = mergeClassNames(originalClassString, op.add, op.remove);
  const originalList = originalClassString.split(/\s+/).filter(Boolean);
  const mergedList = mergedClassString.split(/\s+/).filter(Boolean);

  return { t: 'set-classes', uid: op.uid, add: originalList, remove: mergedList };
}

function invertInsertNode(sourceText: string, op: InsertNodeOp): DeleteNodeOp {
  const sourceFile = parseSourceFile(sourceText);
  const { relPath, astPath: parentAstPath } = splitNodeUid(op.parentUid);
  const parentNode = resolveOrThrow(sourceFile, parentAstPath, op.parentUid);

  // `insert-node` into a self-closing parent converts it to a container
  // (`<Card />` -> `<Card></Card>`, playbook "self-closing conversion"
  // case) — a ONE-WAY transformation. `delete-node` can remove the
  // inserted child again, but cannot re-collapse the parent back to
  // self-closing, so a byte-identical undo isn't representable here.
  // Flagged CR, not silently lossy: refuse rather than produce an inverse
  // that looks plausible but doesn't actually restore the original text.
  if (parentNode.getKind() === SyntaxKind.JsxSelfClosingElement) {
    throw new ApplyOpError(
      'unsupported',
      'invertOp: insert-node into a self-closing parent cannot be losslessly inverted (the container conversion is one-way)',
    );
  }

  const childCount = getJsxElementChildren(parentNode).length;
  const clampedIndex = Math.max(0, Math.min(op.index, childCount));
  const candidateInverse: DeleteNodeOp = { t: 'delete-node', uid: `${relPath}:${parentAstPath}.${clampedIndex}` as NodeUid };

  // FOURTH invert bug found by the strengthened property test — a SEPARATE,
  // more general one-way formatting transformation than the self-closing
  // case above: prettier's JSX child layout is not always reversible.
  // Inserting a node can force a parent from a single-line/tightly-packed
  // child layout to a multi-line one (a 3rd child no longer fits inline, or
  // an inserted element no longer sits flush against adjacent JsxText);
  // deleting that same node again removes exactly the inserted text but
  // prettier does NOT re-collapse the remaining siblings back onto one
  // line/flush against each other once that break has been introduced —
  // this is deliberate prettier JSX-whitespace-sensitivity behavior, not an
  // ast-engine astPath/whitespace-range bug, and no amount of deletion-range
  // adjustment can undo a formatting decision prettier won't reverse.
  // Rather than guess whether THIS insertion point is safe, verify it: run
  // the actual forward op + candidate inverse (both already-frozen,
  // side-effect-free functions) and refuse if the round trip doesn't
  // restore byte-identical — "refuse, don't silently lose" (ADR-0019 CR 4),
  // applied by construction instead of by enumerating every unsafe shape.
  const forward = applyOp(sourceText, op);
  const roundTrip = applyOp(forward.newText, candidateInverse);
  if (roundTrip.newText !== sourceText) {
    throw new ApplyOpError(
      'unsupported',
      'invertOp: insert-node cannot be losslessly inverted here — prettier will not re-collapse the ' +
        'formatting change this insertion introduces once the inserted node is deleted again',
    );
  }

  return candidateInverse;
}

/** Which `design-system`-imported component names are used (as a JSX tag)
 * anywhere within `node`'s own subtree — used to know what `restore-node`
 * needs to re-import after undoing a delete (see `dsImports` doc above). */
function designSystemTagNamesWithin(sourceFile: ReturnType<typeof parseSourceFile>, node: Node): string[] {
  const importDecl = sourceFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === 'design-system');
  if (!importDecl) return [];
  const importedNames = new Set(importDecl.getNamedImports().map((ni) => ni.getName()));

  const found = new Set<string>();
  const record = (tagName: string) => {
    if (importedNames.has(tagName)) found.add(tagName);
  };
  if (Node.isJsxElement(node)) record(node.getOpeningElement().getTagNameNode().getText());
  if (Node.isJsxSelfClosingElement(node)) record(node.getTagNameNode().getText());
  for (const el of node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) record(el.getTagNameNode().getText());
  for (const el of node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) record(el.getTagNameNode().getText());
  return [...found];
}

function invertDeleteNode(
  sourceText: string,
  op: DeleteNodeOp,
): { t: 'restore-node'; parentUid: NodeUid; index: number; text: string; dsImports: string[] } {
  const sourceFile = parseSourceFile(sourceText);
  const { relPath, astPath } = splitNodeUid(op.uid);
  const node = resolveOrThrow(sourceFile, astPath, op.uid);
  const { parentAstPath, index } = parentAndIndexOf(astPath);

  return {
    t: 'restore-node',
    parentUid: `${relPath}:${parentAstPath}` as NodeUid,
    index,
    text: node.getText(),
    dsImports: designSystemTagNamesWithin(sourceFile, node),
  };
}

function invertMoveNode(sourceText: string, op: MoveNodeOp): MoveNodeOp {
  const sourceFile = parseSourceFile(sourceText);
  const { relPath, astPath: targetAstPath } = splitNodeUid(op.uid);
  const { astPath: newParentAstPath } = splitNodeUid(op.newParentUid);
  const { parentAstPath: originalParentAstPath, index: originalIndex } = parentAndIndexOf(targetAstPath);

  // SECOND invert bug found by the strengthened property test/golden suite
  // (move-node-05-to-self-closing-parent): moving a node INTO a self-closing
  // parent converts it to a container (`<Card />` -> `<Card>...</Card>`,
  // same one-way transformation `invertInsertNode` already refuses above).
  // Moving the child back out again cannot un-convert the container back to
  // self-closing, so a byte-identical undo isn't representable — refuse
  // rather than silently leave `<Card></Card>` behind. Checked against the
  // PRE-image (this function's `sourceText`), i.e. the parent's state
  // BEFORE the forward move that's being inverted.
  const newParentNodePreImage = resolveOrThrow(sourceFile, newParentAstPath, op.newParentUid);
  if (newParentNodePreImage.getKind() === SyntaxKind.JsxSelfClosingElement) {
    throw new ApplyOpError(
      'unsupported',
      'invertOp: move-node into a self-closing parent cannot be losslessly inverted (the container conversion is one-way)',
    );
  }

  // THIRD invert bug found by the strengthened property test: `applyOp`'s
  // real forward move (`applyMoveNodeOp` in apply-op.ts) never uses
  // `op.index` raw — it CLAMPS it against the new parent's existing
  // element-children count (excluding the target itself, since the target
  // isn't one of "the OTHER siblings" being indexed against): `clampedIndex
  // = max(0, min(op.index, siblingsExcludingTarget.length))`. `applyOp`'s
  // own `uidRemap` is built from that CLAMPED index. Computing the inverse
  // with the raw, unclamped `op.index` instead derives a moved-subtree
  // destination prefix that doesn't match where `applyOp` actually put the
  // node — landing on a sibling-index that may not exist in the POST-image
  // at all (`ApplyOpError('uid-not-found')`). Must replicate the exact same
  // clamp here, against the SAME pre-image, to compute the SAME remap
  // `applyOp` did.
  const targetNode = resolveOrThrow(sourceFile, targetAstPath, op.uid);
  const siblingsExcludingTarget = getJsxElementChildren(newParentNodePreImage).filter((c) => c !== targetNode);
  const clampedIndex = Math.max(0, Math.min(op.index, siblingsExcludingTarget.length));

  const preAstPaths = deriveUidPathsForFile(sourceFile).map((e) => e.astPath);
  const remap = moveNodeRemap(preAstPaths, targetAstPath, newParentAstPath, clampedIndex);
  const newAstPathOfMovedNode = remap.get(targetAstPath) ?? targetAstPath;

  // BUG (fixed here): `originalParentAstPath` is a PRE-image astPath. The
  // inverse is APPLIED against the POST-image (the output of this forward
  // move), so the restore-parent uid must be expressed in POST-image
  // coordinates too. A cross-parent (reparenting) move can shift the OLD
  // parent's OWN astPath — not just the moved node's — whenever the OLD
  // parent's ancestor chain passes through a sibling index that the
  // insertion side of the move bumps (e.g. moving a deeply-nested node OUT
  // to an ANCESTOR at an index before that ancestor chain: the old parent,
  // several levels up from the removal site, is itself a later sibling
  // under the insertion point and shifts by the same +1 that the moved
  // node's other siblings get). Naively string-slicing the PRE-image
  // astPath for the old parent (as this used to do) then resolves against
  // the POST-image tree and either hits a stale/wrong node or nothing at
  // all (`ApplyOpError('uid-not-found')`). `moveNodeRemap` already computes
  // exactly this shift for every surviving astPath (it's the same function
  // `applyOp`'s forward move uses to build its own `uidRemap`), so reusing
  // it here for the OLD parent's astPath — not just the moved node's — is
  // both correct and consistent with the one true remap computation.
  const postImageOldParentAstPath = remap.get(originalParentAstPath) ?? originalParentAstPath;

  return {
    t: 'move-node',
    uid: `${relPath}:${newAstPathOfMovedNode}` as NodeUid,
    newParentUid: `${relPath}:${postImageOldParentAstPath}` as NodeUid,
    index: originalIndex,
  };
}

function invertWrapNode(sourceText: string, op: WrapNodeOp): { t: 'unwrap-node'; wrapperUid: NodeUid } {
  parseSourceFile(sourceText); // validated for parseability; no further reads needed
  const { relPath, astPath: firstAstPath } = splitNodeUid(op.uids[0]!);
  const targetAstPaths = op.uids.map((uid) => splitNodeUid(uid).astPath);
  const { parentAstPath } = parentAndIndexOf(firstAstPath);
  const indices = targetAstPaths.map((p) => parentAndIndexOf(p).index).sort((a, b) => a - b);
  return { t: 'unwrap-node', wrapperUid: `${relPath}:${parentAstPath}.${indices[0]}` as NodeUid };
}

/**
 * Computes the inverse of `op` against `sourceText` (the PRE-image, BEFORE
 * `op` is applied) — ADR-0018 item 9. Apply the result with
 * `applyInverseOp` against the POST-image to restore the PRE-image
 * byte-identically (the property test asserts exactly this).
 */
export function invertOp(sourceText: string, op: CanvasOp): InverseOp {
  switch (op.t) {
    case 'set-text':
      return invertSetText(sourceText, op);
    case 'set-prop':
      return invertSetProp(sourceText, op);
    case 'set-classes':
      return invertSetClasses(sourceText, op);
    case 'insert-node':
      return invertInsertNode(sourceText, op);
    case 'delete-node':
      return invertDeleteNode(sourceText, op);
    case 'move-node':
      return invertMoveNode(sourceText, op);
    case 'wrap-node':
      return invertWrapNode(sourceText, op);
  }
}

// ---- applying an InverseOp ------------------------------------------------

function buildRemapRecord(relPath: string, astRemap: AstPathRemap): Record<string, string> {
  const uidRemap: Record<string, string> = {};
  for (const [oldAstPath, newAstPath] of astRemap) {
    uidRemap[`${relPath}:${oldAstPath}`] = `${relPath}:${newAstPath}`;
  }
  return uidRemap;
}

function applyRestoreNode(
  sourceText: string,
  op: { parentUid: NodeUid; index: number; text: string; dsImports: string[] },
  opts?: FormatOptions,
): ApplyOpResult {
  const sourceFile = parseSourceFile(sourceText);
  const { relPath, astPath: parentAstPath } = splitNodeUid(op.parentUid);
  const preAstPaths = deriveUidPathsForFile(sourceFile).map((e) => e.astPath);

  const parentNode = ensureContainerElement(resolveOrThrow(sourceFile, parentAstPath, op.parentUid));
  const elementChildren = getJsxElementChildren(parentNode);
  const clampedIndex = Math.max(0, Math.min(op.index, elementChildren.length));

  let insertPos: number;
  if (elementChildren.length === 0) {
    insertPos = getContainerBodyRange(parentNode).openEnd;
  } else if (clampedIndex >= elementChildren.length) {
    insertPos = getPositionalBoundaryNode(elementChildren[elementChildren.length - 1]!, parentNode).getEnd();
  } else {
    insertPos = getPositionalBoundaryNode(elementChildren[clampedIndex]!, parentNode).getStart();
  }

  sourceFile.insertText(insertPos, op.text);
  for (const name of op.dsImports) ensureDesignSystemImport(sourceFile, name);

  const astRemap = insertNodeRemap(preAstPaths, parentAstPath, clampedIndex);
  const newText = formatWithEmbeddedConfig(sourceFile.getFullText(), opts);
  return { newText, uidRemap: buildRemapRecord(relPath, astRemap) };
}

function applyUnwrapNode(sourceText: string, op: { wrapperUid: NodeUid }, opts?: FormatOptions): ApplyOpResult {
  const sourceFile = parseSourceFile(sourceText);
  const { relPath, astPath: wrapperAstPath } = splitNodeUid(op.wrapperUid);
  const preAstPaths = deriveUidPathsForFile(sourceFile).map((e) => e.astPath);

  const wrapperNode = resolveOrThrow(sourceFile, wrapperAstPath, op.wrapperUid);
  const { openEnd, closeStart } = getContainerBodyRange(wrapperNode);
  const childCount = getJsxElementChildren(wrapperNode).length;
  const innerText = sourceFile.getFullText().slice(openEnd, closeStart);

  wrapperNode.replaceWithText(innerText.trim());

  const { parentAstPath, index: wrapperIndex } = parentAndIndexOf(wrapperAstPath);
  const astRemap = unwrapNodeRemap(preAstPaths, parentAstPath, wrapperIndex, childCount);
  const newText = formatWithEmbeddedConfig(sourceFile.getFullText(), opts);
  return { newText, uidRemap: buildRemapRecord(relPath, astRemap) };
}

/** Applies an `InverseOp` — a plain `CanvasOp` delegates to `applyOp`;
 * `restore-node`/`unwrap-node` (ast-engine's own extension, see module
 * doc) have dedicated handling since they can't round-trip through the
 * frozen `CanvasOp` union. */
export function applyInverseOp(sourceText: string, inverseOp: InverseOp, opts?: FormatOptions): ApplyOpResult {
  if (inverseOp.t === 'restore-node') return applyRestoreNode(sourceText, inverseOp, opts);
  if (inverseOp.t === 'unwrap-node') return applyUnwrapNode(sourceText, inverseOp, opts);
  return applyOp(sourceText, inverseOp, opts);
}
