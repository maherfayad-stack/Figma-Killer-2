/**
 * projectProfileSchema — the persisted shape of a probed project, as a **pure
 * schema leaf**: TypeBox schemas + their derived types, and nothing else.
 *
 * It exists so that both `studioMeta.ts` (which persists a probe result under
 * `.studio/meta.json`'s `profile` key) and `projectProbe.ts` (which produces
 * one, and needs `readStudioMeta`/`mergeStudioMeta` from `studioMeta.ts` to
 * cache it) can depend on the same schema **without depending on each other**.
 * Without this file the two modules form a real import cycle, and whichever
 * loaded first would hit a TDZ `ReferenceError` on the other's not-yet-defined
 * export.
 *
 * This is the same arrangement `@core/framework-schema` uses for persisted
 * framework token settings, and for the same reason (see CLAUDE.md §"Barrel
 * imports"): the schema leaf depends on nobody, so the module graph stays
 * one-directional and the persisted shape has exactly one definition. Keep it
 * that way — this file must never import a handler, a repository, or anything
 * that reads the filesystem. If you need a helper here, the helper belongs in
 * `@core/utils/typeboxHelpers`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One thing the probe could not determine, with a machine-readable reason.
 *
 * `code` is a **stable identifier**: WS-9 turns these into MCP fidelity
 * findings, so once a code has shipped it is a contract. Renaming one breaks
 * whatever is keying off it. Add new codes freely; change existing ones only
 * with a deliberate migration.
 */
const ProbeWarningSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  fix: Type.String(),
})
export type ProbeWarning = Static<typeof ProbeWarningSchema>

const FrameworkSchema = Type.Union([
  Type.Literal('vite'),
  Type.Literal('next-app'),
  Type.Literal('next-pages'),
  Type.Literal('cra'),
  Type.Literal('remix'),
  Type.Literal('astro'),
  Type.Literal('unknown'),
])

const RouteStyleSchema = Type.Union([
  Type.Literal('directory'),
  Type.Literal('flat'),
  Type.Literal('file-router'),
])

const PackageManagerSchema = Type.Union([
  Type.Literal('bun'),
  Type.Literal('pnpm'),
  Type.Literal('npm'),
  Type.Literal('yarn'),
])

const StyleToolchainSchema = Type.Object({
  tailwind: Type.Union([
    Type.Object({ version: Type.String(), configPath: Type.String() }),
    Type.Null(),
  ]),
  cssModules: Type.Boolean(),
  sass: Type.Boolean(),
  postcssConfigPath: Type.Union([Type.String(), Type.Null()]),
  cssInJs: Type.Union([
    Type.Literal('styled-components'),
    Type.Literal('emotion'),
    Type.Literal('stitches'),
    Type.Null(),
  ]),
})

const PagesDirCandidateSchema = Type.Object({
  /** Repo-relative POSIX directory path. */
  dir: Type.String(),
  /** (files whose default export returns JSX) / (total code files) in that directory, 0–1. */
  score: Type.Number(),
})

export const ProjectProfileSchema = Type.Object({
  framework: FrameworkSchema,
  /** Repo-relative POSIX. */
  pagesDir: Type.String(),
  routeStyle: RouteStyleSchema,
  /** Repo-relative POSIX paths, for `collectEntryStylesheets`. */
  entryFiles: Type.Array(Type.String()),
  packageManager: PackageManagerSchema,
  styleToolchain: StyleToolchainSchema,
  /** Dependency names whose entry `.d.ts` exports a PascalCase React-component-shaped declaration. */
  componentPackages: Type.Array(Type.String()),
  /** tsconfig `paths` merged UNDER vite `resolve.alias` (vite wins on key collision). */
  aliases: Type.Record(Type.String(), Type.String()),
  warnings: Type.Array(ProbeWarningSchema),
  /**
   * Present only when `pagesDir` came from the no-routing-framework heuristic
   * rather than a framework convention — the top 3 ranked directories, so a
   * caller can offer the user a choice instead of trusting a guess silently.
   * Companion warning code: `pages-dir-heuristic`.
   */
  pagesDirCandidates: Type.Optional(Type.Array(PagesDirCandidateSchema)),
})
export type ProjectProfile = Static<typeof ProjectProfileSchema>
