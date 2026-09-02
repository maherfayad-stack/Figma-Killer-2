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
import { RegisteredMcpServerSchema } from '@core/ai'

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
 * WS-12 §5.1 — session controls that persist PER PROJECT, so reopening a
 * project restores the reasoning effort you were using. `mode`
 * (`--permission-mode`) is the ONE control in §5.1's list that is
 * DELIBERATELY absent here and always will be — D5 §11.5's Bypass guard
 * rail is "it never persists", and that only holds if there is nowhere for
 * it to be written in the first place. Model selection already persists
 * through the existing credential/model-default mechanism, not this file.
 */
const AgentSessionSchema = Type.Object({
  effort: Type.Optional(Type.Union([
    Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
  ])),
})
export type AgentSession = Static<typeof AgentSessionSchema>

/**
 * WS-10 Phase 1/3 — the board-global preview axes a user has explicitly set,
 * persisted per project (D5: "Axes persist PER PROJECT in .studio/meta.json").
 * Every field optional so a project that never touched a toggle keeps opening
 * exactly as it does today; `resolvePreviewAxes` in `./previewAxes.ts` fills
 * in `DEFAULT_PREVIEW_AXES` for whatever is absent.
 *
 * `locale` (WS-10 §4.2, Phase 3) supersedes the legacy top-level
 * `previewLocale` field below — see `readStudioMeta`'s fold. Kept as its own
 * narrow copy of `@core/studio-board`'s `PreviewAxesSchema` fields (not that
 * schema directly) so this file's persisted shape doesn't drift if/when
 * `PreviewAxes` grows a field this sidecar has no reason to persist.
 */
const PersistedPreviewAxesSchema = Type.Object({
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
  locale: Type.Optional(Type.String({ minLength: 1 })),
})

export const StudioMetaSchema = Type.Object({
  /** Decouples the user-facing project name from the folder slug. See `projectDisplayName`. */
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  /** Project-root-relative POSIX override for where pages live (e.g. `'src/screens'`). Containment-checked again after parsing — see module doc. */
  pagesDir: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * LEGACY (WS-10 §5.2) — the `preferredKey` the static evaluator uses to
   * resolve a dictionary indexed by a non-static key (§7.4). Superseded by
   * `previewAxes.locale` below; kept here ONLY so `StudioMetaSchema` still
   * PARSES an already-imported project's hand-edited or pre-Phase-3
   * `meta.json` without rejecting the whole file. `readStudioMeta` folds this
   * into `previewAxes.locale` on read and never returns it — nothing
   * downstream reads `previewLocale` any more; use
   * `projectPreviewLocale`/`previewAxes.locale` instead.
   */
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
   * The form factor the project's screens are designed for, chosen once at
   * creation (`POST /admin/api/studio/create`). This records the ANSWER;
   * `frameDefaults` above records its CONSEQUENCE (the width/height every new
   * frame starts at) and is what the board actually reads. Both are written
   * together at creation — see `@core/studio-board`'s `platformPresets.ts`.
   *
   * Kept as its own field rather than inferred from `frameDefaults.width`
   * because the two answer different questions and drift apart legitimately:
   * a mobile project whose author resized every frame to 430 is still a
   * mobile project, and the agent reads this to know which form factor it is
   * designing for. Optional — every project created before this field, and
   * every GitHub import, simply has no recorded platform.
   */
  platform: Type.Optional(Type.Union([Type.Literal('mobile'), Type.Literal('web')])),
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
  /** WS-12 §5.1 — see `AgentSessionSchema` above. */
  agentSession: Type.Optional(AgentSessionSchema),
  /**
   * Names of servers in the project's own `.mcp.json` that the user has
   * approved for Studio to spawn/connect. An allow-list of NAMES, never the
   * server definitions themselves — the definitions stay in `.mcp.json` where
   * the project owns them, and this records only consent.
   *
   * Absent or empty means none are approved, which is the default and the
   * safe state: `.mcp.json` can name any executable on the machine, and
   * Studio launching it merely because a repo asked would be arbitrary code
   * execution on project open. Approval is per project and per server name.
   * See `projectMcpServers.ts`.
   */
  approvedMcpServers: Type.Optional(Type.Array(Type.String())),
  /**
   * MCP servers the user has registered directly in Studio for this project —
   * NOT declared in the project's own `.mcp.json`. Definitions only, never
   * secret values (see `@core/ai`'s `projectMcpServerSchemas.ts` doc comment
   * for why secret VALUES live in a separate, non-git-tracked store).
   * See `../../ai/drivers/registeredMcpServers.ts`.
   */
  registeredMcpServers: Type.Optional(Type.Array(RegisteredMcpServerSchema)),
  /**
   * Names of entries in `registeredMcpServers` the user has approved to
   * merge into a chat turn — the SAME consent model `approvedMcpServers`
   * uses for project-declared servers (opt-in, per name, stored here rather
   * than anywhere the project itself could influence). Kept as its own list
   * rather than sharing `approvedMcpServers`'s namespace so a project-declared
   * server and a Studio-registered server can never collide on approval by
   * sharing a name.
   */
  approvedRegisteredMcpServers: Type.Optional(Type.Array(Type.String())),
  /**
   * Names of Studio's OWN built-in servers this project has switched off
   * (`BUILT_IN_MCP_SERVERS` in `../../ai/drivers/registeredMcpServers.ts`).
   *
   * Built-ins are present in every project without being registered, so
   * "delete the entry" is not available as the way to turn one off — this
   * list is. Opting out is per project, and an entry here always wins over
   * the built-in, so a user is never stuck with a server Studio ships.
   */
  disabledBuiltInMcpServers: Type.Optional(Type.Array(Type.String())),
  /**
   * Names of servers whose authorization server REFUSED to register Studio as
   * an OAuth client — a closed allow-list, not a transient failure (see
   * `../../ai/credentials/mcpOAuth.ts`'s `McpClientRegistrationClosedError`).
   *
   * Recorded because the answer never changes and rediscovering it costs the
   * user a click on a button that cannot work. With it, the Settings row can
   * open straight into the CLI sign-in route — the one that does work —
   * instead of hiding it behind a failed attempt once per session.
   *
   * NOT consent and NOT a credential: purely a cached fact about the remote
   * provider. A server that later opens registration simply keeps a stale
   * entry until it is signed in through the CLI or the entry is removed.
   */
  mcpOAuthRegistrationClosed: Type.Optional(Type.Array(Type.String())),
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

  meta = foldLegacyPreviewLocale(meta)

  if (meta.pagesDir !== undefined && !isSafePagesDirOverride(meta.pagesDir)) {
    const { pagesDir: _unsafePagesDir, ...rest } = meta
    return rest
  }
  return meta
}

/**
 * WS-10 §5.2 — folds a legacy top-level `previewLocale` into
 * `previewAxes.locale` on READ, and drops `previewLocale` from the returned
 * object so nothing downstream ever sees it. This is a data migration on ONE
 * read path, not an old-and-new code path (CLAUDE.md's "no back-compat
 * shims" is about code, not user data on disk — `.studio/meta.json` is
 * hand-editable and already exists for every already-imported project, the
 * same category as the DB-schema exception): `writeStudioMeta`/
 * `mergeStudioMeta` never persist a fresh `previewLocale` again, because the
 * one caller that used to (the toolbar's now-retired hand-typed field) has
 * been replaced by `previewAxes.locale` (`previewAxes.ts`'s route). An
 * existing `previewAxes.locale` wins over a legacy `previewLocale` if a file
 * somehow carries both (the newer field is the one a real user action just
 * set).
 */
function foldLegacyPreviewLocale(meta: StudioMeta): StudioMeta {
  if (meta.previewLocale === undefined) return meta
  const { previewLocale, ...rest } = meta
  if (rest.previewAxes?.locale !== undefined) return rest
  return { ...rest, previewAxes: { ...rest.previewAxes, locale: previewLocale } }
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
