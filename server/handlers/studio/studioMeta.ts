/**
 * studioMeta — schema-validated ownership of `.studio/meta.json`, the
 * per-project sidecar `studioProjects.ts` used to hand-roll (see git history:
 * `readProjectMeta` at ~lines 95–152). WS-1.2 of `STUDIO-IMPORT-V2-PLAN.md`.
 *
 * Every field is OPTIONAL, because the file is hand-editable and a project
 * that only ever set `pagesDir` (no `displayName`, no anything else) must
 * keep working exactly as before. Concretely: `readStudioMeta` never throws
 * and never rejects a file for missing fields — a meta carrying only
 * `{ "pagesDir": "src/screens" }` still yields `{ pagesDir: 'src/screens' }`,
 * not `{}`. This is the trap every future edit to this file must not fall
 * into: `projectPagesDir` in `../studioProjects.ts` depends on that override
 * surviving even when nothing else in the file is set, for every
 * already-imported GitHub project on disk.
 *
 * Malformed JSON (unparsable, or failing `StudioMetaSchema` outright — e.g. a
 * `trust` value outside the three known tiers) degrades to `{}` via
 * `parseJsonWithFallback` rather than throwing: a corrupted or hand-mangled
 * sidecar must not brick the project, it should just fall back to defaults
 * everywhere (folder name as display name, `<dir>/pages`, no locale
 * preference, Tier 0 trust).
 *
 * `pagesDir` gets one more guard AFTER schema validation:
 * `isSafePagesDirOverride` rejects `..` traversal and absolute paths. This is
 * deliberately not expressed in the TypeBox schema (which only knows
 * "non-empty string") because it is a filesystem-safety invariant, not a
 * shape invariant — same reasoning `projectPagesDir` uses for keeping its own
 * belt-and-braces `resolve()` containment check on top of this one.
 *
 * `profile` (the cached `ProjectProfile` probe result) is validated by the real
 * `ProjectProfileSchema`, which lives in the pure schema leaf
 * `./projectProfileSchema.ts` rather than in `./projectProbe.ts`. That split
 * exists precisely so this module can validate the shape it persists:
 * `projectProbe.ts` imports `readStudioMeta`/`mergeStudioMeta` from here, so
 * importing its schema back would be a cycle. Depending on the leaf instead
 * keeps the graph one-directional, the same way `@core/framework-schema` works
 * for persisted framework settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import { ProjectProfileSchema } from './projectProfileSchema'

/** The three trust tiers §0 of the V2 plan declares per project. Default: `'static'` (Tier 0 — nothing runs) for every fresh import. */
const TrustTierSchema = Type.Union([
  Type.Literal('static'),
  Type.Literal('render-packages'),
  Type.Literal('run-project'),
])
export type TrustTier = Static<typeof TrustTierSchema>
export const DEFAULT_TRUST_TIER: TrustTier = 'static'

const FrameDefaultsSchema = Type.Object({
  width: Type.Optional(Type.Number({ minimum: 1 })),
  height: Type.Optional(Type.Number({ minimum: 1 })),
})

/**
 * WS-10 Phase 1 — the board-global preview axes a user has explicitly set,
 * persisted per project (D5: "Axes persist PER PROJECT in .studio/meta.json").
 * Both fields optional so a project that never touched the toggle keeps
 * opening exactly as it does today; `readPersistedPreviewAxes` in
 * `./previewAxes.ts` fills in `DEFAULT_PREVIEW_AXES` for whatever is absent.
 *
 * Deliberately NOT `@core/studio-board`'s full `PreviewAxesSchema` — that type
 * also carries `locale` (Phase 2, parse-time, a different persistence
 * mechanism: the existing `previewLocale` field above). Defined narrowly here
 * so this file's shape doesn't drift if/when `PreviewAxes` grows a field this
 * sidecar has no reason to persist.
 */
const PersistedPreviewAxesSchema = Type.Object({
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
})

export const StudioMetaSchema = Type.Object({
  /** Decouples the user-facing project name from the folder slug. See `projectDisplayName`. */
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  /** Project-root-relative POSIX override for where pages live (e.g. `'src/screens'`). Containment-checked again after parsing — see module doc. */
  pagesDir: Type.Optional(Type.String({ minLength: 1 })),
  /** §7.4 — the `preferredKey` the static evaluator uses to resolve a dictionary indexed by a non-static key. */
  previewLocale: Type.Optional(Type.String({ minLength: 1 })),
  trust: Type.Optional(TrustTierSchema),
  /**
   * Cached `ProjectProfile` probe result. A cache that no longer matches the
   * schema (an older profile shape, a hand-mangled file) fails validation and
   * `parseJsonWithFallback` drops the whole meta to `{}` — which is the
   * correct outcome: callers then re-probe rather than trusting a stale shape.
   */
  profile: Type.Optional(ProjectProfileSchema),
  /** WS-7 — per-project frame size default; overrides the editor's own preference (project wins, same precedent as `defaultBreakpoint`). */
  frameDefaults: Type.Optional(FrameDefaultsSchema),
  /**
   * WS-3.3 — extra package-component module ids (`pkg.<sanitized>.<Name>`,
   * see `@core/module-engine`'s `packageModuleId`) to hide from the insert
   * palette, ADDED to the name-heuristic hides `registerProjectModules.ts`
   * derives on its own (`/Dialog|Sheet|Modal|Toast|Snackbar|Tooltip|Popover/`).
   * Union, not replacement: there is no override to force-SHOW a component
   * the heuristic caught, only to hide additional ones it missed (e.g. a
   * design system's own `Drawer` or `ContextMenu`, which the heuristic's
   * fixed name list doesn't recognize as overlay/portal components).
   */
  paletteHiddenModuleIds: Type.Optional(Type.Array(Type.String())),
  /** WS-10 Phase 1 — see `PersistedPreviewAxesSchema` above. */
  previewAxes: Type.Optional(PersistedPreviewAxesSchema),
})
export type StudioMeta = Static<typeof StudioMetaSchema>

function studioMetaFile(dir: string): string {
  return join(dir, '.studio', 'meta.json')
}

/**
 * `pagesDir` override guard: a non-empty string, never absolute, never
 * containing a `..` segment (on either `/` or `\` separators — the value is
 * hand-editable JSON, so it can't be trusted to already be POSIX-clean).
 * Applied AFTER schema validation (see module doc).
 */
export function isSafePagesDirOverride(value: string): boolean {
  if (value.trim().length === 0 || isAbsolute(value)) return false
  return !value.split(/[\\/]+/).some((segment) => segment === '..')
}

/**
 * Reads `.studio/meta.json`, tolerantly. Absent file → `{}`. Unparsable JSON
 * or a shape `StudioMetaSchema` rejects outright → `{}` (soft fallback, never
 * throws — see module doc). An otherwise-valid file whose `pagesDir` fails
 * the containment guard has just that field stripped, not the whole object.
 */
export function readStudioMeta(dir: string): StudioMeta {
  const file = studioMetaFile(dir)
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')

  // `parseJsonWithFallback` is all-or-nothing: one bad field fails the whole
  // object. That is the right default for user intent, but `profile` is not
  // user intent — it is a regenerable cache of a probe result, and its schema
  // WILL gain fields as the probe grows. Without this retry, the first shape
  // change would make every already-imported project's `.studio/meta.json`
  // fail validation and silently lose its `pagesDir` override, which is the
  // one field that cannot be recovered by re-probing. So: try the whole file,
  // and if it fails, try again with only the cache dropped.
  let meta = parseJsonWithFallback(raw, StudioMetaSchema, {})
  if (Object.keys(meta).length === 0) {
    meta = parseJsonWithFallback(rawWithoutProfile(raw), StudioMetaSchema, {})
  }

  if (meta.pagesDir !== undefined && !isSafePagesDirOverride(meta.pagesDir)) {
    const { pagesDir: _unsafePagesDir, ...rest } = meta
    return rest
  }
  return meta
}

/**
 * `raw` re-serialized without its `profile` key, or `''` when `raw` isn't
 * parsable JSON at all (in which case there is nothing to salvage and
 * `parseJsonWithFallback('')` correctly yields the empty fallback).
 */
function rawWithoutProfile(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !('profile' in parsed)) return ''
    const { profile: _staleProfile, ...rest } = parsed as Record<string, unknown>
    return JSON.stringify(rest)
  } catch {
    // Not JSON at all — the caller's fallback to `{}` is the right outcome.
    return ''
  }
}

/** Writes `.studio/meta.json` verbatim, creating the `.studio/` sidecar dir if needed. Callers that must not clobber sibling fields use `mergeStudioMeta` instead. */
export function writeStudioMeta(dir: string, meta: StudioMeta): void {
  const file = studioMetaFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(meta, null, 2))
}

/**
 * Rewrites ONLY the given fields in `.studio/meta.json`, preserving whatever
 * else is already there — the generalized form of what used to be
 * `renameProjectDisplayName`'s bespoke merge (a naive
 * `writeStudioMeta(dir, { displayName })` on rename would silently erase an
 * imported project's `pagesDir` override, since `writeStudioMeta` itself has
 * no merge semantics). Used by rename AND by the project-probe POST route to
 * persist a re-probed `profile` without touching `displayName`/`pagesDir`/etc.
 */
export function mergeStudioMeta(dir: string, patch: Partial<StudioMeta>): StudioMeta {
  const merged: StudioMeta = { ...readStudioMeta(dir), ...patch }
  writeStudioMeta(dir, merged)
  return merged
}
