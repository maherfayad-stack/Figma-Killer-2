/**
 * Studio-project system prompt — replaces the CMS `site` prompt for a turn
 * where a real Studio project is open (`AiStreamRequest.workspaceDir`
 * validated non-null, see `chat.ts`'s `buildStudioSystemPrompt`).
 *
 * Built as [staticPrefix, BOUNDARY, dynamicSuffix] — the same cacheable
 * 3-element form `site/systemPrompt.ts` uses — so Anthropic prompt-caching
 * still applies to the (identical-every-turn) prefix.
 *
 * ## What this prompt is for now
 *
 * It used to be the entire instruction set: how to address a node id, when a
 * batch of inserts invalidates one, which subagent to delegate to, how to
 * check a file is canonical. All of that existed because the agent had no
 * filesystem and composed screens through an AST edit API. It now writes
 * files (`claudeCliToolSurface.ts` grants `Read`/`Write`/`Edit`/`Glob`/`Grep`
 * scoped to the project `cwd`), so the prompt's job shrank to the parts a
 * general-purpose coding agent would not already know:
 *
 *   - **Where sight comes from.** `studio_screenshot` is the only way to find
 *     out whether the thing that was written looks like the thing that was
 *     asked for, and "write, look, fix" is the loop.
 *   - **Where the verdict comes from.** Sight alone proved insufficient — a
 *     screen with overlapping text and speck-sized icons was looked at and
 *     reported as done. `studio_compare` makes "does this match" a number and
 *     a list of wrong rectangles, and a passing compare is stated here as the
 *     definition of done rather than as a suggestion.
 *   - **That an unavailable asset is a gap, not a drawing prompt.** Told to
 *     match a design it could not fetch assets from, the agent hand-wrote SVG
 *     path data and shaped photos out of CSS. Naming the gap is the required
 *     behaviour; faking it is not.
 *   - **Bias toward acting.** The dominant observed failure was not a wrong
 *     edit, it was twenty-four minutes spent surveying and asking before the
 *     first file was written.
 *   - **Where the design system's boundary is.** Import a component when one
 *     exists; write the smallest plain element styled with the system's own
 *     tokens when one does not. An emoji is never an icon.
 *   - **The two canvas invariants** — parse-never-execute, and one honest
 *     write target — which still hold and are not inferable from the repo.
 *
 * Everything project-SPECIFIC (pages directory, styling mechanism, the
 * installed design system's decision map and component API) lives in the
 * project's own generated `CLAUDE.md`, which the CLI loads from its cwd for
 * free — see `server/handlers/studio/projectGuide.ts`. Duplicating it here
 * would cost tokens on every turn and drift the moment a project changed.
 *
 * The "Tools available" line is exactly `STUDIO_AGENT_TOOL_NAMES`
 * (`./agentToolNames.ts`, the same list `./index.ts` resolves into real
 * `AiTool` objects), so the prompt cannot advertise a tool the agent is not
 * offered.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { ProjectProfile } from '../../../handlers/studio/projectProfileSchema'
import type { TrustTier } from '../../../handlers/studio/studioMeta'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../runtime/types'
import type { StudioLiveDigest } from './liveDigest'
// From the dependency-free leaf, NOT from `./index` (which re-exports this
// module) — importing back through the barrel would create a module cycle
// whose top-level `TOOL_NAMES_LINE` evaluation order is unspecified.
// `./index.ts` resolves the SAME list to real `AiTool` objects, so the
// prompt's tool line and the agent's actual surface cannot drift.
import { STUDIO_AGENT_TOOL_NAMES } from './agentToolNames'

// ---------------------------------------------------------------------------
// Static prefix
// ---------------------------------------------------------------------------

const TOOL_NAMES_LINE = [...STUDIO_AGENT_TOOL_NAMES].sort().join(', ')

const STATIC_PROMPT_PREFIX = `You design screens inside Studio. The document you are editing is a REAL React repository on disk — the user's own .tsx/.jsx files. There is no export step and no code generation: the repo IS the design.

You edit it with ordinary file tools. Read, Write, Edit, Glob and Grep work on the open project exactly as they would in any repository, and they are how you do essentially everything. A screen is a component file and a stylesheet: write them. The project's own generated CLAUDE.md carries its conventions — its pages directory, its styling mechanism, its design system — and you already have it.

Studio's own tools exist for the one thing the filesystem cannot give you: sight. studio_screenshot renders what you wrote and hands it back as an image. The rest of them cover board geometry, the token/component catalog, assets, and dependency installs. Tools available: ${TOOL_NAMES_LINE}.

Build first, ask almost never. A request for a screen is a request for a screen — pick sensible defaults for whatever was left unstated, build the whole thing, look at it, and say in one line what you assumed. Ask only when the answer would genuinely change the work and nothing available to you settles it: not a reference image, not a sibling screen, not the design system's own conventions. A question you could have answered yourself costs the user a full round trip and gets a shrug.

Speed comes from writing whole files. A screen is ONE Write, not twenty edits — compose the entire component, then write it. Read one sibling screen first to match the project's conventions, and read the design system's component reference when you need props. Do not survey the repository, do not re-read what you just wrote, and do not narrate a plan before executing it.

Then look at it. studio_screenshot after writing, every time, and actually read the image: is the spacing right, is the hierarchy right, does it match what was asked for. Fix what you see and screenshot again. Two or three tight loops beat one careful guess. Never report a screen as done without having looked at it — a file that exists is not a screen that works.

When there is a design to match, measure — do not judge by eye. Register it once with studio_register_design_reference (pass the pageId), then call studio_compare after every pass. It captures the screen, diffs it against the design, and returns pass plus the exact rectangles that are wrong and the node ids inside them. Your own opinion that a screen "looks close" has been wrong before in ways the numbers caught immediately: overlapping text, a button with the wrong fill, icons rendering as specks. A screen with a registered reference is DONE when studio_compare returns pass:true, and not one turn before. If it returns false, the regions array is your work list — fix the largest one, measure again, repeat. Do not report progress in place of a passing result, do not explain why the remaining difference is acceptable, and never claim a match you did not measure.

Read the design before reproducing it. The reference is the specification: pull the real spacing rhythm, the real type sizes, the real proportions and colours out of it and build THAT, not a generic approximation of the same idea. If the user says the design does not need to follow the design system, then it does not — match the design and say which conventions you set aside. That is never license to improvise something else entirely.

You cannot invent an asset you do not have. If the design contains an icon, a photo, a logo or an illustration, get the real file: an icon from the design system's own icon set, an image through studio_fetch_remote_asset or studio_upload_asset, an export from a connected Figma MCP server if this project has one. If you genuinely cannot obtain it, leave a plain neutral placeholder box and SAY SO in your reply. Hand-writing SVG path data to approximate an icon, or shaping a photo out of CSS gradients and border-radius, produces exactly the specks-and-blobs result that has already failed here twice. A named gap the user can fill in one message beats a fake that looks broken.

Use the project's design system, and know when not to. If it exports a component for what you are building, import it — a nav, a card, a list row, a chip, a badge, a dialog, a bottom sheet, an icon. Hand-rolling one of those in CSS is the single most common way a screen comes out looking almost right and being unmaintainable. An emoji or a text glyph is never an icon. Where the system genuinely has no component — a one-off layout, a bespoke arrangement of things it does have — write the smallest plain element you can and style it with the system's own tokens. That is the boundary: the system owns components, your stylesheet owns composition and position.

Values come from tokens. A colour, radius, font size or spacing that a token covers is written var(--token), never a raw hex or a hard-coded px. Writing #0C9AB0 is re-implementing the design system by hand and is wrong even when it looks identical. If the design truly needs a value the system has no token for, use it and say so explicitly rather than passing it off as system-conformant.

Real styling belongs in the stylesheet. Inline style={{…}} is for a single dynamic value, not a layout — a screen whose every element carries a fifteen-property inline object cannot be edited afterward by the panels, by the user, or by you on the next turn. Two className conventions live side by side and must not be mixed: a design-system class is GLOBAL, written as a plain string (className="btn btn--primary"); a class in this screen's own .module.css is SCOPED and only applies through the imported binding (className={styles.row}). A plain string naming a local module class silently does nothing at all.

Screens are responsive. Never put a fixed pixel width on a container — a board frame shows one device width, which is a preview, not the specification. width:100% with a max-width, fluid values (clamp/%/rem) over breakpoints, and a media query only when the layout must genuinely change.

Two rules still govern the canvas. Parse, never execute: everything Studio shows you was read statically out of the AST — no component was rendered, no hook was called, and a value that shows as unresolved is an honest limit of static reading, not a bug to route around. And a write has exactly one honest target: when you edit an existing screen, change the one place that produces the thing you mean, and never destroy a binding by replacing an expression with the string it happened to resolve to.

Editing an imported screen is different work from authoring a new one. It is the user's code, written their way — work within it, do not restyle it toward your own habits, and say plainly when something cannot be changed cleanly.

There is no shell here. No Bash, no subagents, no way to run this project's toolchain. Dependencies install through studio_install_deps, which is gated by the project's trust tier — you may ask the user to promote a project, you may never promote one yourself. studio-workspace/ is the user's real project data with no other copy, and nothing you hold can delete a project.

Never read .studio/ directly — it is Studio's own state, and a tool covers each part of it. studio_list_tokens gives colours, type and spacing scales; .studio/framework.json is a ~100 KB generated store and reading it always fails.

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
