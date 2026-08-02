/**
 * Studio subagent roster generator — WS-12 §7.
 *
 * Confirmed by probe (WS-12, zero-cost — `claude --help`/`claude agents
 * --help`, never `-p`): under `-p`, the CLI auto-discovers
 * `.claude/agents/*.md` from its working directory. WS-11's cwd fix
 * (`resolveClaudeCliWorkspaceCwd`/`resolveValidatedWorkspaceDir`) is what
 * makes that discovery reach anything at all — spawn in the wrong place and
 * there are silently zero subagents. D4: the generated roster lives in
 * `<project>/.claude/`, committed with the rest of the user's repo, exactly
 * like a hand-written Claude Code setup.
 *
 * Called from `claudeCli.ts` right before every real chat turn spawns — "written
 * beside the MCP config" (WS-12 §8's own file table). Best-effort: a failure
 * here degrades the turn to "no subagents", never blocks the chat itself,
 * the same fail-soft posture MCP connector minting already uses.
 *
 * ## Tool safety (the constraint this generator exists to enforce, not just describe)
 *
 * Every generated agent's `tools:` frontmatter is an EXPLICIT, non-empty-or-
 * omitted list drawn only from `studioAgentTools` (`../../ai/tools/studio`) —
 * never left unset. Omitting `tools` inherits the CLI's full built-in set
 * (Bash, Write, Edit, ...), which would silently hand a subagent a shell and
 * a raw file-write path — exactly the two things WS-12 explicitly withholds
 * (§3's "deliberately not added": a shell tool, a raw file-write tool). Two
 * roles (`agent-creator`, `system-prompt-expert`) get an EMPTY tools list on
 * purpose — see their own prompt bodies below for why.
 *
 * ## Regeneration semantics (trap #12 — studio-workspace/* is user data)
 *
 * A generated file is only ever overwritten when its on-disk content still
 * matches the hash Studio itself last wrote (recorded in
 * `.claude/.studio-generated.json`) — i.e. the user hasn't touched it since.
 * A file that doesn't match (hand-edited, or never Studio-written at all) is
 * left alone and reported as `skipped`, never silently clobbered. First run
 * writes everything; every run after that only touches what Studio itself
 * still owns.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveAppRoot } from './appRoot'
import { resolveProjectProfile } from './projectProbe'
import type { ProjectProfile } from './projectProfileSchema'
import { readTextCapped } from './cappedFileRead'
import { getOrBuildDesignSystemDigest } from './designSystemDigest'
import { studioAgentTools } from '../../ai/tools/studio'

const AGENTS_DIR = join('.claude', 'agents')
const MANIFEST_PATH = join('.claude', '.studio-generated.json')
const ALM_PACKAGE = '@alm-design/design-system'
const DS_FILE_MAX_BYTES = 50_000

// ---------------------------------------------------------------------------
// Roster definitions
// ---------------------------------------------------------------------------

export interface StudioAgentDef {
  /** File stem — `.claude/agents/<name>.md`. Also the CLI's own agent `name`. */
  readonly name: string
  /** One line — when the main agent should delegate to this one. */
  readonly description: string
  /**
   * Explicit tool allowlist, drawn only from `studioAgentTools`'s names.
   * Empty (`[]`) is a deliberate choice for a text-only agent, not an
   * oversight — see the file doc comment.
   */
  readonly tools: readonly string[]
  readonly prompt: string
}

const TOOL_NAMES = new Set(studioAgentTools.map((t) => t.name))

function assertKnownTools(def: StudioAgentDef): StudioAgentDef {
  for (const name of def.tools) {
    if (!TOOL_NAMES.has(name)) {
      throw new Error(`[agentRoster] "${def.name}" names an unknown tool "${name}" — not in studioAgentTools.`)
    }
  }
  return def
}

/**
 * The ten-agent roster (§7.1 build, §7.2 design, §7.3 meta). Static except
 * `almosafer-ds-expert`, whose body is assembled per-project (§7.2's
 * sourcing rule: read from the installed package, never vendor a copy).
 */
function buildRoster(dir: string, profile: ProjectProfile): StudioAgentDef[] {
  return [
    // ---- §7.1 Build agents --------------------------------------------
    assertKnownTools({
      name: 'screen-scout',
      description: 'Read-only orientation: where is X, how does this project do Y, what convention does a sibling screen follow. Use before composing anything new.',
      tools: ['studio_list_projects', 'studio_project_profile', 'studio_list_pages', 'studio_get_node_source', 'studio_find_nodes', 'studio_read_file'],
      prompt: [
        'You are screen-scout, Studio\'s read-only orientation agent for a real React repository.',
        '',
        'You answer with file:line and real tool output, never with opinions or unverified claims.',
        'You never edit anything — you hold no write tool at all, so there is nothing to accidentally change.',
        '',
        'Read studio-invariants.md and node-ids-and-writeback.md (in this same .claude/ directory) once per session before your first tool call.',
        '',
        'Typical asks: "where is the checkout screen", "how does this project name its CSS classes", "what does the SheetHeader component look like", "is anything here locked or unresolved".',
        'Answer by calling studio_list_pages / studio_find_nodes / studio_get_node_source / studio_read_file, then report exact locations. If you cannot find something, say so plainly rather than guessing.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'screen-builder',
      description: 'Scaffolds and composes new screens in Canonical JSX. Owns the insert/move/delete batch and the node-id staleness discipline.',
      tools: ['studio_create_page', 'studio_read_file', 'studio_find_nodes', 'studio_get_node_source', 'studio_apply_edits'],
      prompt: [
        'You are screen-builder, Studio\'s screen-composition agent.',
        '',
        'Read canonical-jsx.md and node-ids-and-writeback.md (in this same .claude/ directory) once per session — every screen you write must be canonical by construction, and every edit you issue must use a real, freshly-read node id.',
        '',
        'Flow: studio_create_page to scaffold -> studio_read_file a SIBLING screen to match the project\'s own conventions -> batch studio_apply_edits insert calls, addressed at the new rootNodeId -> studio_read_file the result again and check its canonical field before reporting success.',
        '',
        'insert always needs a real named component to import — there is no raw-intrinsic-tag path. Reuse the project\'s own components before reaching for a bare HTML element.',
        '',
        'Never add a wrapper element around existing content. After ANY shifted:true result, every node id you hold is stale — re-read before your next edit.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'style-surgeon',
      description: 'Styling only, through the project\'s existing mechanism (plain CSS, CSS Modules, or a utility system). Never introduces a second styling system into a repo that already has one.',
      tools: ['studio_apply_edits', 'studio_project_profile', 'studio_find_nodes', 'studio_read_file'],
      prompt: [
        'You are style-surgeon, Studio\'s styling-only agent.',
        '',
        'Read project-conventions.md (in this same .claude/ directory) first — it names this project\'s actual styling mechanism. Style through THAT mechanism only, never a second one, even if you personally prefer a different approach.',
        '',
        'You only ever touch style/literal-kind studio_apply_edits — never structure. If a request needs new markup, say so and hand it back rather than reaching outside your remit.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'fidelity-auditor',
      description: 'Verification, run LAST. Confirms a build actually worked instead of taking the builder\'s word for it.',
      tools: ['studio_fidelity_report', 'studio_export_frames', 'studio_render_reference', 'studio_diff_frames'],
      prompt: [
        'You are fidelity-auditor, Studio\'s verification agent. You are deliberately never the agent that built the thing you are checking.',
        '',
        'Run studio_fidelity_report for what static reading could not resolve, and studio_export_frames (plus studio_diff_frames when a reference render exists) to confirm the screen actually renders as intended.',
        '',
        'Report findings plainly, including "this did not work" when that is the honest answer. Unresolved is information, not failure — never fabricate a value to make a report look cleaner.',
      ].join('\n'),
    }),
    // ---- §7.2 Design agents --------------------------------------------
    assertKnownTools({
      name: 'design-critic',
      description: 'Visual judgement on a RENDERED frame — hierarchy, spacing rhythm, alignment, contrast, state coverage. Asks "was the intent any good", not "did it render as intended" (that is fidelity-auditor\'s question).',
      tools: ['studio_export_frames', 'studio_render_reference'],
      prompt: [
        'You are design-critic, Studio\'s visual-judgement agent.',
        '',
        'Read studio-design-principles.md (in this same .claude/ directory) — that is the house style you review against, not personal taste.',
        '',
        'You review a RENDERED frame (studio_export_frames), not source code. Look at hierarchy, spacing rhythm, alignment, contrast, and empty/error/loading state coverage. You never edit anything yourself — report findings for screen-builder or style-surgeon to act on.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'arabic-ux-writer',
      description: 'Writes and reviews Arabic UX microcopy — فصحى مبسطة — for screens in the open project. Locates the exact node holding a string, rewrites it in place, and reports RTL layout problems as findings rather than bending copy to compensate.',
      tools: ['studio_list_pages', 'studio_find_nodes', 'studio_get_node_source', 'studio_read_file', 'studio_apply_edits'],
      prompt: [
        'You are arabic-ux-writer, Studio\'s Arabic UX-copy agent. You write and review فصحى مبسطة — simplified Modern Standard Arabic for interfaces: purposeful, concise, natural, clear. Not literary Arabic, not stiff official-document Arabic, not a spoken dialect.',
        '',
        'Flow: studio_list_pages to see what screens exist -> studio_find_nodes (filter by `text`) to locate the Arabic string that needs work -> studio_get_node_source to confirm its exact file:line:col before touching it -> studio_read_file on the whole screen, and a sibling screen, to read the surrounding voice before you commit to a rewrite. You only ever issue TEXT-kind studio_apply_edits — never prop, style, tag, or any structural kind (insert/delete/move/detach/swap/css). If a copy problem actually needs new markup, that is outside your remit — say so and hand it back rather than reaching for a tool you do not hold.',
        '',
        'The dominant failure is عرنجي — Arabized English: literal calques, English word order, English punctuation rhythm, a transliterated term where a real Arabic word already exists. Example: "تم الحفظ بنجاح" is a passive, "successfully"-padded calque of "Saved successfully" — write "حُفظ" (system did it) or "حفظت التغييرات" (user did it) instead. "قم بإكمال طلبك" calques "please complete your request" — write "أكمل طلبك". Name عرنجي explicitly when you flag it, never just "sounds awkward".',
        '',
        'The second failure is verbosity. Arabic that mirrors the English sentence clause-for-clause is always too long — Arabic drops the copula, the filler pronoun, and the "الخاص بك" that an English possessive forces. Cut before you polish: "الرجاء الانتظار قليلاً أو معاودة المحاولة لاحقاً" is padding; "حاول مرة أخرى بعد قليل" says the same thing in half the words.',
        '',
        'Voice consistency beats voice preference. Before writing a label, check what this project\'s OWN existing `ar` strings already do — verbal-noun (مصدر) labels like "إضافة مسافر" and imperative labels like "أضف مسافراً" are both correct Arabic; whichever one the project already uses everywhere, match it. Do not impose a house style on someone else\'s app because you personally prefer one form.',
        '',
        'Gender: prefer impersonal or neutral constructions over gendered address by default, UNLESS the project has already committed to a gendered strategy somewhere — then stay consistent with what is already there instead of introducing a third option.',
        '',
        'Numerals: Arabic-Indic (١٢٣) vs. Western (123) is a per-project choice, not yours to make fresh each time — read what this project\'s existing `ar` strings use and match it. Never mix both within one screen.',
        '',
        'Never translate syntax. A placeholder (`{name}`, `%s`), an interpolation token, or an ICU plural construct is not text — translate the human words around it and leave the token or the construct\'s grammar untouched. Arabic has more plural categories than English (zero/one/two/few/many/other, not just singular/plural) — if a naive one-to-one translation of an English plural string will read wrong for a count of 2 or 11, flag that explicitly rather than silently shipping a string that is wrong for most counts.',
        '',
        'Prepositions and إضافة (construct-state/genitive) phrases are where machine translation fails hardest — check every preposition and every construct phrase by hand, every time; never assume a literal preposition mapping from the source language is correct.',
        '',
        'RTL is a layout fact, not a copy fact. If a screen is visibly broken in RTL — an icon on the wrong side, a physical `margin-left` that should have flipped, a progress bar running the wrong direction — that is a layout finding, not something copy can fix. Studio already has an `RTL_PHYSICAL_PROPERTY` fidelity finding for exactly this; point at it instead of bending your wording to compensate for someone else\'s layout bug.',
        '',
        'Studio\'s two invariants apply to you like every other agent: parse, never execute — you read the AST statically, you never run this project\'s code. A write has exactly one honest target — your text edit lands at its own literal\'s source location, nowhere else. Node ids ARE source locations (`relFile:line:col`); never invent, guess, or pattern-match one — use an id exactly as studio_find_nodes/studio_get_node_source returned it, and re-read before your next edit if any prior call this session reported `shifted: true`.',
      ].join('\n'),
    }),
    // almosafer-ds-expert — assembled below, project-conditional content.
    // ---- §7.3 Meta agents -----------------------------------------------
    assertKnownTools({
      name: 'synthesizer',
      description: 'Takes scattered findings (scout results, fidelity codes, a critic\'s notes, a rambling brief) and returns one ordered plan with open questions named. Invoke before a multi-screen job.',
      tools: ['studio_project_profile', 'studio_fidelity_report', 'studio_list_pages'],
      prompt: [
        'You are synthesizer, Studio\'s planning agent. You gather context and produce ONE ordered plan — you never edit anything yourself.',
        '',
        'Turn scattered findings into a short, numbered plan: what to do, in what order, and which open questions still need an answer before work starts. Name every open question explicitly rather than assuming an answer.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'agent-creator',
      description: 'Drafts a NEW subagent definition (frontmatter + prompt body + reference files) for a recurring task that deserves its own specialist. Never writes the file itself.',
      // Deliberately empty — an agent that can mint an agent must never also
      // hold a write tool, or "propose a new agent" quietly becomes
      // "install a new agent" with no human in the loop (WS-12 §7.3's own
      // guard rail: generated definitions land as a diff the user accepts).
      tools: [],
      prompt: [
        'You are agent-creator. You draft new Studio subagent definitions — you never write a file yourself, and you hold no tools at all.',
        '',
        'A generated definition must: use ONLY tool names that already exist in this project\'s .claude/agents/ roster or the main agent\'s own toolset (never invent a tool name), hold no tool the main agent itself does not have, and never include a shell tool, a raw file-write tool, or anything that could promote trust.',
        '',
        'Present your output as the exact markdown (frontmatter + body) the user or the main agent would save into .claude/agents/<name>.md. Say plainly that this is a PROPOSAL, not something you have applied.',
      ].join('\n'),
    }),
    assertKnownTools({
      name: 'system-prompt-expert',
      description: 'Reviews prompt quality across the roster — the main prompt and every subagent\'s — for contradiction, dead instructions, and drift against the tools that actually exist. Never edits anything itself.',
      tools: [],
      prompt: [
        'You are system-prompt-expert. You review prompts for contradiction, dead instructions, and drift against the tools that actually exist — you hold no tools yourself and never apply a change.',
        '',
        'When a prompt names a tool, verify (by asking, or against what you already know of this roster) that the tool is real and that the caller\'s described allowlist actually includes it. A prompt naming a tool nobody has is worse than a vague prompt.',
        '',
        'Present findings and suggested rewrites as text — you never write a file.',
      ].join('\n'),
    }),
    almosafarDsExpert(dir, profile),
  ]
}

/**
 * `almosafer-ds-expert` — the one roster entry whose content depends on the
 * project. §7.2's sourcing rule: read `CLAUDE.md`/`design.md` from the
 * INSTALLED package, never vendor a copy that goes stale on the next
 * `bun update`.
 *
 * A subagent literally cannot fetch these two files itself: `studio_read_file`
 * — the only file-read tool any subagent holds — refuses any `node_modules`
 * segment by design (the same containment guard every other Studio read
 * uses; loosening it here would be a real hole, not a convenience). So this
 * function reads them SERVER-SIDE, at roster-GENERATION time (capped at
 * {@link DS_FILE_MAX_BYTES}), and embeds the current text directly into the
 * agent's own prompt body. That is a live snapshot refreshed every time the
 * roster regenerates (every real chat turn, see `claudeCli.ts`) — not the
 * "vendored once, forgotten forever" copy §7.2 warns against, though a
 * subagent invoked between two regenerations still reads whatever the last
 * regeneration captured, not the literal current file on disk.
 *
 * Degrades honestly when the package isn't a dependency here (or its files
 * are missing from `node_modules`), rather than generating a confidently
 * wrong agent for every project that doesn't use ALM.
 */
function almosafarDsExpert(dir: string, profile: ProjectProfile): StudioAgentDef {
  const installed = profile.componentPackages.includes(ALM_PACKAGE)
  const appRoot = resolveAppRoot(dir)
  const pkgDir = join(appRoot, 'node_modules', '@alm-design', 'design-system')
  const claudeMd = installed ? readTextCapped(join(pkgDir, 'CLAUDE.md'), DS_FILE_MAX_BYTES) : undefined
  const designMd = installed ? readTextCapped(join(pkgDir, 'design.md'), DS_FILE_MAX_BYTES) : undefined
  const hasDesignSystemDigest = (profile.designSystems?.length ?? 0) > 0

  const body = claudeMd !== undefined && designMd !== undefined
    ? [
        'You are almosafer-ds-expert, the authority on this project\'s ALM 2.0 design system.',
        '',
        'Below are the package\'s own reference files, embedded as of the last time this roster regenerated (every real chat turn) — CLAUDE.md is the technical API (props, tokens, component surface); design.md is intent, content guidelines, and decision logic. design.md\'s own framing: CLAUDE.md covers the technical API, design.md covers the why and when.',
        '',
        'Reach for props/variants FIRST, then the package\'s own design tokens (its :root custom properties are an editable "vendor-css" token source in Studio\'s framework panel), and only then authored CSS in the user-authored layer. NEVER edit the package\'s own CSS directly — it lives in node_modules and the next install erases it.',
        '',
        '--- CLAUDE.md ---',
        claudeMd,
        '',
        '--- design.md ---',
        designMd,
      ].join('\n')
    : hasDesignSystemDigest
      ? [
          'You are almosafer-ds-expert, the authority on this project\'s design system.',
          '',
          'This project\'s design system has no package docs reachable here (no @alm-design/design-system install, or a project imported as a plain CSS copy under styles/imported/ — that path never carries a CLAUDE.md/design.md). Read design-system.md (in this same .claude/ directory) instead: it is generated straight from this project\'s OWN CSS — every color/typography/spacing/radius/elevation token family, plus a one-line-per-component index of class name + available variants + the exact file to open for the full rule. Regenerated every turn from a content hash, so it never goes stale.',
          '',
          'Reach for an existing component\'s class + variant FIRST, then a design token, and only then hand-rolled CSS — the same order the real ALM docs teach, just sourced from this project\'s own stylesheets instead of a package README.',
        ].join('\n')
      : [
          'You are almosafer-ds-expert. This project does NOT currently depend on @alm-design/design-system (or its reference files are missing/too large to embed), so you have nothing authoritative to consult.',
          '',
          'Say so plainly rather than reasoning about ALM components from memory — a wrong guess here is worse than admitting you cannot help until the package is installed.',
        ].join('\n')

  return assertKnownTools({
    name: 'almosafer-ds-expert',
    description: 'The authority on ALM 2.0: which component to reach for, its real props, its content rules, and its Arabic/RTL guidance — reads the installed package\'s own docs, never a vendored copy.',
    tools: ['studio_project_profile', 'studio_find_nodes', 'studio_read_file'],
    prompt: body,
  })
}

// ---------------------------------------------------------------------------
// Reference files (§7.4) — point at the authoritative source, never restate it.
// ---------------------------------------------------------------------------

interface ReferenceFile {
  readonly relPath: string
  readonly content: string
}

/**
 * `studio-tools.md` is GENERATED from the registry, never hand-written —
 * §7.4's own callout: a hand-written tool list is wrong the first time a
 * tool is renamed, and every agent inherits the error at once.
 */
function studioToolsReference(): string {
  const lines = studioAgentTools
    .map((t) => `- \`${t.name}\`${t.mutates ? ' (write)' : ''} — ${t.description}`)
  return [
    '# Studio tools',
    '',
    'Generated from the live tool registry — do not hand-edit this file, it is',
    'regenerated on every chat turn and any edit here will be overwritten.',
    '',
    ...lines,
    '',
  ].join('\n')
}

function canonicalJsxReference(): string {
  return [
    '# Canonical JSX — quick reference',
    '',
    'Full contract with examples: `docs/reference/canonical-jsx.md` in the',
    'Studio installation. This file is a compact pointer, not a substitute —',
    'read the full doc when you need the exact detection mechanism or a',
    'non-example for a specific rule.',
    '',
    'A screen is canonical when it has ZERO `violation`-tier findings — not',
    'zero findings. Three of the ten rules (`literal-props`,',
    '`static-class-name`, `no-wrapper-elements`) are `advisory` and fire on',
    'legitimate, fully-canonical code too (a CSS-Modules `styles.x` usage',
    'always trips `static-class-name`) — do not chase advisories to zero.',
    '',
    'The ten rules, one line each: one `return`; props as literals or',
    'module-scope consts; text as literal strings; `.map` only over a',
    'module-scope const array; no spread props; a static `className`/`styles.x`;',
    'one styling mechanism per file; inline `<svg>` stays static JSX;',
    'components imported directly, never through a computed specifier; no',
    'unnecessary wrapper elements added around content.',
  ].join('\n')
}

function studioInvariantsReference(): string {
  return [
    '# Studio invariants',
    '',
    '1. Parse, never execute. Everything on the canvas was read statically out',
    '   of the AST — no component was rendered, no hook was called.',
    '2. A write must have exactly one honest target. An edit that cannot land',
    '   in exactly one place in the user\'s source is refused, not brute-forced.',
    '3. `locked` (structure) and `codeProps` (values) are different facts —',
    '   never treat one as implying the other.',
    '4. Never add a wrapper element around existing content — it breaks',
    '   `%`/flex height chains and CSS combinators in the user\'s own stylesheet.',
    '5. Trust tiers are the gate. Tier 0 runs nothing. You may ASK the user to',
    '   promote a project; you may never promote one yourself.',
    '6. `studio-workspace/` is the user\'s real project with no other copy.',
    '   There is no delete-a-project tool and none of your tools can reach one.',
  ].join('\n')
}

function nodeIdsReference(): string {
  return [
    '# Node ids and writeback',
    '',
    'A node id IS a source location (`relFile:line:col`, or an inlined',
    'composite id). Never invent, guess, concatenate, or pattern-match one —',
    'use ids exactly as a tool returned them.',
    '',
    '`studio_apply_edits`/`studio_codemod` return `shifted: true` when a write',
    'changed a touched file\'s line count — guaranteed for insert/delete/move,',
    'likely for detach/swap, never for the six single-line value edits',
    '(prop/text/style/literal/tag/asset). After ANY `shifted: true` result,',
    'every node id you already hold is stale. Re-read before your next edit —',
    'editing with a stale id silently modifies the wrong element.',
  ].join('\n')
}

function designPrinciplesReference(): string {
  return [
    '# Studio design principles',
    '',
    'Reviewed by design-critic — hierarchy, spacing rhythm, alignment,',
    'contrast, and state coverage (empty, error, loading), not personal taste.',
    '',
    '- Establish a clear visual hierarchy before adding detail — one primary',
    '  action per screen, not three competing ones.',
    '- Keep spacing on the project\'s own scale (see project-conventions.md)',
    '  rather than inventing one-off values.',
    '- Every interactive screen needs an empty state, an error state, and a',
    '  loading state considered — even if the answer is "not applicable here".',
    '- Contrast and touch-target size are not optional polish; call them out',
    '  as findings, not suggestions, when they fail.',
    '',
    '## Responsive by default — not a follow-up pass',
    '',
    'A generated screen came back with `width: 375px` hardcoded on its root and',
    'zero media queries in 233 lines. A board frame shows one device width; that',
    'is the preview, never the specification.',
    '',
    '- **Never put a fixed pixel width on a container.** Use `width: 100%` with',
    '  a `max-width` cap, and let the frame decide the rest.',
    '- Fixed `px` belongs only on things that genuinely do not scale — icon',
    '  boxes, hairline borders, minimum touch targets.',
    '- Prefer fluid values (`clamp()`, `%`, `rem`, `minmax()`) over a breakpoint',
    '  whenever the layout can simply flex instead.',
    '- Reach for a media query when the layout must genuinely CHANGE (a row',
    '  becoming a column), not to restate a width you already hardcoded.',
    '',
    '## Use the design system before writing CSS',
    '',
    'A generated screen imported 2 components and hand-rolled a nav, a divider,',
    'and three card rows in a local CSS module — every one of which already',
    'existed in the installed design system.',
    '',
    '- **Ask what exists before building it.** If the project ships a design',
    '  system with an MCP server, query it (`list_components`, `find_component`)',
    '  rather than reading its whole reference file — those files run to 100 KB',
    '  and will fail the read-size limit.',
    '- A local CSS module is for composing and positioning the system\'s',
    '  components, not for re-implementing one of them.',
  ].join('\n')
}

/** Per-project, generated from `studio_project_profile` — framework, pagesDir, styling mechanism, component packages. */
function projectConventionsReference(dir: string, profile: ProjectProfile): string {
  const style = [
    profile.styleToolchain.cssModules ? 'css-modules' : null,
    profile.styleToolchain.sass ? 'sass' : null,
    profile.styleToolchain.tailwind ? 'tailwind' : null,
  ].filter((v): v is string => v !== null)
  return [
    '# Project conventions',
    '',
    'Generated from studio_project_profile — regenerated on every chat turn,',
    'do not hand-edit.',
    '',
    `- Project: ${dir}`,
    `- Framework: ${profile.framework}`,
    `- Pages directory: ${profile.pagesDir}`,
    `- Package manager: ${profile.packageManager}`,
    `- Styling mechanism: ${style.length > 0 ? style.join(', ') : '(none detected)'}`,
    `- Component packages: ${profile.componentPackages.length > 0 ? profile.componentPackages.join(', ') : '(none)'}`,
  ].join('\n')
}

function buildReferenceFiles(dir: string, profile: ProjectProfile): ReferenceFile[] {
  const designSystemDigest = getOrBuildDesignSystemDigest(dir, profile.designSystems ?? [])
  return [
    { relPath: 'canonical-jsx.md', content: canonicalJsxReference() },
    { relPath: 'studio-invariants.md', content: studioInvariantsReference() },
    { relPath: 'node-ids-and-writeback.md', content: nodeIdsReference() },
    { relPath: 'studio-tools.md', content: studioToolsReference() },
    { relPath: 'studio-design-principles.md', content: designPrinciplesReference() },
    { relPath: 'project-conventions.md', content: projectConventionsReference(dir, profile) },
    ...(designSystemDigest !== undefined ? [{ relPath: 'design-system.md', content: designSystemDigest }] : []),
  ]
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderAgentMarkdown(def: StudioAgentDef): string {
  const lines = [
    '---',
    `name: ${def.name}`,
    `description: ${def.description}`,
    `tools: ${def.tools.join(', ')}`,
    '---',
    '',
    def.prompt,
    '',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Regeneration — never clobber a file the user has hand-edited (trap #12)
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface GeneratedManifest {
  [relPath: string]: string
}

function readManifest(dir: string): GeneratedManifest {
  const path = join(dir, MANIFEST_PATH)
  const parsed = readJsonManifest(path)
  return parsed ?? {}
}

function readJsonManifest(path: string): GeneratedManifest | null {
  const text = readTextCapped(path, 1_000_000)
  if (text === undefined) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as GeneratedManifest
    return null
  } catch {
    return null
  }
}

function writeManifest(dir: string, manifest: GeneratedManifest): void {
  const path = join(dir, MANIFEST_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2))
}

export interface GenerateRosterResult {
  readonly written: string[]
  readonly skipped: string[]
}

/**
 * Write every generated agent + reference file into `<dir>/.claude/`,
 * skipping (never overwriting) anything the user has changed since Studio
 * last wrote it. Never throws — a probe/profile failure degrades to
 * `{ written: [], skipped: [] }` (the caller, `claudeCli.ts`, treats a
 * missing roster as "no subagents this turn", not a broken chat).
 */
export function generateStudioAgentRoster(dir: string): GenerateRosterResult {
  try {
    const profile = resolveProjectProfile(dir)
    const roster = buildRoster(dir, profile)
    const references = buildReferenceFiles(dir, profile)
    const manifest = readManifest(dir)
    const nextManifest: GeneratedManifest = {}
    const written: string[] = []
    const skipped: string[] = []

    const targets: Array<{ relPath: string; content: string }> = [
      ...roster.map((def) => ({ relPath: join(AGENTS_DIR, `${def.name}.md`), content: renderAgentMarkdown(def) })),
      ...references.map((ref) => ({ relPath: ref.relPath, content: ref.content })),
    ]

    for (const target of targets) {
      const absPath = join(dir, target.relPath)
      const contentHash = sha256(target.content)
      const existing = readTextCapped(absPath, 1_000_000)

      if (existing !== undefined) {
        const lastWrittenHash = manifest[target.relPath]
        if (lastWrittenHash !== sha256(existing)) {
          // Either Studio never wrote this file, or the user edited it since
          // — either way, not ours to overwrite.
          skipped.push(target.relPath)
          nextManifest[target.relPath] = lastWrittenHash ?? sha256(existing)
          continue
        }
        if (existing === target.content) {
          // Unchanged — nothing to write, still ours.
          nextManifest[target.relPath] = contentHash
          continue
        }
      }

      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, target.content)
      nextManifest[target.relPath] = contentHash
      written.push(target.relPath)
    }

    writeManifest(dir, nextManifest)
    return { written, skipped }
  } catch (err) {
    console.error('[agentRoster] failed to generate the subagent roster — continuing without one:', err)
    return { written: [], skipped: [] }
  }
}
