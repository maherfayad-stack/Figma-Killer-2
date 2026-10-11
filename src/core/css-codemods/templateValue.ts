/**
 * templateValue — whether a CSS value can be spelled inside a styled-component
 * template literal as ONE declaration's value.
 *
 * Browser-safe on purpose (no postcss, no ts-morph): the editor asks it BEFORE
 * choosing where a style edit goes, so a value the template cannot hold is
 * written to the element instead of being sent to a refusal. The writer
 * (`setStyledDeclaration`) asks the identical question, so the two cannot
 * disagree about which values reach it.
 */

/**
 * A character that would end the declaration, end the template, or start an
 * interpolation. Any of them turns "set this value" into "restructure this
 * template", which is a different edit than the one the user made.
 */
const UNWRITABLE_TEMPLATE_VALUE_RE = /[`;{}\\\n\r]|\$\{/

export function isStyledWritableValue(value: string): boolean {
  return !UNWRITABLE_TEMPLATE_VALUE_RE.test(value)
}
