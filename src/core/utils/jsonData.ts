/**
 * Plain JSON data, and the check that a value is nothing but.
 *
 * A leaf on purpose: the type is shared by `@core/ast-codemods`'s
 * `insertJsxElement` (which renders it as a JSX expression) and by the editor
 * store (which decides what may be written to a user's source), and that
 * codemod pulls in ts-morph, which must never reach the browser bundle. Neither
 * side may import the other, so the shape they agree on lives here.
 */

/**
 * A JSON data value: a primitive, or an array/plain object built from them.
 *
 * `null` is included and `undefined` is not, on purpose — `null` is a value a
 * user's source can hold and JSON can express, `undefined` is the absence of
 * one, which a caller spells by simply not writing the key.
 */
export type JsonDataValue = string | number | boolean | null | JsonDataValue[] | { [key: string]: JsonDataValue }

/**
 * `value` if it is JSON data through and through, else `undefined`.
 *
 * Checked recursively rather than at the top level: an `actions` array holding
 * one `{ label, onClick: fn }` has no honest spelling for the function, and
 * keeping the object without it would put a button in a user's source that does
 * nothing when tapped. All or nothing, per value.
 */
export function asJsonDataValue(value: unknown): JsonDataValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    const items = value.map(asJsonDataValue)
    return items.some((item) => item === undefined) ? undefined : (items as JsonDataValue[])
  }
  if (typeof value !== 'object') return undefined
  const entries: Record<string, JsonDataValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const json = asJsonDataValue(item)
    if (json === undefined) return undefined
    entries[key] = json
  }
  return entries
}
