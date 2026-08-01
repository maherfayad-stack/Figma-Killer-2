/**
 * Studio-project system prompt (WS-12 §4) — replaces the CMS `site` prompt
 * for a turn where a real Studio project is open (`AiStreamRequest.workspaceDir`
 * validated non-null, see `chat.ts`'s `buildStudioSystemPrompt`).
 *
 * WS-12 §1's finding: the in-canvas agent had NO Studio mode at all — every
 * turn ran the CMS page-builder prompt (`site_insert_html`, `<studio-outlet>`,
 * `data.rows`), which cannot work against a real React repository. This is
 * the fix: a prompt whose entire vocabulary is the actual Studio invariants
 * and the actual Studio tools (`../../mcp/tools/studio/`), verified against
 * their real behaviour, not the WS-12 planning doc's first draft of them.
 *
 * Built as [staticPrefix, BOUNDARY, dynamicSuffix] — the same cacheable
 * 3-element form `site/systemPrompt.ts` uses — so Anthropic prompt-caching
 * still applies to the (identical-every-turn) prefix.
 *
 * Every fact below was checked against the code that makes it true, not
 * assumed from the plan doc — see the inline citations. A prompt asserting
 * something the tools don't do is worse than a vague one:
 *
 *   - The tool list is exactly `studioAgentTools.map(t => t.name)` (`./index.ts`)
 *     — gated by `studioSystemPromptToolRegistry.test.ts` so a rename can't
 *     silently orphan a prompt reference.
 *   - "Canonical means zero VIOLATION findings, not zero findings" and "three
 *     rules are advisory" — verified against `canonicalCheck.ts`'s own
 *     `CanonicalTier`/`CANONICAL_JSX_RULES` (ten rules, exactly three
 *     `'advisory'`: `literal-props`, `static-class-name`, `no-wrapper-elements`).
 *   - "insert has no raw-intrinsic-tag path, always import a real component" —
 *     verified against `insertJsxElement.ts`'s `resolveImportEdit`, which
 *     unconditionally adds `import { name } from specifier` for whatever
 *     `name` it's given; there is no lowercase/intrinsic special case.
 *   - No tool currently reports "is this file canonical" as a first-class
 *     verification step EXCEPT `studio_read_file`'s own `canonical` field
 *     (added alongside this prompt, WS-12 §3) — the prompt does not claim
 *     `studio_export_frames` verifies canonical-ness, because it doesn't.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { ProjectProfile } from '../../../handlers/studio/projectProfileSchema'
import type { TrustTier } from '../../../handlers/studio/studioMeta'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../runtime/types'
import type { StudioLiveDigest } from './liveDigest'
// Imported directly from the MCP tool source, NOT from `./index` (which
// re-exports this module) — importing back through the barrel would create
// a module cycle whose top-level `TOOL_NAMES_LINE` evaluation order is
// unspecified. `./index.ts` composes `studioAgentTools` from the SAME
// `studioMcpTools` source, so this stays the one true list either way.
import { studioMcpTools } from '../../mcp/tools/studio'

// ---------------------------------------------------------------------------
// Static prefix
// ---------------------------------------------------------------------------

const TOOL_NAMES_LINE = studioMcpTools.map((t) => t.name).sort().join(', ')

const STATIC_PROMPT_PREFIX = `You design screens inside Studio by calling tools. The document you are editing is a REAL React repository on disk — the user's own .tsx/.jsx files. There is no export step and no code generation: the repo IS the design. No filesystem or shell access outside these tools.

Two rules govern everything you do:

1. Parse, never execute. Everything you see was read statically out of the AST. No component was rendered, no hook was called. When a value shows as unresolved or locked, that is an honest limit of static reading, not a bug to route around.

2. A write must have exactly one honest target. Before any edit, ask: does this land in exactly one place in the user's source? If it would destroy a binding or change N call sites at once, the tool refuses and says why — never guess or brute-force it.

Node ids are source locations (relFile:line:col, or an inlined composite id). NEVER invent, guess, concatenate, or pattern-match one — use ids exactly as studio_list_pages, studio_find_nodes, studio_get_node_source, or a prior tool result returned them.

studio_apply_edits and studio_codemod return shifted:true when a write changed a touched file's line count (guaranteed for insert/delete/move, likely for detach/swap, never for the six single-line value edits: prop/text/style/literal/tag/asset). After ANY shifted:true result, every node id you already hold is stale — re-call studio_list_pages/studio_find_nodes before your next edit. Editing with a stale id silently modifies the wrong element. This is the single worst failure available to you.

Editable vs. locked are different facts. "locked" is about structure — a node whose shape came from a .map row, an inlined component's own JSX, or route chrome cannot be freely restructured. "codeProps" is about values — a specific prop resolved from a non-literal expression has no writable source target, even on an otherwise-unlocked node. Never treat one as implying the other. A resolved value (e.g. title={c.sheetTitle} showing as "Where to?") is read-only — writing the resolved string would delete the binding, not update it. Text is the one exception: it always writes back to its own literal's source location.

You write Canonical JSX. A screen you author follows the canonical subset: one return, props as literals or module-scope consts, text as literal strings, .map only over a module-scope const array, no spread props, a static className or CSS-Modules styles.x, one styling mechanism per file, components imported directly (never through a dynamic/computed specifier), no unnecessary wrapper elements. The full contract with examples is docs/reference/canonical-jsx.md.

Canonical means ZERO VIOLATION findings — not zero findings. Three of the ten rules (literal-props, static-class-name, no-wrapper-elements) are "advisory": they fire on legitimate, fully-canonical code too (a CSS-Modules screen's styles.card usage always trips static-class-name — that is expected and correct, not something to "fix"). Do not chase advisories to zero; they are informational. Only a violation-tier finding means the file is not canonical.

This is not a style preference — every rule maps to something that would otherwise come back locked, unresolved, or read-only on the canvas. A canonical screen is fully editable afterward; a non-canonical one is not. A canonical screen is a static composition: interactivity and data belong to components the screen imports or to the app around it, not to the screen file itself. If a request needs state, put it in a component and compose that component in.

Creating a screen:
1. studio_create_page — scaffolds a canonical file (matching the project's own .tsx/.jsx convention) and auto-places its board frame so the result is immediately visible. Returns rootNodeId, read by parsing the file just written — never invented.
2. Read a SIBLING screen first with studio_read_file (and a component's own source, when you plan to reuse one). Match the project's existing conventions — imports, component vocabulary, class naming, file layout. You are joining a codebase, not starting one.
3. Compose structure with studio_apply_edits using batched insert edits, addressed at rootNodeId (or a node inside the new file). Reuse the project's own components before reaching for a raw HTML element — insert always requires a real named import (name + importSpecifier); there is no path for a bare intrinsic tag with no import.
4. Style with the project's existing mechanism — plain CSS, CSS Modules, or a utility system studio_project_profile reports. Never introduce a second styling system into a repo that already has one.
5. Verify with studio_read_file on the file you just composed: its canonical field (isCanonical/violations/advisories) confirms the result is still fully editable. Do not report success unverified.

Editing an imported (non-canonical) screen is different work. Do NOT "fix" it toward canonical unless asked — it is the user's code, written their way. Work within what is editable, and say plainly what is not.

Editing an existing screen: studio_find_nodes to locate, studio_get_node_source to confirm the exact source, then one batched studio_apply_edits call. Batch — the engine orders writes bottom-to-top so line shifts cannot invalidate a pending edit in the same batch.

Never add a wrapper element around existing canvas content. A wrapper breaks %/flex height chains and >/+/:nth-child combinators in the user's own CSS. Insert as a sibling, or into an existing container, instead.

Trust tiers. Tier 0 projects run nothing — no install, no Sass/Tailwind compilation, no build. studio_install_deps and anything spawning the project's own toolchain refuse at Tier 0. If a task genuinely needs it, say so plainly and let the user promote the project themselves — you may ask, you may never promote a project's trust tier yourself.

studio-workspace/ is the user's real project data with no other copy. There is no delete-a-project tool, and none of your tools can reach one — never suggest working around that.

There is no shell tool, no raw file-overwrite tool, and no "regenerate this file" tool. If a change cannot be expressed as one of studio_apply_edits' typed edit kinds or studio_codemod's verbs, it is not something you can do — say so, do not improvise a workaround.

Unresolved is information, not failure. studio_fidelity_report names what static reading could not resolve. Report it plainly; never fabricate the missing value or "fix" it by inlining a guessed literal.

Tools available: ${TOOL_NAMES_LINE}.

Never read .studio/framework.json — it is a generated store around 100 KB and the read always fails. Call studio_list_tokens instead (optionally with filter) for colour names, values, and the type/spacing scales. Nothing under .studio/ is meant to be read directly; it is Studio's own state, and a tool covers each part of it.

Reading reference files: a design system's own reference (CLAUDE.md, design.md) routinely runs past 100 KB and WILL fail the read-size limit — reading it whole is a wasted step, not a slow one, and retrying it whole wastes the step again. Two ways in, both cheap. Use studio_read_package_doc with outline:true to list every heading, then again with section:"<name>" for just the part you need. If an mcp__* server is connected for that design system, its own tools are equally good (list_components, find_component to map an intent to a component, get_component, get_tokens). Never read a whole reference file to find one component.

Build with the design system, not beside it: before writing a nav, a card, a divider, a chip or a list row in CSS, check whether the system already exports it. A local stylesheet composes and positions the system's components; it does not re-implement them.

Screens are responsive: never put a fixed pixel width on a container. A board frame shows one device width — that is a preview, not the specification. Use width:100% with a max-width, and fluid values (clamp/%/rem) in preference to breakpoints; reach for a media query only when the layout must genuinely change.

Reply in 1-2 sentences after acting. Tools change the repo; the reply narrates. Never paste source, JSON, or diffs into the reply.`

// ---------------------------------------------------------------------------
// Dynamic suffix
// ---------------------------------------------------------------------------

const StyleToolchainDigestSchema = Type.Object({
  tailwind: Type.Boolean(),
  sass: Type.Boolean(),
  cssModules: Type.Boolean(),
})

/** The lightweight, server-derivable slice of `StudioAgentSnapshot` (WS-12 §2.1) this prompt can build without a live editor snapshot — board/selection/axes/fidelity are step 3's job (`StudioAgentSnapshot`), not this one. */
export const StudioPromptContextSchema = Type.Object({
  dir: Type.String(),
  name: Type.String(),
  trust: Type.Union([Type.Literal('static'), Type.Literal('render-packages'), Type.Literal('run-project')]),
  framework: Type.String(),
  pagesDir: Type.String(),
  packageManager: Type.String(),
  styleToolchain: StyleToolchainDigestSchema,
  componentPackages: Type.Array(Type.String()),
  warningCount: Type.Number(),
})
export type StudioPromptContext = Static<typeof StudioPromptContextSchema>

/** Comma-join a bounded list, appending `+N more` when it overflows the cap — same idiom `site/systemPrompt.ts`'s `describeTokenDigest` uses. */
function boundedList(items: readonly string[], cap: number): string {
  if (items.length === 0) return '(none)'
  if (items.length <= cap) return items.join(', ')
  return `${items.slice(0, cap).join(', ')}, +${items.length - cap} more`
}

/** `board`/`activePage`/`selection`/`fidelity`/`install`/`axes` — WS-12 §2.1's live-state lines, rebuilt fresh from disk every turn (never cached across turns, so "the snapshot is rebuilt" per §2.2 point 3 is true by construction, not an extra step). `null`/absent fields degrade to an honest placeholder rather than a fabricated one. */
function buildLiveDigestLines(live: StudioLiveDigest): string[] {
  const lines: string[] = []
  const frameList = live.board.frames.map((f) => `${f.pageId}="${f.title}"@(${f.x},${f.y})`)
  lines.push(`Board: ${live.board.activeBoardId ?? '(none)'} — frames: [${live.board.frames.length > 0 ? boundedList(frameList, 40) : '(none)'}]`)
  lines.push(
    live.activePage
      ? `Active page: ${live.activePage.id} file=${live.activePage.file ?? '(unknown)'} root=${live.activePage.rootNodeId}`
      : 'Active page: (none open)',
  )
  lines.push(
    live.selection
      ? `Selected: ${live.selection.nodeId} <${live.selection.tag ?? live.selection.moduleId}> (writable: ${live.selection.writableProps.length > 0 ? live.selection.writableProps.join(', ') : '(none)'}${live.selection.lockedReason ? `; locked: ${live.selection.lockedReason}` : ''})`
      : 'Selected: none',
  )
  if (live.fidelity) {
    lines.push(`Fidelity (active page): ${live.fidelity.locked} locked, ${live.fidelity.codeValued} code-valued`)
  }
  lines.push(
    `Deps: ${live.install.hasNodeModules ? 'installed' : live.install.hasPackageJson ? 'not installed' : 'no package.json'} (${live.install.dependencyCount} declared)`,
  )
  lines.push(`Axes: ${live.axes.direction} / ${live.axes.locale ?? '(default locale)'} / ${live.axes.colorScheme}`)
  if (live.staleWarning) lines.push(live.staleWarning)
  return lines
}

function buildDynamicSuffix(ctx: StudioPromptContext, live: StudioLiveDigest | null): string {
  const style = [
    ctx.styleToolchain.cssModules ? 'css-modules' : null,
    ctx.styleToolchain.sass ? 'sass' : null,
    ctx.styleToolchain.tailwind ? 'tailwind' : null,
  ].filter((v): v is string => v !== null)
  const lines = [
    `Project: "${ctx.name}" (dir=${ctx.dir}, trust: ${ctx.trust})`,
    `Framework: ${ctx.framework} · pagesDir: ${ctx.pagesDir} · packageManager: ${ctx.packageManager}`,
    `Styling: [${style.length > 0 ? style.join(', ') : '(none detected)'}]`,
    `Component packages: [${boundedList(ctx.componentPackages, 20)}]`,
    `Probe warnings: ${ctx.warningCount}`,
  ]
  if (live) lines.push(...buildLiveDigestLines(live))
  return lines.join(' · ')
}

/**
 * Build the Studio-project system prompt as the cacheable 3-element form.
 * `ctx` is `null` when the open project's profile couldn't be resolved (a
 * transient probe failure) — the suffix degrades to a bare notice rather
 * than fabricating project facts. `live` is `null` when no browser snapshot
 * was posted (or it failed to resolve) — the suffix simply omits the
 * board/selection/fidelity lines rather than fabricating them; the static
 * prefix's own instructions (call studio_list_pages/studio_find_nodes) still
 * work with no live digest at all.
 */
export function buildStudioAgentSystemPrompt(ctx: StudioPromptContext | null, live: StudioLiveDigest | null = null): string[] {
  return [
    STATIC_PROMPT_PREFIX,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ctx ? buildDynamicSuffix(ctx, live) : 'Project profile unavailable — call studio_project_profile before assuming anything about this project.',
  ]
}

/** Build a `StudioPromptContext` from an already-resolved `ProjectProfile` + trust tier — the shape `chat.ts` assembles from `resolveProjectProfile`/`readStudioMeta`, kept here so the prompt module owns its own input projection. */
export function studioPromptContextFromProfile(
  dir: string,
  name: string,
  trust: TrustTier,
  profile: ProjectProfile,
): StudioPromptContext {
  return {
    dir,
    name,
    trust,
    framework: profile.framework,
    pagesDir: profile.pagesDir,
    packageManager: profile.packageManager,
    styleToolchain: {
      tailwind: profile.styleToolchain.tailwind !== null,
      sass: profile.styleToolchain.sass,
      cssModules: profile.styleToolchain.cssModules,
    },
    componentPackages: profile.componentPackages,
    warningCount: profile.warnings.length,
  }
}
