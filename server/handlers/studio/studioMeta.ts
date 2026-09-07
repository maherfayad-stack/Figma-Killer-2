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
import { LastDeploySchema } from './deploySchema'
import { RegisteredMcpServerSchema } from '@core/ai'

/**
 * The three trust tiers §0 of the V2 plan declares per project. Default:
 * `'static'` (Tier 0 — nothing runs) for every fresh import.
 *
 * Exported so the routes that read/write this field (`trustTier.ts`,
 * `styleCompileConsent.ts`) validate against the SAME schema this file
 * persists, rather than each keeping its own copy of the three literals to
 * drift from. (The browser keeps one more mirror — `studioProjectTrust.ts`'s
 * `TrustTierSchema` — because it cannot import this Node-only module; that
 * one only has to agree on the wire shape.)
 */
export const TrustTierSchema = Type.Union([
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

const AgentEffortSchema = Type.Union([
  Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
])

/** One account's session controls for this project. Grows with any future per-user control (fidelity mode is the next candidate) — the map below is the shape those arrive into. */
const AgentSessionForUserSchema = Type.Object({
  effort: Type.Optional(AgentEffortSchema),
})

/**
 * WS-12 §5.1 — session controls that persist PER PROJECT, so reopening a
 * project restores the reasoning effort you were using. `mode`
 * (`--permission-mode`) is the ONE control in §5.1's list that is
 * DELIBERATELY absent here and always will be — D5 §11.5's Bypass guard
 * rail is "it never persists", and that only holds if there is nowhere for
 * it to be written in the first place. Model selection already persists
 * through the existing credential/model-default mechanism, not this file.
 *
 * W10 — and per ACCOUNT within the project, under `byUser`, keyed by
 * `studioAgentUserKey` (`agentUserScope.ts`). Effort is a preference about
 * how one person likes to work, not a property of the project: two people in
 * one project were previously overwriting each other's choice on every
 * change, and the loser only found out by watching their next turn run at
 * somebody else's setting.
 *
 * The bare `effort` field is what every project written before this change
 * carries. It is READ as the project-wide default for an account that has no
 * entry of its own yet, and never written again — the first save any account
 * makes lands in `byUser`, leaving the old value as the fallback it now is.
 * Not a migration: an unread legacy field costs a few bytes on disk and is
 * the honest answer for a project whose users have not each chosen yet.
 */
const AgentSessionSchema = Type.Object({
  effort: Type.Optional(AgentEffortSchema),
  byUser: Type.Optional(Type.Record(Type.String(), AgentSessionForUserSchema)),
})
export type AgentSession = Static<typeof AgentSessionSchema>
export type AgentSessionEffort = Static<typeof AgentEffortSchema>

/** This account's persisted effort for a project: its own entry, else the pre-`byUser` project-wide value, else none. */
export function readAgentSessionEffort(meta: StudioMeta, userKey: string): AgentSessionEffort | null {
  const session = meta.agentSession
  return session?.byUser?.[userKey]?.effort ?? session?.effort ?? null
}

/**
 * The `agentSession` patch that records ONE account's effort, preserving
 * every other account's entry. `mergeStudioMeta` merges shallowly (by design
 * — it is one `{...a, ...b}`), so the whole `agentSession` object has to be
 * rebuilt here rather than half-written by the caller.
 */
export function withAgentSessionEffort(
  meta: StudioMeta,
  userKey: string,
  effort: AgentSessionEffort | null,
): AgentSession {
  const session = meta.agentSession ?? {}
  const byUser = { ...(session.byUser ?? {}) }
  if (effort) byUser[userKey] = { effort }
  else delete byUser[userKey]
  return { ...session, byUser }
}

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

/**
 * W5-3 — where the project's Storybook stories live on the board, and whether
 * they are placed at all.
 *
 * All three fields exist to make story placement a ONE-TIME, reversible event
 * rather than a reconciliation that fights the user:
 *
 *   - `enabled: false` is the explicit off switch. Story files are still
 *     globbed (it is one directory walk the load already does) but nothing is
 *     parsed and no frame is placed. Absent means on.
 *   - `boardId` names the board `syncStoryBoardFrames` created for stories.
 *     Once it no longer resolves — the user deleted that board — nothing is
 *     ever placed again: deleting the Stories board is a decision, not a
 *     desync to repair.
 *   - `placedPageIds` records every story frame that has EVER been placed, so
 *     removing one frame does not bring it back on the next load while a
 *     newly-written story still appears.
 */
const StoriesMetaSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  boardId: Type.Optional(Type.String({ minLength: 1 })),
  placedPageIds: Type.Optional(Type.Array(Type.String())),
})
export type StoriesMeta = Static<typeof StoriesMetaSchema>

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
   * WS-2.1 consent — the user answered "not now" to the board's
   * `StyleCompileConsentBanner`, the first-run prompt that offers to run this
   * project's own Sass/PostCSS/Tailwind compiler (see
   * `./styleCompileConsent.ts`).
   *
   * Records only a REFUSAL to be asked again, never consent: promoting the
   * trust tier is `trust` above and nothing else. The two are deliberately
   * separate fields — a user who dismisses the prompt and later promotes
   * from somewhere else (the per-node package placeholder) must not have
   * their dismissal read as the promotion, nor the promotion silently
   * un-dismiss a prompt they closed.
   *
   * Per project and on disk, like every other Studio UI preference — the
   * question is about THIS repository, so the answer belongs beside it.
   */
  styleCompilePromptDismissed: Type.Optional(Type.Boolean()),
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
   * W7-5 — this project was copied from the checked-in sample repository
   * (`examples/studio-sample-project/`, via `./sampleProject.ts`), not written
   * or imported by the user.
   *
   * Recorded because it changes what deleting it MEANS: every other project in
   * the workspace is the user's own repository with no other copy, which is
   * why `/delete` moves a folder to the trash and the dialog says so. A sample
   * has another copy in Studio's own repository and can be thrown away without
   * ceremony — and a new one is one click away.
   *
   * Never set by anything but the sample copy, and never cleared: a user who
   * builds their real product on top of the sample has a project that started
   * as one, which is the truth. Absent means "not a sample", which is the
   * honest reading for every project created before this field existed.
   */
  sample: Type.Optional(Type.Boolean()),
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
  /** W5-3 — see `StoriesMetaSchema` above. */
  stories: Type.Optional(StoriesMetaSchema),
  /** WS-12 §5.1 — see `AgentSessionSchema` above. */
  agentSession: Type.Optional(AgentSessionSchema),
  /**
   * W7-2 — epoch ms of the last time the editor loaded this project
   * (`GET /admin/api/studio/load`, the one request that means "this project is
   * open on the board"). Written by `recordProjectOpened`.
   *
   * A FACT about the project, recorded where every other per-project fact
   * lives, and deliberately not a per-user one: it exists so W7-5's onboarding
   * checklist can tick "open it on the board" from something that actually
   * happened, rather than from a flag the checklist set itself. Absent means
   * the project has never been opened since this field shipped — which reads
   * the same as "never opened", and is the honest answer either way.
   */
  lastOpenedAt: Type.Optional(Type.Number()),
  /**
   * W5-4 — the most recent preview deploy for this project: which provider,
   * how it ended, the URL, and the branch/dirty state it shipped. Written by
   * `deployJobs.ts` at the start and the end of every deploy, and the reason
   * "last preview: <url>" survives a page reload, a server restart, and
   * reopening the project a week later.
   *
   * Deliberately carries NO log — see `deploySchema.ts`'s `LastDeploySchema`.
   */
  lastDeploy: Type.Optional(LastDeploySchema),
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

/**
 * Stamps `lastOpenedAt` with the current time. Called from
 * `GET /admin/api/studio/load` — the request that means "the editor is showing
 * this project" — so the fact is recorded by the thing that happened, not by
 * the UI that wants to read it later.
 *
 * Best-effort by design: a project directory that has become unwritable is a
 * problem for a SAVE, and taking the board's load down over a timestamp would
 * be the wrong trade. The failure is logged and the load continues.
 */
export function recordProjectOpened(dir: string): void {
  try {
    mergeStudioMeta(dir, { lastOpenedAt: Date.now() })
  } catch (err) {
    console.error('[studio:studioMeta] could not record lastOpenedAt', err)
  }
}
