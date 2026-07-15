/**
 * Small text-construction helpers shared by the op handlers — building the
 * literal source TEXT for a JSX attribute value or JSX text body. These
 * never touch prettier or ts-morph; they just produce syntactically valid
 * fragments that get spliced in via a structured ts-morph edit, then the
 * whole file goes through prettier once at the end (`apply-op.ts`).
 */

/** `{`, `}`, and `<` are the only characters with syntactic meaning in a
 * JSX TEXT position (start of an expression, start of a new tag) — `>`,
 * quotes, and all unicode content (incl. Arabic/RTL) are safe verbatim. */
const JSX_TEXT_UNSAFE_RE = /[{}<]/;

/**
 * Render `text` as the body of a JSX element: raw JSX text when safe
 * (byte-identical, human-diffable), or a `{JSON.stringify(text)}` string
 * literal expression when the text contains JSX-syntactically-significant
 * characters — guarantees ANY string (including newlines, quotes, curly
 * braces) round-trips byte-exact.
 */
export function renderJsxTextBody(text: string): string {
  if (!JSX_TEXT_UNSAFE_RE.test(text)) return text;
  return `{${JSON.stringify(text)}}`;
}

/**
 * Quote `value` as a JS/JSX string literal, picking whichever quote
 * character (`"`, then `'`) doesn't appear in the value so no escaping is
 * needed; falls back to `JSON.stringify` (always double-quoted, properly
 * escaped) only when both quote characters are present. Valid both as a
 * bare JSX attribute value (`name="value"`) and as a JS string literal
 * inside a `{}` expression — both take identical string-literal syntax.
 */
export function quoteStringLiteralValue(value: string): string {
  const hasDouble = value.includes('"');
  const hasSingle = value.includes("'");
  if (!hasDouble) return `"${value}"`;
  if (!hasSingle) return `'${value}'`;
  return JSON.stringify(value);
}
