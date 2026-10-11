/**
 * stringSpelling — how a value a codemod writes is SPELLED in the user's file.
 *
 * A write is only formatting-preserving if the bytes it adds look like the
 * bytes around them. WB-9/WB-10 (`docs/audits/2026-09-23-studio-audit/
 * 03-errors-writeback.md`): every text edit came back as `{"…"}` and every
 * inline-style value in double quotes, whatever the file used, so a one-word
 * copy change showed up in `git diff` as code nobody would have written. The
 * spelling rules live here so every codemod that writes a string agrees on
 * them — `setStringLiteral` (dictionary and call-site literals), `setJsxText`
 * and `setJsxStyle`.
 */
import { Node, type JsxAttribute, type SourceFile } from 'ts-morph'

export type Quote = '"' | "'"

/**
 * A JS string literal holding `value`, in `quote`. `JSON.stringify` does the
 * escaping (control characters, backslashes, line breaks); the quote is then
 * swapped when the file uses single quotes.
 */
export function jsStringSpelling(value: string, quote: Quote): string {
  const doubleQuoted = JSON.stringify(value)
  if (quote === '"') return doubleQuoted
  return `'${doubleQuoted.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
}

/** The quote an existing string literal was written with. */
export function quoteOf(literal: Node): Quote {
  return literal.getText().startsWith("'") ? "'" : '"'
}

/**
 * The quote this file writes its JS strings in, read off its first import —
 * nearly every module has one, and an import specifier is always a plain
 * string, never a template. A file with no import (or only a template-literal
 * one) keeps `JSON.stringify`'s double quote.
 */
export function preferredQuote(sourceFile: SourceFile): Quote {
  const specifier = sourceFile.getImportDeclarations()[0]?.getModuleSpecifier()
  return specifier && Node.isStringLiteral(specifier) ? quoteOf(specifier) : '"'
}

/** An HTML entity the JSX compiler (and the parser's `decodeJsxTextEntities`) would decode. */
export const JSX_ENTITY_RE = /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

/**
 * P3-C (WB-6) — a JSX ATTRIBUTE string (`<Card title="…"/>`) is not a JS
 * string. It has no backslash escapes — `"C:\path"` means exactly those
 * characters — and the compiler decodes HTML entities in it. So
 * `JSON.stringify` is wrong here twice over: it doubles every backslash, and
 * its `\"` ends the attribute.
 *
 * The value is written raw whenever a raw spelling means the same string: in
 * the quote the file already used, or the other quote when the value contains
 * the first. Otherwise — both quotes, a line break, or text the compiler would
 * decode as an entity — it becomes an expression container holding a JS
 * string (`title={"…"}`), which says exactly the value and nothing else.
 */
export function jsxAttributeSpelling(value: string, quote: Quote): string {
  const rawSafe = !/[\r\n]/.test(value) && !JSX_ENTITY_RE.test(value)
  if (rawSafe) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`
    const other = quote === '"' ? "'" : '"'
    if (!value.includes(other)) return `${other}${value}${other}`
  }
  return `{${jsStringSpelling(value, quote)}}`
}

/**
 * The initializer text for one JSX attribute write (quotes/braces included).
 * A string is spelled the way JSX spells an attribute ({@link
 * jsxAttributeSpelling}): raw, in the quote the attribute already used — so
 * `title='a'` stays single-quoted (WB-10's rule) — and a container only for
 * what raw attribute text cannot say. A number or boolean is `{value}`.
 * Shared by `setJsxProp` and `setSvgPartAttributes`.
 */
export function jsxAttributeInitializerText(value: string | number | boolean, quote: Quote): string {
  return typeof value === 'string' ? jsxAttributeSpelling(value, quote) : `{${value}}`
}

/** The quote an attribute's existing string value is written in, or JSX's usual double quote. */
export function jsxAttributeQuote(attribute: JsxAttribute | undefined): Quote {
  const initializer = attribute?.getInitializer()
  return initializer && Node.isStringLiteral(initializer) ? quoteOf(initializer) : '"'
}
