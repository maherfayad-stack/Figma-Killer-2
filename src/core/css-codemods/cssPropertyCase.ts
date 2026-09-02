/**
 * camelToKebabCssProperty — `backgroundColor` -> `background-color`.
 *
 * `CSSPropertyBag` (`@core/page-tree`) keys are camelCase everywhere in this
 * editor (property controls, `StyleRule.styles`, the publisher's own
 * `CSSPropertyBag`). `setDeclaration`/`setDeclarationAtMedia` write into a
 * REAL `.css` file through a postcss CST, which only understands kebab-case
 * property names — a bare `backgroundColor: red;` would be silently invalid
 * CSS. This is the one-line conversion every writeback caller needs before
 * calling either codemod.
 *
 * `@core/publisher/classCss.ts` has its own private `toKebab` doing the exact
 * same regex for the exact same reason (publish-time CSS emission). Kept as a
 * separate copy rather than a shared import: `@core/css-codemods` is a leaf
 * module with no dependency on `@core/publisher`, and importing across for
 * one line would be a real coupling for no reuse benefit — same posture
 * `src/core/siteImport/keyframesToStyleRule.ts`'s own `camelToKebab` already
 * takes.
 */
export function camelToKebabCssProperty(camel: string): string {
  return camel.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
}
