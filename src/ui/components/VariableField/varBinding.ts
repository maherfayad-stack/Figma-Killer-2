/**
 * varBinding — the one parse/format pair for "this field's value IS a CSS
 * custom property reference".
 *
 * A field is *bound* when its whole committed value is a single `var(--x)`
 * expression, optionally carrying a fallback (`var(--x, 12px)`). That is the
 * only shape the inspector treats as a variable binding: `calc(var(--x) * 2)`
 * and `1px solid var(--x)` are ordinary literal values that merely mention a
 * variable, and showing a Figma-style variable chip for either would claim a
 * one-token edit the field cannot honestly make (detaching would have to
 * rewrite an expression, not swap a value).
 *
 * Kept free of any CSS parser: the grammar of a lone `var()` call is small
 * enough to read directly, and the alternative (postcss in the browser, for
 * every keystroke in every inspector field) is not worth it.
 */

/** A value that is exactly one `var()` reference. */
export interface VarBinding {
  /** Property name INCLUDING the leading dashes, e.g. `--color-primary`. */
  readonly name: string
  /** The fallback argument, trimmed, or `undefined` when there is none. */
  readonly fallback: string | undefined
}

/** Matches the leading `var(` of an expression that starts with one. */
const VAR_OPEN_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*/

/**
 * Parses `value` as a lone `var()` reference. Returns `null` for anything
 * else — a literal, an empty value, `MIXED`'s empty string, or an expression
 * that merely CONTAINS a `var()`.
 *
 * Balanced-paren scan rather than a regex for the fallback, because a
 * fallback is itself allowed to be an arbitrary CSS value including nested
 * `var()`/`calc()` calls (`var(--a, var(--b, 4px))`).
 */
export function parseVarBinding(value: string | undefined | null): VarBinding | null {
  if (value == null) return null
  const trimmed = value.trim()
  const open = VAR_OPEN_RE.exec(trimmed)
  if (!open) return null

  let depth = 1
  let index = open[0].length
  for (; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  // Unbalanced, or the `var()` call ends before the end of the value (so the
  // value is a larger expression like `var(--a) var(--b)`).
  if (depth !== 0 || index !== trimmed.length - 1) return null

  const inner = trimmed.slice(open[0].length, index)
  if (inner.length === 0) return { name: open[1], fallback: undefined }
  if (!inner.startsWith(',')) return null
  const fallback = inner.slice(1).trim()
  return { name: open[1], fallback: fallback.length > 0 ? fallback : undefined }
}

/** `--color-primary` → `var(--color-primary)`. The one write shape. */
export function formatVarBinding(name: string): string {
  return `var(${name})`
}

/**
 * The label a variable chip shows: the name without its leading dashes.
 * Figma shows a variable named `34` as `34`, not `--34`; the dashes are CSS
 * syntax, not part of what the user named the thing.
 */
export function variableChipLabel(name: string): string {
  return name.replace(/^--/, '')
}
