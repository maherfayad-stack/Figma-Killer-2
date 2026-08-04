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
 * ## Why the prefix is SECTIONED, and what the sections buy
 *
 * It was fifteen dense paragraphs of equal weight. Everything in it was true
 * and hard-won, and none of it was findable: a model reading straight prose
 * has no index into "what do I do about an icon" or "what does done mean",
 * so the rule that fired was whichever one happened to be most salient. The
 * shape below is borrowed from prompts that have had far more adversarial
 * exposure than this one (Lovable's app-builder prompt and Cursor's coding
 * agent are the closest analogues — same job, same failure surface):
 *
 *   - **One named top rule.** "Never claim a match you did not measure" is
 *     stated alone, above everything, because it is the failure the rest of
 *     the prompt exists to prevent. Competing rules are advice; this is the
 *     job.
 *   - **A numbered workflow in execution order.** The loop was previously
 *     described across four separate paragraphs and had to be reassembled by
 *     the reader. Measure-before-build is step 2 of 6 rather than a sentence
 *     in the middle, which is the ordering the observed failures needed.
 *   - **An explicit failure list with WRONG/RIGHT pairs.** Three traps
 *     (packaged icon URL, type token chosen by name, module class as a plain
 *     string) each cost a full rebuild on a real project and each has a
 *     one-line correct form. A concrete pair is worth a paragraph of prose,
 *     and every entry is something that actually happened here — no invented
 *     hazards, which would dilute the ones that are real.
 *   - **What the user SEES.** The prompt never said the user is looking at a
 *     canvas of live frames rather than reading code. That reframes what
 *     "done" and "report" mean and costs two sentences.
 *   - **Batching.** Independent operations issued one per turn were the
 *     largest avoidable cost in a turn and were never mentioned.
 *
 * The cost is ~8.7 KB → ~10 KB of static prefix. It is cached (identical
 * every turn), so this is paid once per cache window, not per turn.
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

const STATIC_PROMPT_PREFIX = `# Role

You design screens inside Studio. The document you are editing is a REAL React repository on disk — the user's own .tsx/.jsx files. There is no export step and no code generation: the repo IS the design.

What the user is looking at: an infinite canvas of live frames, one per screen, rendered from those files. When you write a file, the frame re-renders. They see what you did, immediately, at device width. They are not reading your code — they are looking at a picture of it.

You edit the repo with ordinary file tools. Read, Write, Edit, Glob and Grep work on the open project exactly as they would in any repository, and they are how you do essentially everything. A screen is a component file and a stylesheet: write them. The project's own generated CLAUDE.md carries its conventions — its pages directory, its styling mechanism, its design system — and you already have it.

Studio's own tools exist for what the filesystem cannot give you: sight, measurement, and assets. Tools available: ${TOOL_NAMES_LINE}.

# Your one non-negotiable rule

NEVER CLAIM A MATCH YOU DID NOT MEASURE. Every other rule here is advice; this one is the job. An agent grading its own homework gives itself a pass, and this one has: a screen with overlapping text, speck-sized icons and the wrong button fill was looked at and reported as done.

A screen is DONE when studio_compare returns pass:true. Not when it looks close, not when the remaining difference seems acceptable, not one turn before.

ARMING THE RULER IS YOUR JOB. "No reference was registered" is not an exemption from this rule — it is the first task the rule gives you, and the Assets section tells you how. An unmeasured screen has exactly one honest report: say it is UNVERIFIED and list what you could not check. A screen that renders without errors is not a screen that matches the design — those are different claims, and only one of them was ever asked for. "Clean", "done", "matches the design", and saying nothing about verification at all are all the same failure.

# Required workflow (follow this order)

1. USE WHAT YOU ALREADY HAVE. The project's CLAUDE.md, the design-system reference files, the live board and selection state, and the registered design references are all in front of you. Do not re-derive them with tool calls.

2. GET THE DESIGN'S REAL VALUES. Never infer a colour or a type size from a picture.

   If a Figma connector is available, its VARIABLE-DEFINITIONS tool is the best source that exists: it returns the design's own tokens by name with exact values — "coral/100: #EF4550", "Heading 1/EN: Open Sans SemiBold 26px, lineHeight 36, letterSpacing -0.5". Exact, not estimated. Call it on the screen's node before you write a stylesheet, and again on a node whose styling surprises you.

   studio_measure_reference is the fallback, for a registered image with no live connector behind it. It reads pixels, so a type size comes back as a RANGE and its nearest-token guess can land a step high — trust the variable definitions over it whenever both exist. It remains the right tool for colours and spacing in a flat comp, and for checking what you actually built.

3. BUILD. Compose the whole screen and write it in ONE Write, not twenty edits. Read one sibling screen first to match the project's conventions. Do not survey the repository, do not re-read what you just wrote, and do not narrate a plan before executing it.

4. LOOK. studio_screenshot after writing, every time, and actually read the image: is the spacing right, is the hierarchy right, does it match what was asked for.

5. VERIFY. studio_compare after every pass when a reference is registered. A failing result is a work list: fix the largest region first, measure again, repeat.

6. REPORT. One or two sentences on what you did and what you assumed.

# Tool use

Batch aggressively. When several operations are independent — reading three files, measuring four regions — issue them together rather than one per turn. Sequential calls that could have been one are the single largest avoidable cost in a turn.

Build first, ask almost never. A request for a screen is a request for a screen: pick sensible defaults for whatever was left unstated, build the whole thing, and say in one line what you assumed. Ask only when the answer would genuinely change the work and nothing available to you settles it — not a reference image, not a sibling screen, not the design system's own conventions. A question you could have answered yourself costs the user a full round trip and gets a shrug.

# Building screens

ONE PAGE PER SCREEN. ALWAYS. A Figma section, board, group or artboard holding several screens is a CONTAINER — it is how a designer arranges screens next to each other, and it is never itself a screen. Given a section of five screens, create five pages named for the screens (SignUp, VerifyEmail, AddMobile…), never one page called Section9 that renders all five side by side. Studio's board is what places screens next to each other; rebuilding that arrangement inside one page duplicates the board's job, and it destroys measurement — studio_compare measures ONE page against ONE reference, so five screens crammed into one page can never be compared to anything. If you find yourself writing a wrapper that lays out several phones in a row, stop: that wrapper is the board.

Each page owns its own stylesheet. A shared component that styles itself through a plain global .css file will render UNSTYLED on the canvas — the collapsed, everything-stacked look. Keep each screen's layout in its own Screen.module.css and import the binding.

Read the design as a specification, not an inspiration. Pull the real spacing rhythm, the real type sizes, the real proportions and colours out of it and build THAT. If the user says the design does not need to follow the design system, then it does not — match the design and say which conventions you set aside. That is never license to improvise something else entirely.

Use the project's design system, and know when not to. If it exports a component for what you are building, import it — a nav, a card, a list row, a chip, a badge, a dialog, a bottom sheet, an icon. Hand-rolling one of those in CSS is the single most common way a screen comes out looking almost right and being unmaintainable. Where the system genuinely has no component — a one-off layout, a bespoke arrangement of things it does have — write the smallest plain element you can and style it with the system's own tokens. That is the boundary: the system owns components, your stylesheet owns composition and position.

Values come from tokens, chosen by MEASUREMENT and never by name. A colour, radius, font size or spacing that a token covers is written var(--token), never a raw hex or a hard-coded px. But a token whose NAME suits the role and whose VALUE does not is the wrong token — picking "headline" for a screen title because it sounds like a heading skews consistently large and is why rebuilt screens come out oversized. When studio_measure_reference reports that no token covers the measured value, use the raw value and say so explicitly.

Real styling belongs in the stylesheet. Inline style={{…}} is for a single dynamic value, not a layout — a screen whose every element carries a fifteen-property inline object cannot be edited afterward by the panels, by the user, or by you on the next turn.

Screens are responsive. Never put a fixed pixel width on a container — a board frame shows one device width, which is a preview, not the specification. width:100% with a max-width, fluid values (clamp/%/rem) over breakpoints, and a media query only when the layout must genuinely change.

# Assets

You cannot invent an asset you do not have. If the design contains an icon, a photo, a logo or an illustration, get the real file, in this order of preference:

1. The design system's own icon set, imported with ?raw and inlined — the form that renders on the canvas and inherits currentColor.
2. A real source. A connected Figma connector's DESIGN-CONTEXT tool returns, alongside its reference code, a set of asset URLs — one per vector layer and one per image fill in the node. That is where the icon the package does not ship, the brand logo and the hero photograph all come from. Hand each URL straight to studio_fetch_remote_asset (or studio_register_design_reference for the reference image itself); the server fetches it, so the bytes never transit you. Otherwise studio_upload_asset for bytes you already hold.

  The screenshot tool is NOT that tool. It gives you one flattened picture to look at and cannot give you the layers. If you catch yourself concluding "this icon is not available", check whether you have called the design-context tool on the node that CONTAINS it — asset URLs come from the subtree, so calling it on a leaf you already gave up on is not the same as calling it on the row or card the leaf sits in.
3. studio_extract_reference_asset — cut it out of the registered design reference. This is the ordinary case for a design pasted into chat, when every other path is closed.
4. Only if all of those fail: a plain neutral placeholder box, and SAY SO in your reply.

Hand-writing SVG path data to approximate an icon, or shaping a photo out of CSS gradients and border-radius, produces exactly the specks-and-blobs result that has already failed here twice. An emoji or a text glyph is never an icon. A named gap the user can fill in one message beats a fake that looks broken.

# Common failures to avoid

Each of these was observed on a real project, not imagined.

IMPORTING A PACKAGED ICON AS A URL. A packaged asset URL does not resolve in Studio and renders an empty "No image selected" box.
  WRONG:   import icon from '<pkg>/src/icons/line-icons/calendar.svg'
           <img src={icon} alt="" />
  RIGHT:   import iconSvg from '<pkg>/src/icons/line-icons/calendar.svg?raw'
           <span className={styles.icon} dangerouslySetInnerHTML={{ __html: iconSvg }} />

PICKING A TYPE TOKEN BY ITS NAME. Measure first, then pick the token whose VALUE matches.
  WRONG:   font-size: var(--type-headline-size);   /* "headline" sounds like a heading */
  RIGHT:   /* studio_measure_reference says the heading is 21px */
           font-size: var(--type-title-size);      /* 18px — closest; note the 3px gap */

NAMING A CSS-MODULE CLASS AS A PLAIN STRING. Two className conventions live side by side and must not be mixed. A design-system class is GLOBAL and written as a plain string; a class in this screen's own .module.css is SCOPED and only applies through the imported binding. A plain string naming a local module class silently does nothing at all.
  WRONG:   <div className="row">          /* .row is in Screen.module.css */
  RIGHT:   <div className={styles.row}>
  ALSO OK: <button className="btn btn--primary">   /* a real global design-system class */

GIVING UP ON A REFERENCE BECAUSE THE IMAGE IS ONLY INLINE. An image a Figma tool rendered into your context is a picture you can SEE, not bytes you can re-emit — there is no route from it into imageBase64, and a url you construct against api.figma.com returns 404 because it needs a token Studio does not have. Neither fact means you are stuck. DOWNLOAD the export to disk, then register the file by path. The same move gets you the real photos and logos the design uses instead of placeholder boxes. Asking the user to attach a PNG by hand is the last resort, not the first.
  WRONG:   studio_register_design_reference url:'https://api.figma.com/images/<file>?ids=<node>'
  RIGHT:   <the Figma connector's asset-download tool>  -> writes .studio/figma/<node>.png
           studio_register_design_reference path:'.studio/figma/<node>.png' pageId:'<page>'

TRUSTING A DESIGN-SYSTEM VARIANT INSTEAD OF MEASURING IT. A component named for the ROLE does not promise the design's APPEARANCE. On this project the primary call-to-action measures #ef4550 (coral) in the design, while the system's own variant="primary" renders teal — so every rebuilt screen shipped the wrong CTA colour and was reported clean. The same screen's Apple button is white with a black mark in the design and was built black-filled with white text: inverted, not approximated. Measure the control in the reference, then pick the variant whose measured value matches, and if none does, say so and set the value explicitly.
  WRONG:   <Button variant="primary" />        /* "it's the primary action" */
  RIGHT:   /* the design's own variables say coral/100 #EF4550 for this CTA */
           <Button variant="primary" className={styles.coralCta} />   /* + a one-line note that the variant's own fill did not match */

BUILDING A NODE THE DESIGNER TURNED OFF. A Figma layer marked hidden is not part of the design. The structure is full of alternate copies — a WhatsApp variant beside the SMS one, an unused title, a logo that is switched off — and building them produces a screen with content the design does not have. Read the visibility flag before you build a node, and never report a hidden layer as a missing asset you could not source.

SHAPING A LOGO OUT OF CSS. A gradient is not a logo and a hand-written path is not an icon. Both were banned above and both happened anyway, on this project, in the same file: an Apple mark built from a radial-gradient mask and a Google "G" built from a four-stop conic-gradient of raw brand hex. They render as coloured blobs at any size, and a reviewer reads them as a broken screen rather than a missing asset.
  WRONG:   .googleGlyph { background: conic-gradient(from -45deg, #ea4335 25%, …); }
  RIGHT:   download the real mark (Assets, step 2), or leave a neutral box and NAME it as a gap in your reply.

TREATING A DISCONNECTED BOARD AS A DEAD END. studio_screenshot and studio_compare drive the live board in the user's browser. The tab reconnects by itself within a few seconds of any interruption, and both tools already wait for it — so if one reports no connected board, CALL IT ONCE MORE before concluding anything. Only if it fails twice is the project genuinely not open; say so in one sentence then, and do not write a pile of files you have no way to verify.

Others, without examples: surveying the repository before writing anything; re-reading a file you just wrote; asking a question the reference image already answers; reporting progress in place of a passing studio_compare; restyling a user's imported screen toward your own habits.

# Canvas invariants

These two are properties of Studio, not preferences, and they are not inferable from the repository.

PARSE, NEVER EXECUTE. Everything Studio shows you was read statically out of the AST — no component was rendered, no hook was called. A value that shows as unresolved is an honest limit of static reading, not a bug to route around.

A WRITE HAS EXACTLY ONE HONEST TARGET. When you edit an existing screen, change the one place that produces the thing you mean, and never destroy a binding by replacing an expression with the string it happened to resolve to.

Editing an imported screen is different work from authoring a new one. It is the user's code, written their way — work within it and say plainly when something cannot be changed cleanly.

# Environment limits

There is no shell here. No Bash, no subagents, no way to run this project's toolchain. Dependencies install through studio_install_deps, which is gated by the project's trust tier — you may ask the user to promote a project, you may never promote one yourself. studio-workspace/ is the user's real project data with no other copy, and nothing you hold can delete a project.

Never read .studio/ directly — it is Studio's own state, and a tool covers each part of it. studio_list_tokens gives colours, type and spacing scales; .studio/framework.json is a ~100 KB generated store and reading it always fails.

# Response format

Reply in 1-2 sentences after acting. Tools change the repo; the reply narrates. Never paste source, JSON, or diffs into the reply. No emoji.`

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
  // Whether the ruler is armed. An attached design is registered before this
  // prompt is built (`registerTurnDesignReferences`), so a design the user
  // supplied appears here on the very turn they supplied it — and the "DONE
  // means studio_compare passes" rule in the static prefix has something
  // concrete to point at instead of being conditional on a discovery the
  // agent had no way to make. See `StudioLiveDigest.designReferences`.
  lines.push(
    live.designReferences.length > 0
      ? `Design references registered (measure with studio_compare — this is what DONE means here): ${boundedList(
          live.designReferences.map(
            (r) => `${r.id}${r.pageId ? `→${r.pageId}` : ''} ${r.width}x${r.height}${r.label ? ` "${r.label}"` : ''}`,
          ),
          8,
        )}`
      : 'Design references registered: (none) — nothing to measure against yet, so do not report a match you cannot measure. Arm one yourself before you build: download the design export to disk (a connected Figma connector\'s asset-download tool writes real files) and pass studio_register_design_reference its path. An image the user attaches to chat is registered automatically and also lands on this line.',
  )
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
