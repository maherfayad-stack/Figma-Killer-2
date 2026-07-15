import {
  Project,
  SyntaxKind,
  type ObjectLiteralExpression,
  type SourceFile,
  type StringLiteral,
} from 'ts-morph';
import { getPropertyByLogicalName } from './property-name.js';
import type { TokenGroup, ThemeName } from './types.js';

/**
 * Format-preserving text edits to `design-system/src/tokens/tokens.js`
 * (playbook §4/P4: "additive daemon control-message for token CRUD
 * writes"). PURE — sourceText in, sourceText out; the daemon is the sole
 * fs-writer (One Rule) and calls these inside its normal `FileOpQueue`
 * write-through path, same discipline as `@ccs/ast-engine`'s `applyOp`.
 *
 * Scope (v1, flagged as a CR — see report): CRUD targets the FOUR flat
 * `export const` objects only (`colors`, `colorsDark`, `spacing`,
 * `rounded`, `elevation`) — nested `typography.<scale>.<field>` edits are
 * deferred (would need a two-level object-literal walk; the token-CRUD
 * control message itself is already additive-only surface, so widening it
 * later is a small, backward-compatible follow-up, not a breaking change).
 */

export type FlatExportName = 'colors' | 'colorsDark' | 'spacing' | 'rounded' | 'elevation';

export interface TokenEditTarget {
  exportName: FlatExportName;
  key: string;
}

/** Maps a `(group, theme)` pair to the tokens.js export it lives in.
 * Returns `undefined` for `typography` (out of v1 CRUD scope, see module
 * doc) and for a `(spacing|rounded|elevation, theme)` pair — those groups
 * are theme-independent, so `theme` is accepted but ignored for them
 * (there is exactly one export either way). */
export function resolveExportName(group: TokenGroup, theme: ThemeName): FlatExportName | undefined {
  if (group === 'color') return theme === 'dark' ? 'colorsDark' : 'colors';
  if (group === 'spacing') return 'spacing';
  if (group === 'rounded') return 'rounded';
  if (group === 'elevation') return 'elevation';
  return undefined; // typography — deferred, see module doc.
}

function loadSourceFile(sourceText: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  return project.createSourceFile('tokens.js', sourceText);
}

function getExportObject(sourceFile: SourceFile, exportName: FlatExportName): ObjectLiteralExpression {
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      if (decl.getName() !== exportName) continue;
      const obj = decl.getInitializer()?.asKind(SyntaxKind.ObjectLiteralExpression);
      if (obj) return obj;
    }
  }
  throw new TokenEditError(`export "${exportName}" not found in tokens.js`);
}

export class TokenEditError extends Error {}

type QuoteChar = "'" | '"';

/**
 * AUDIT-7 minor close-out — this package's own module doc (above) claims
 * these edits are "format-preserving"/"byte-for-byte" for everything
 * UNTOUCHED, but the actual write path used to always emit double-quoted
 * string literals (`JSON.stringify`), silently flipping the real Almosafer
 * DS's single-quote convention (`design-system/src/tokens/tokens.js`) to
 * double quotes on every studio-driven edit — permanent, edit-triggered
 * `git diff` noise in that separate repo, contradicting the doc claim.
 *
 * Fix: detect the quote character the SOURCE FILE already uses for string
 * literals (scanning the target export object's sibling properties first,
 * since that's the most locally relevant convention; falling back to any
 * string literal elsewhere in the file for an empty/all-numeric export)
 * and reuse it, so a set/create write preserves the file's existing style
 * instead of imposing `JSON.stringify`'s hard-coded double quotes. Only
 * when NO string literal exists anywhere in the file (nothing to infer
 * from) does this fall back to double quotes, matching the prior default.
 */
function detectQuoteStyle(sourceFile: SourceFile, obj: ObjectLiteralExpression): QuoteChar {
  const objectStringLiterals: StringLiteral[] = [];
  for (const prop of obj.getProperties()) {
    const pa = prop.asKind(SyntaxKind.PropertyAssignment);
    const str = pa?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
    if (str) objectStringLiterals.push(str);
  }
  return (
    firstQuoteChar(objectStringLiterals) ??
    firstQuoteChar(sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) ??
    '"'
  );
}

function firstQuoteChar(literals: readonly StringLiteral[]): QuoteChar | undefined {
  for (const str of literals) {
    const text = str.getText();
    if (text.startsWith("'")) return "'";
    if (text.startsWith('"')) return '"';
  }
  return undefined;
}

/** Escapes `value` for use as a string literal delimited by `quote`,
 * hand-rolled (rather than routed through `JSON.stringify` + quote
 * swapping) so the escaping logic is correct for EITHER delimiter
 * directly: only the chosen quote char and backslashes need escaping,
 * plus the handful of common control characters tokens.js values might
 * plausibly contain. */
function quoteStringLiteral(value: string, quote: QuoteChar): string {
  let out = quote;
  for (const ch of value) {
    if (ch === quote) out += `\\${quote}`;
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out + quote;
}

function literalInitializerText(value: string | number, quote: QuoteChar): string {
  return typeof value === 'number' ? String(value) : quoteStringLiteral(value, quote);
}

function safePropertyName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Update: sets an EXISTING token's value. Throws `TokenEditError` if the
 * key doesn't exist — use `createToken` to add a new one. */
export function setTokenValue(sourceText: string, target: TokenEditTarget, value: string | number): string {
  const sourceFile = loadSourceFile(sourceText);
  const obj = getExportObject(sourceFile, target.exportName);
  const prop = getPropertyByLogicalName(obj, target.key);
  if (!prop) {
    throw new TokenEditError(`token "${target.key}" not found in "${target.exportName}"`);
  }
  prop.setInitializer(literalInitializerText(value, detectQuoteStyle(sourceFile, obj)));
  return sourceFile.getFullText();
}

/** Create: adds a NEW token. Throws `TokenEditError` if the key already
 * exists — use `setTokenValue` to update it. */
export function createToken(sourceText: string, target: TokenEditTarget, value: string | number): string {
  const sourceFile = loadSourceFile(sourceText);
  const obj = getExportObject(sourceFile, target.exportName);
  if (getPropertyByLogicalName(obj, target.key)) {
    throw new TokenEditError(`token "${target.key}" already exists in "${target.exportName}"`);
  }
  const quote = detectQuoteStyle(sourceFile, obj);
  obj.addPropertyAssignment({ name: safePropertyName(target.key), initializer: literalInitializerText(value, quote) });
  return sourceFile.getFullText();
}

/** Delete: removes an existing token. Throws `TokenEditError` if it
 * doesn't exist. */
export function deleteToken(sourceText: string, target: TokenEditTarget): string {
  const sourceFile = loadSourceFile(sourceText);
  const obj = getExportObject(sourceFile, target.exportName);
  const prop = getPropertyByLogicalName(obj, target.key);
  if (!prop) {
    throw new TokenEditError(`token "${target.key}" not found in "${target.exportName}"`);
  }
  prop.remove();
  return sourceFile.getFullText();
}
