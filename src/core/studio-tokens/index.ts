/**
 * @core/studio-tokens — the project's design tokens as a catalog with modes.
 *
 * Pure and browser-safe (no postcss, no filesystem): the gate classifier and
 * the gated declaration scan are shared by the server's catalog builder
 * (`server/handlers/studio/tokenCatalog.ts`), the token write planner both
 * `studio_set_tokens` and the Variables route use, and the editor's framework
 * scales. See `gates.ts` for what a "mode" is in a repository.
 */
export * from './gates'
export * from './resolve'
export * from './ruleScan'
export * from './scan'
export * from './schema'
export * from './references'
export * from './themeUtilities'
