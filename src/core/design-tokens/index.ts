/**
 * Public barrel for `@core/design-tokens` — the one `DesignToken` model
 * (`STUDIO-FIGMA-PARITY-PLAN.md` §11, Track H) plus the colour math shared
 * between the server-side scanners/measurement tools and the browser picker.
 *
 * Pure leaf: no dependency on `@core/framework`, `@core/framework-schema`,
 * or `@core/page-tree` — this module does not know what emits CSS or how a
 * page tree is shaped, only what a token IS and how two colours compare.
 *
 * Everything outside `src/core/design-tokens/` imports from
 * `@core/design-tokens`. Internal files import each other via relative paths.
 */

export * from './schemas'
export * from './colorMath'
