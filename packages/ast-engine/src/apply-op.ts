import { Node, Project, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { CanvasOp, InsertNodeOp, MoveNodeOp, WrapNodeOp } from '@ccs/protocol';
import { ApplyOpError } from './errors.js';
import { formatWithEmbeddedConfig, type FormatOptions } from './prettier-config.js';
import { deriveUidPathsForFile, resolveAstPath } from './uid-path.js';
import { isDynamicJsxNode } from './dynamic.js';
import { mergeClassNames } from './tailwind-groups.js';
import {
  ensureContainerElement,
  getAttributesOwner,
  getContainerBodyRange,
  getJsxElementChildren,
  getPositionalBoundaryNode,
  findLeadingCommentContainer,
  isVoidHtmlTag,
} from './jsx-helpers.js';
import { quoteStringLiteralValue, renderJsxTextBody } from './jsx-text.js';
import {
  deleteNodeRemap,
  insertNodeRemap,
  moveNodeRemap,
  parentAndIndexOf,
  wrapNodeRemap,
  type AstPathRemap,
} from './uid-remap.js';

export interface ApplyOpResult {
  newText: string;
  uidRemap: Record<string, string>;
}

// Re-exported so consumers only need `import { ApplyOpError } from
// '@ccs/ast-engine'` (ADR-0018 item 2: additive new export).
export { ApplyOpError } from './errors.js';
export type { ApplyOpErrorCode } from './errors.js';

// ---- NodeUid <-> {relPath, astPath} -----------------------------------

function splitNodeUid(uid: string): { relPath: string; astPath: string } {
  const marker = '.tsx:';
  const idx = uid.indexOf(marker);
  if (idx === -1) {
    throw new ApplyOpError('uid-not-found', `malformed NodeUid (expected "<relPath>.tsx:<astPath>"): "${uid}"`);
  }
  return { relPath: uid.slice(0, idx + 4), astPath: uid.slice(idx + marker.length) };
}

function primaryRelPathOf(op: CanvasOp): string {
  switch (op.t) {
    case 'set-text':
    case 'set-prop':
    case 'set-classes':
    case 'delete-node':
    case 'move-node':
      return splitNodeUid(op.uid).relPath;
    case 'insert-node':
      return splitNodeUid(op.parentUid).relPath;
    case 'wrap-node':
      return splitNodeUid(op.uids[0]!).relPath;
  }
}

function resolveOrThrow(sourceFile: SourceFile, astPath: string, uid: string): Node {
  const node = resolveAstPath(sourceFile, astPath);
  if (!node) throw new ApplyOpError('uid-not-found', `no node found for uid "${uid}"`);
  return node;
}

function assertNotDynamic(node: Node, uid: string): void {
  if (isDynamicJsxNode(node)) {
    throw new ApplyOpError(
      'dynamic-locked',
      `"${uid}" is inside dynamic (map/ternary/&&) JSX — this is real code, edit it in the IDE`,
    );
  }
}

function isNodeDescendantOf(node: Node, maybeAncestor: Node): boolean {
  let current = node.getParent();
  while (current) {
    if (current === maybeAncestor) return true;
    current = current.getParent();
  }
  return false;
}

// ---- set-text -----------------------------------------------------------

function applySetTextOp(node: Node, text: string): void {
  const body = renderJsxTextBody(text);

  if (node.getKind() === SyntaxKind.JsxElement) {
    node.asKindOrThrow(SyntaxKind.JsxElement).setBodyText(body);
    return;
  }
  if (node.getKind() === SyntaxKind.JsxFragment) {
    const { openEnd, closeStart } = getContainerBodyRange(node);
    node.getSourceFile().replaceText([openEnd, closeStart], body);
    return;
  }
  throw new ApplyOpError('not-editable', 'cannot set text on a self-closing element (no body)');
}

// ---- set-prop -------------------------------------------------------------

function isTokenRefValue(value: unknown): value is { token: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'token' in value &&
    typeof (value as { token: unknown }).token === 'string'
  );
}

/** Is this JsxAttribute's CURRENT value something we consider "safe to
 * overwrite" — a plain literal, not arbitrary code (a function reference,
 * an expression, a spread)? Protects business-logic props (`onClick={...}`)
 * from being silently clobbered by a canvas literal write. */
function isSimpleLiteralInitializer(attr: Node): boolean {
  const jsxAttr = attr.asKindOrThrow(SyntaxKind.JsxAttribute);
  const init = jsxAttr.getInitializer();
  if (!init) return true; // boolean shorthand (no initializer) — safe
  if (Node.isStringLiteral(init)) return true;
  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (!expr) return true; // empty `{}` — edge case, treat as overwritable
    if (Node.isNumericLiteral(expr) || Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
      return true;
    }
    const kind = expr.getKind();
    return kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword;
  }
  return false;
}

function attributeInitializerText(value: string | number | boolean): string | undefined {
  if (value === true) return undefined; // shorthand boolean attribute
  if (typeof value === 'boolean') return '{false}';
  if (typeof value === 'number') return `{${value}}`;
  return quoteStringLiteralValue(value);
}

function applySetPropOp(node: Node, name: string, value: unknown): void {
  const owner = getAttributesOwner(node); // throws not-editable for JsxFragment
  const existing = owner.getAttribute(name);

  if (value === null) {
    if (existing && Node.isJsxAttribute(existing)) existing.remove();
    return; // absent or a spread attribute — nothing to remove, no-op
  }

  if (isTokenRefValue(value)) {
    // ADR-0018 item 12: minimally handle or refuse `unsupported` — full
    // token->class/var mapping needs the P4 token pipeline, which this
    // zero-IO pure library does not have access to. Flagged CR, not
    // silently guessed.
    throw new ApplyOpError('unsupported', `set-prop with a {token} value ("${name}") is P4 scope`);
  }

  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ApplyOpError(
      'not-editable',
      `set-prop only supports string/number/boolean literal values, not arrays/objects ("${name}")`,
    );
  }

  if (existing) {
    if (!Node.isJsxAttribute(existing)) {
      throw new ApplyOpError('not-editable', `"${name}" comes from a spread attribute — edit in code`);
    }
    if (!isSimpleLiteralInitializer(existing)) {
      throw new ApplyOpError('not-editable', `"${name}" currently holds a non-literal expression — edit in code`);
    }
    const initText = attributeInitializerText(value);
    if (initText === undefined) existing.removeInitializer();
    else existing.setInitializer(initText);
    return;
  }

  const initText = attributeInitializerText(value);
  owner.addAttribute(initText === undefined ? { name } : { name, initializer: initText });
}

// ---- set-classes ----------------------------------------------------------

function applySetClassesOp(node: Node, add: readonly string[], remove: readonly string[]): void {
  const owner = getAttributesOwner(node); // throws not-editable for JsxFragment
  const classNameAttr = owner.getAttribute('className');

  if (!classNameAttr) {
    const merged = mergeClassNames('', add, remove);
    if (merged) owner.addAttribute({ name: 'className', initializer: quoteStringLiteralValue(merged) });
    return;
  }

  if (!Node.isJsxAttribute(classNameAttr)) {
    throw new ApplyOpError('not-editable', 'className is a spread attribute — edit in code');
  }

  const init = classNameAttr.getInitializer();
  if (!init) {
    throw new ApplyOpError('not-editable', 'className has no value to merge into');
  }

  if (Node.isStringLiteral(init)) {
    const merged = mergeClassNames(init.getLiteralText(), add, remove);
    if (merged) classNameAttr.setInitializer(quoteStringLiteralValue(merged));
    else classNameAttr.remove();
    return;
  }

  if (Node.isJsxExpression(init)) {
    const expr = init.getExpression();
    if (!expr) throw new ApplyOpError('not-editable', 'className expression is empty');

    if (Node.isNoSubstitutionTemplateLiteral(expr) || Node.isStringLiteral(expr)) {
      const merged = mergeClassNames(expr.getLiteralText(), add, remove);
      expr.replaceWithText(quoteStringLiteralValue(merged));
      return;
    }

    if (Node.isCallExpression(expr)) {
      const calleeName = expr.getExpression().getText();
      if (calleeName === 'cn' || calleeName === 'clsx') {
        const firstArg = expr.getArguments()[0];
        if (firstArg && (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg))) {
          const merged = mergeClassNames(firstArg.getLiteralText(), add, remove);
          firstArg.replaceWithText(quoteStringLiteralValue(merged));
          return;
        }
        throw new ApplyOpError(
          'not-editable',
          `${calleeName}() first argument is not a plain string literal — edit in code`,
        );
      }
    }

    // playbook §4/P3 pitfall #2: a fully-dynamic className disables style
    // controls entirely (ternary, identifier reference, template literal
    // WITH substitutions, any other call expression, etc.).
    throw new ApplyOpError('not-editable', 'className is a dynamic expression — edit in code');
  }

  throw new ApplyOpError('not-editable', 'className has an unsupported initializer shape');
}

// ---- insert-node ------------------------------------------------------

function buildInsertSourceText(source: InsertNodeOp['source']): { text: string; dsImportName?: string } {
  if (source.kind === 'ds-component') {
    // "required props defaulted" (playbook §4/P3): CR flagged (see report)
    // — ast-engine is a pure, zero-IO library with no access to the DS
    // package's prop schema (that introspection is P4's ComponentsPanel
    // job: "extracts props schema from TS types"). We emit a bare
    // self-closing tag + the auto-added import; true required-prop
    // defaulting needs a schema input this API doesn't receive yet.
    return { text: `<${source.name} />`, dsImportName: source.name };
  }

  const classesAttr = source.classes ? ` className=${quoteStringLiteralValue(source.classes)}` : '';
  if (isVoidHtmlTag(source.tag)) {
    return { text: `<${source.tag}${classesAttr} />` };
  }
  return { text: `<${source.tag}${classesAttr}></${source.tag}>` };
}

export function ensureDesignSystemImport(sourceFile: SourceFile, name: string): void {
  // playbook §4/P3 pitfall #4: ALWAYS the `design-system` package alias,
  // NEVER a relative path into the DS package.
  const existing = sourceFile.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === 'design-system',
  );
  if (existing) {
    if (!existing.getNamedImports().some((ni) => ni.getName() === name)) {
      existing.addNamedImport(name);
    }
    return;
  }
  sourceFile.addImportDeclaration({ moduleSpecifier: 'design-system', namedImports: [name] });
}

function applyInsertNodeOp(sourceFile: SourceFile, op: InsertNodeOp, preAstPaths: readonly string[]): AstPathRemap {
  const { astPath: parentAstPath } = splitNodeUid(op.parentUid);
  const parentNodeOriginal = resolveOrThrow(sourceFile, parentAstPath, op.parentUid);
  assertNotDynamic(parentNodeOriginal, op.parentUid);

  const parentNode = ensureContainerElement(parentNodeOriginal);
  const elementChildren = getJsxElementChildren(parentNode);
  const clampedIndex = Math.max(0, Math.min(op.index, elementChildren.length));

  const { text: newNodeText, dsImportName } = buildInsertSourceText(op.source);

  let insertPos: number;
  if (elementChildren.length === 0) {
    insertPos = getContainerBodyRange(parentNode).openEnd;
  } else if (clampedIndex >= elementChildren.length) {
    insertPos = getPositionalBoundaryNode(elementChildren[elementChildren.length - 1]!, parentNode).getEnd();
  } else {
    insertPos = getPositionalBoundaryNode(elementChildren[clampedIndex]!, parentNode).getStart();
  }

  sourceFile.insertText(insertPos, newNodeText);
  if (dsImportName) ensureDesignSystemImport(sourceFile, dsImportName);

  return insertNodeRemap(preAstPaths, parentAstPath, clampedIndex);
}

// ---- delete-node --------------------------------------------------------

/** A node's own [start,end] range, extended to also consume an
 * immediately-following whitespace-only JsxText sibling — otherwise
 * deleting a node leaves a stray blank line behind (the whitespace before
 * AND the whitespace after both survive, prettier treats the doubled gap
 * as a deliberate blank line). Consuming the TRAILING gap (not the
 * leading one) keeps this independent of `findLeadingCommentContainer`'s
 * use of the leading gap for move/wrap. */
function getDeletionRange(node: Node): { start: number; end: number } {
  const start = node.getStart();
  let end = node.getEnd();
  const next = node.getNextSibling();
  if (next && next.getKind() === SyntaxKind.JsxText && next.getText().trim() === '') {
    end = next.getEnd();
  }
  return { start, end };
}

/** Mirror of `ensureDesignSystemImport`: after deleting a node, if that
 * was the LAST JSX usage of a `design-system`-imported component, remove
 * the now-unused named import (and the whole import declaration if it's
 * now empty) — keeps deletes clean AND makes `delete-node` a correct
 * inverse of `insert-node` (which auto-adds the import) without needing
 * any extra field on the frozen `DeleteNodeOp` schema. */
function getDesignSystemImport(sourceFile: SourceFile) {
  return sourceFile.getImportDeclaration((d) => d.getModuleSpecifierValue() === 'design-system');
}

function pruneUnusedDesignSystemImports(sourceFile: SourceFile): void {
  const initialImportDecl = getDesignSystemImport(sourceFile);
  if (!initialImportDecl) return;

  const usedTagNames = new Set<string>();
  for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement)) {
    usedTagNames.add(el.getTagNameNode().getText());
  }
  for (const el of sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)) {
    usedTagNames.add(el.getTagNameNode().getText());
  }

  const namesToRemove = initialImportDecl
    .getNamedImports()
    .map((ni) => ni.getName())
    .filter((name) => !usedTagNames.has(name));

  for (const name of namesToRemove) {
    // Re-fetch fresh EVERY iteration: removing one named-import specifier
    // can forget sibling specifiers' (and the parent declaration's) own
    // previously-held references — the same "forgetting" behavior
    // documented in uid-remap.ts's module doc for JSX manipulations,
    // apparently also true of this structured import-specifier removal.
    const importDecl = getDesignSystemImport(sourceFile);
    if (!importDecl) return;
    const spec = importDecl.getNamedImports().find((ni) => ni.getName() === name);
    spec?.remove();
  }

  const importDecl = getDesignSystemImport(sourceFile);
  if (!importDecl) return;

  if (
    importDecl.getNamedImports().length === 0 &&
    !importDecl.getDefaultImport() &&
    !importDecl.getNamespaceImport()
  ) {
    // Verified empirically (two cases): when this import is the ONLY
    // statement before it, plain `.remove()` cleans up perfectly. When
    // there's a PRECEDING import, `.remove()` leaves behind the blank
    // line `addImportDeclaration` inserted after this import when it was
    // first created — a real bug (caught by the property test's
    // invert-round-trip check). Fix: compute the desired final text with
    // plain string slicing (not a targeted `replaceText` range call,
    // which crashed ts-morph's incremental tree-patcher in some
    // positions — "Error replacing tree"), then hand the WHOLE text back
    // via `replaceWithText` on the source file itself — a full, clean
    // reparse, not the AST default printer (the text is still 99.9%
    // untouched original source, just missing one import line and one
    // stray blank line).
    const fullText = sourceFile.getFullText();
    // `getStart()` skips LEADING trivia, so `fullText.slice(0, start)`
    // already ends with whatever newline(s) separated the PRECEDING
    // statement from this import — that's the separator we want to keep.
    // Consuming every trailing newline after the import's own end (its
    // own line-ending newline AND any further blank-line newline) and
    // replacing them with NOTHING lets the preceding slice's own trailing
    // newline be the sole separator — exactly one newline, never a blank
    // line, regardless of whether 1 or 2+ newlines followed the import.
    const start = importDecl.getStart();
    let end = importDecl.getEnd();
    while (fullText[end] === '\n') end++;
    const newFullText = fullText.slice(0, start) + fullText.slice(end);
    sourceFile.replaceWithText(newFullText);
    return;
  }
}

function applyDeleteNodeOp(sourceFile: SourceFile, astPath: string, uid: string, preAstPaths: readonly string[]): AstPathRemap {
  const node = resolveOrThrow(sourceFile, astPath, uid);
  assertNotDynamic(node, uid);
  const { start, end } = getDeletionRange(node);
  sourceFile.replaceText([start, end], '');
  pruneUnusedDesignSystemImports(sourceFile);
  return deleteNodeRemap(preAstPaths, astPath);
}

// ---- move-node ----------------------------------------------------------

function applyMoveNodeOp(sourceFile: SourceFile, op: MoveNodeOp, preAstPaths: readonly string[]): AstPathRemap {
  const { relPath: targetRelPath, astPath: targetAstPath } = splitNodeUid(op.uid);
  const { relPath: newParentRelPath, astPath: newParentAstPath } = splitNodeUid(op.newParentUid);

  if (targetRelPath !== newParentRelPath) {
    throw new ApplyOpError('unsupported', 'cross-file move-node is not supported by this single-file applyOp');
  }

  const targetNode = resolveOrThrow(sourceFile, targetAstPath, op.uid);
  assertNotDynamic(targetNode, op.uid);

  let newParentNode = resolveOrThrow(sourceFile, newParentAstPath, op.newParentUid);
  assertNotDynamic(newParentNode, op.newParentUid);

  if (newParentNode === targetNode || isNodeDescendantOf(newParentNode, targetNode)) {
    throw new ApplyOpError('unsupported', 'cannot move a node into its own subtree');
  }

  // A self-closing element can never contain descendants, so converting it
  // here can never invalidate `targetNode`'s NODE IDENTITY (proven safe
  // empirically — see uid-remap.ts module doc). It DOES, however, change
  // the file's text length (`<Card />` -> `<Card></Card>`), which shifts
  // the raw byte OFFSETS of everything after it — including `targetNode`
  // if it comes later in the file. Do this conversion FIRST, then read
  // `targetNode`'s position fresh (a live Node reference self-corrects;
  // a plain number captured before the shift would not — this was a real
  // bug caught by the golden generator, see move-node-05 in the report).
  newParentNode = ensureContainerElement(newParentNode);

  // Capture the moved unit (target + optional leading standalone comment,
  // playbook §4/P3 required golden case: "moving a node with leading
  // comments") — positions read fresh, AFTER the possible conversion above.
  const commentContainer = findLeadingCommentContainer(targetNode);
  const unitStart = (commentContainer ?? targetNode).getStart();
  // Consume a trailing whitespace-only sibling too (getDeletionRange),
  // otherwise the OLD location is left with a stray blank line — same
  // fix as delete-node, see its comment.
  const unitEnd = getDeletionRange(targetNode).end;
  const unitText = sourceFile.getFullText().slice(unitStart, targetNode.getEnd());

  const siblingsExcludingTarget = getJsxElementChildren(newParentNode).filter((c) => c !== targetNode);
  const clampedIndex = Math.max(0, Math.min(op.index, siblingsExcludingTarget.length));

  let insertPos: number;
  if (siblingsExcludingTarget.length === 0) {
    insertPos = getContainerBodyRange(newParentNode).openEnd;
  } else if (clampedIndex >= siblingsExcludingTarget.length) {
    insertPos = getPositionalBoundaryNode(
      siblingsExcludingTarget[siblingsExcludingTarget.length - 1]!,
      newParentNode,
    ).getEnd();
  } else {
    insertPos = getPositionalBoundaryNode(siblingsExcludingTarget[clampedIndex]!, newParentNode).getStart();
  }

  // Apply in descending-position order so each pre-computed offset is
  // still valid when it runs (neither `SourceFile#insertText` nor
  // `#replaceText` preserve OTHER nodes' identity/position bookkeeping
  // across the call — see uid-remap.ts).
  if (insertPos >= unitEnd) {
    sourceFile.insertText(insertPos, unitText);
    sourceFile.replaceText([unitStart, unitEnd], '');
  } else {
    sourceFile.replaceText([unitStart, unitEnd], '');
    sourceFile.insertText(insertPos, unitText);
  }

  return moveNodeRemap(preAstPaths, targetAstPath, newParentAstPath, clampedIndex);
}

// ---- wrap-node ------------------------------------------------------------

function applyWrapNodeOp(sourceFile: SourceFile, op: WrapNodeOp, preAstPaths: readonly string[]): AstPathRemap {
  const targetAstPaths = op.uids.map((uid) => splitNodeUid(uid).astPath);
  const targetNodes = targetAstPaths.map((astPath, i) => resolveOrThrow(sourceFile, astPath, op.uids[i]!));

  targetNodes.forEach((node, i) => assertNotDynamic(node, op.uids[i]!));

  const parentAstPaths = targetAstPaths.map((astPath) => parentAndIndexOf(astPath).parentAstPath);
  if (new Set(parentAstPaths).size > 1) {
    throw new ApplyOpError('unsupported', 'wrap-node requires all uids to share the same parent');
  }
  const parentAstPath = parentAstPaths[0]!;

  const indices = targetAstPaths.map((astPath) => parentAndIndexOf(astPath).index).sort((a, b) => a - b);
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1]! + 1);
  if (!isContiguous) {
    throw new ApplyOpError('unsupported', 'wrap-node requires a contiguous sibling range');
  }

  const sortedNodes = [...targetNodes].sort((a, b) => a.getStart() - b.getStart());
  const firstNode = sortedNodes[0]!;
  const lastNode = sortedNodes[sortedNodes.length - 1]!;

  const commentContainer = findLeadingCommentContainer(firstNode);
  const rangeStart = (commentContainer ?? firstNode).getStart();
  const rangeEnd = lastNode.getEnd();
  const innerText = sourceFile.getFullText().slice(rangeStart, rangeEnd);

  const classAttr = op.wrapper.classes ? ` className=${quoteStringLiteralValue(op.wrapper.classes)}` : '';
  const wrapperText = `<div${classAttr}>\n${innerText}\n</div>`;
  sourceFile.replaceText([rangeStart, rangeEnd], wrapperText);

  return wrapNodeRemap(preAstPaths, parentAstPath, indices);
}

// ---- main entrypoint ----------------------------------------------------

/**
 * applyOp — pure, zero-IO codemod entrypoint (ADR-0018, frozen interface).
 * ts-morph structured manipulations + a single final prettier pass —
 * NEVER the AST default printer for the whole file (playbook §4/P3
 * pitfall #1). Genuinely synchronous (see `prettier-sync.ts`).
 */
export function applyOp(sourceText: string, op: CanvasOp, opts?: FormatOptions): ApplyOpResult {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('source.tsx', sourceText);

  const relPath = primaryRelPathOf(op);
  const preAstPaths = deriveUidPathsForFile(sourceFile).map((entry) => entry.astPath);

  let astRemap: AstPathRemap;

  switch (op.t) {
    case 'set-text': {
      const { astPath } = splitNodeUid(op.uid);
      const node = resolveOrThrow(sourceFile, astPath, op.uid);
      assertNotDynamic(node, op.uid);
      applySetTextOp(node, op.text);
      astRemap = new Map();
      break;
    }
    case 'set-prop': {
      const { astPath } = splitNodeUid(op.uid);
      const node = resolveOrThrow(sourceFile, astPath, op.uid);
      assertNotDynamic(node, op.uid);
      applySetPropOp(node, op.name, op.value);
      astRemap = new Map();
      break;
    }
    case 'set-classes': {
      const { astPath } = splitNodeUid(op.uid);
      const node = resolveOrThrow(sourceFile, astPath, op.uid);
      assertNotDynamic(node, op.uid);
      applySetClassesOp(node, op.add, op.remove);
      astRemap = new Map();
      break;
    }
    case 'insert-node': {
      astRemap = applyInsertNodeOp(sourceFile, op, preAstPaths);
      break;
    }
    case 'delete-node': {
      const { astPath } = splitNodeUid(op.uid);
      astRemap = applyDeleteNodeOp(sourceFile, astPath, op.uid, preAstPaths);
      break;
    }
    case 'move-node': {
      astRemap = applyMoveNodeOp(sourceFile, op, preAstPaths);
      break;
    }
    case 'wrap-node': {
      astRemap = applyWrapNodeOp(sourceFile, op, preAstPaths);
      break;
    }
  }

  const newText = formatWithEmbeddedConfig(sourceFile.getFullText(), opts);

  const uidRemap: Record<string, string> = {};
  for (const [oldAstPath, newAstPath] of astRemap) {
    uidRemap[`${relPath}:${oldAstPath}`] = `${relPath}:${newAstPath}`;
  }

  return { newText, uidRemap };
}
