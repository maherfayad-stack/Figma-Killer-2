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
 * omitted list, never left unset, drawn from exactly two vetted sources (see
 * `agentRosterMcpTools.ts`'s `assertKnownAgentTools`): `studioAgentTools`
 * (`../../ai/tools/studio`), and — since mcp-tooling's fix below — an
 * `mcp__<server>__<tool>` name for a project-APPROVED external MCP server.
 * Omitting `tools` inherits the CLI's full built-in set (Bash, Write, Edit,
 * ...), which would silently hand a subagent a shell and a raw file-write
 * path — exactly the two things WS-12 explicitly withholds (§3's
 * "deliberately not added": a shell tool, a raw file-write tool). Two roles
 * (`agent-creator`, `system-prompt-expert`) get an EMPTY tools list on
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
 *
 * ## Reference files live IN `.claude/`, not the project root
 *
 * Every prompt below tells its agent where to find its supporting reference
 * material, and used to say "in this same `.claude/` directory" while
 * `buildReferenceFiles` wrote a bare `relPath` (`'canonical-jsx.md'`) —
 * landing the files at the PROJECT ROOT, not `.claude/`. An agent that
 * followed its own prompt literally got a not-found. Fixed by moving every
 * reference file's target under `.claude/` (`REFERENCE_DIR` below) and
 * having each prompt name the exact project-relative path
 * (`.claude/studio-invariants.md`), not a vague "this same directory" —
 * `studio_read_file` takes a project-relative path regardless of which
 * subdirectory it's read from, so naming the path precisely is strictly
 * more correct than gesturing at proximity to the agent's own file.
 * `.claude/` is not in `EXCLUDED_WORKSPACE_DIR_NAMES`
 * (`src/core/page-parser/workspaceFiles.ts`), so `studio_read_file`'s
 * containment check reaches it exactly as it reached the project root.
 * A project that regenerated before this fix keeps its stale root-level
 * copies on disk — they are simply never targets again, so the manifest
 * (keyed by relPath) stops tracking them on the very next regeneration and
 * they go permanently unmanaged. They are deliberately NOT deleted: proving
 * "Studio still owns this and nothing touched it since" is exactly the
 * never-clobber discipline this generator already applies to every write,
 * and a bulk delete-by-filename at the project root is a strictly riskier
 * operation than leaving harmless, no-longer-referenced clutter behind.
 *
 * ## A subagent can now hold a vetted MCP-namespaced tool too (mcp-tooling)
 *
 * Naming ANY project-approved external MCP server's tool in a roster
 * definition used to throw (only `studioAgentTools` was ever "known"),
 * caught by this function's own try/catch and silently degrading the WHOLE
 * turn to zero subagents. `agentRosterMcpTools.ts`'s `assertKnownAgentTools`
 * fixes this — see that module's doc for the full "what vetted means"
 * reasoning. `agentRosterFigma.ts` is the first user: `figma.md` (same
 * conditional pattern as `design-system.md`) and `figma-asset-scout`,
 * generated only when an approved Figma-capable server is detected.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { joinAppRoot } from './appRoot'
import { resolveProjectProfilePersisting } from './projectProbe'
import type { ProjectProfile } from './projectProfileSchema'
import { readTextCapped } from './cappedFileRead'
import { getOrBuildDesignSystemDigest } from './designSystemDigest'
import { buildDocOutline, renderDocOutline } from './agentRosterDocOutline'
import {
  ALM_PACKAGE,
  allOwnedFilesUnchangedSince,
  computeRosterFingerprint,
  readManifest,
  sha256,
  writeManifest,
  type ManifestFileEntry,
} from './agentRosterManifest'
import { assertKnownAgentTools, resolveApprovedMcpServerNames } from './agentRosterMcpTools'
import { findApprovedFigmaServer, figmaAssetScoutAgent, figmaReference } from './agentRosterFigma'
import type { StudioAgentDef } from './agentRosterTypes'
import {
  referencePath,
  studioToolsReference,
  canonicalJsxReference,
  studioInvariantsReference,
  nodeIdsReference,
  designPrinciplesReference,
  projectConventionsReference,
  type ReferenceFile,
} from './agentRosterReferences'

export type { StudioAgentDef } from './agentRosterTypes'

/** Everything Studio generates for the CLI lands under one project-relative root. */
const CLAUDE_DIR = '.claude'
const AGENTS_DIR = join(CLAUDE_DIR, 'agents')

// ---------------------------------------------------------------------------
// Roster definitions
// ---------------------------------------------------------------------------

/**
 * The ten-to-eleven-agent roster (§7.1 build, §7.2 design, §7.3 meta, plus
 * the project-conditional `figma-asset-scout`). Static except
 * `almosafer-ds-expert`, whose body is assembled per-project (§7.2's
 * sourcing rule: read from the installed package, never vendor a copy), and
 * `figma-asset-scout`, which only exists at all when an approved
 * Figma-capable MCP server is detected (`agentRosterFigma.ts`).
 */
function buildRoster(dir: string, profile: ProjectProfile): StudioAgentDef[] {
  // Computed ONCE per roster generation and threaded through as a closure —
  // matches this file's existing discipline of resolving a value once and
  // passing it down (see `almosafarDsExpert`'s own comment on why it takes
  // `profile` as a parameter instead of re-probing it).
  const approvedMcpServers = resolveApprovedMcpServerNames(dir)
  const assertKnown = (def: StudioAgentDef): StudioAgentDef => assertKnownAgentTools(def, approvedMcpServers)
  const figmaServer = findApprovedFigmaServer(dir)

  return [
    // ---- §7.1 Build agents --------------------------------------------
    assertKnown({
      name: 'screen-scout',
      description: 'Read-only orientation: where is X, how does this project do Y, what convention does a sibling screen follow. Use before composing anything new.',
      tools: ['studio_list_projects', 'studio_project_profile', 'studio_list_pages', 'studio_get_node_source', 'studio_find_nodes', 'studio_read_file'],
      prompt: [
        'You are screen-scout, Studio\'s read-only orientation agent for a real React repository.',
        '',
        'You answer with file:line and real tool output, never with opinions or unverified claims.',
        'You never edit anything — you hold no write tool at all, so there is nothing to accidentally change.',
        '',
        `Read ${referencePath('studio-invariants.md')} and ${referencePath('node-ids-and-writeback.md')} (via studio_read_file) once per session before your first tool call.`,
        '',
        'Typical asks: "where is the checkout screen", "how does this project name its CSS classes", "what does the SheetHeader component look like", "is anything here locked or unresolved".',
        'Answer by calling studio_list_pages / studio_find_nodes / studio_get_node_source / studio_read_file, then report exact locations. If you cannot find something, say so plainly rather than guessing.',
      ].join('\n'),
    }),
    assertKnown({
      name: 'screen-builder',
      description: 'Scaffolds and composes new screens in Canonical JSX. Checks the design-system catalog before hand-rolling markup, and owns the insert/move/delete batch and the node-id staleness discipline.',
      tools: ['studio_create_page', 'studio_read_file', 'studio_find_nodes', 'studio_get_node_source', 'studio_list_components', 'studio_find_component', 'studio_apply_edits'],
      prompt: [
        'You are screen-builder, Studio\'s screen-composition agent.',
        '',
        `Read ${referencePath('canonical-jsx.md')} and ${referencePath('node-ids-and-writeback.md')} (via studio_read_file) once per session — every screen you write must be canonical by construction, and every edit you issue must use a real, freshly-read node id.`,
        '',
        `Before composing anything, call studio_list_components (or studio_find_component when you already know a name or prop) to see what this project's design system already offers, and prefer an existing component over hand-rolled markup + CSS. An EMPTY result is not proof there is no design system — some packages ship untyped JSX this extractor cannot read a catalog from; check the response's designSystems/note fields and see ${referencePath('studio-design-principles.md')} for what to do next (its own BEM class index, the design system's own MCP server if approved, or a sibling screen) before concluding there is nothing to reuse.`,
        '',
        'Flow: studio_list_components for orientation -> studio_create_page to scaffold -> studio_read_file a SIBLING screen to match the project\'s own conventions -> batch studio_apply_edits insert calls, addressed at the new rootNodeId -> studio_read_file the result again and check its canonical field before reporting success.',
        '',
        'insert always needs a real named component to import — there is no raw-intrinsic-tag path. Reuse the project\'s own components before reaching for a bare HTML element.',
        '',
        'Never add a wrapper element around existing content. After ANY shifted:true result, every node id you hold is stale — re-read before your next edit.',
      ].join('\n'),
    }),
    assertKnown({
      name: 'style-surgeon',
      description: 'Styling only, through the project\'s existing mechanism (plain CSS, CSS Modules, or a utility system). Checks for an existing component/token before hand-writing a rule. Never introduces a second styling system into a repo that already has one.',
      tools: ['studio_apply_edits', 'studio_project_profile', 'studio_find_nodes', 'studio_list_components', 'studio_find_component', 'studio_read_file'],
      prompt: [
        'You are style-surgeon, Studio\'s styling-only agent.',
        '',
        `Read ${referencePath('project-conventions.md')} (via studio_read_file) first — it names this project's actual styling mechanism. Style through THAT mechanism only, never a second one, even if you personally prefer a different approach.`,
        '',
        `Priority order before writing a single rule: an existing design-system component (studio_list_components / studio_find_component) or design token, THEN hand-written CSS — never the reverse. See ${referencePath('studio-design-principles.md')} for the full reasoning and what an empty studio_list_components result actually means (not "no design system").`,
        '',
        'You only ever touch style/literal-kind studio_apply_edits — never structure. If a request needs new markup, say so and hand it back rather than reaching outside your remit.',
      ].join('\n'),
    }),
    assertKnown({
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
    assertKnown({
      name: 'design-critic',
      description: 'Visual judgement on a RENDERED frame — hierarchy, spacing rhythm, alignment, contrast, state coverage. Asks "was the intent any good", not "did it render as intended" (that is fidelity-auditor\'s question). When a design reference is registered, MEASURES against it instead of guessing.',
      tools: [
        'studio_export_frames',
        'studio_render_reference',
        'studio_list_design_references',
        'studio_recommend_export_dpr',
        'studio_diff_frames',
      ],
      prompt: [
        'You are design-critic, Studio\'s visual-judgement agent.',
        '',
        `Read ${referencePath('studio-design-principles.md')} — that is the house style you review against, not personal taste.`,
        '',
        'You review a RENDERED frame (studio_export_frames), not source code. Look at hierarchy, spacing rhythm, alignment, contrast, and empty/error/loading state coverage. You never edit anything yourself — report findings for screen-builder or style-surgeon to act on.',
        '',
        'ALWAYS call studio_list_design_references FIRST. If a reference is registered for this page, you are no longer giving an opinion — you are taking a measurement, and a measurement beats a judgement every time:',
        '',
        '  1. studio_recommend_export_dpr for that reference — it returns the dpr that makes a capture land on the reference\'s own pixel width.',
        '  2. studio_export_frames at THAT dpr, and keep the returned nodeRects.',
        '  3. studio_diff_frames with the reference id plus those nodeRects.',
        '  4. Read the `method` field in the result before you trust the score. "exact" means the two images matched dimensions outright. "resampled" means the reference was scaled to fit, so fine detail — hairlines, 1px borders, text edges — carries interpolation noise; do not report sub-pixel differences as defects from a resampled diff. A refusal means the aspect ratios differ enough that something structural is wrong (a missing section, a wrong crop) — report THAT, do not force a comparison.',
        '  5. Each differing region names the node ids it overlaps. Hand those to screen-builder or style-surgeon; a region with no node id is usually a background or spacing problem rather than a component one.',
        '',
        'With no reference registered, say so plainly and fall back to reviewing against the house style. Never imply you compared against a design when you did not — an honest "no reference was supplied, here is my judgement" is worth more than a fabricated similarity claim.',
      ].join('\n'),
    }),
    assertKnown({
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
    assertKnown({
      name: 'synthesizer',
      description: 'Takes scattered findings (scout results, fidelity codes, a critic\'s notes, a rambling brief) and returns one ordered plan with open questions named. Invoke before a multi-screen job.',
      tools: ['studio_project_profile', 'studio_fidelity_report', 'studio_list_pages'],
      prompt: [
        'You are synthesizer, Studio\'s planning agent. You gather context and produce ONE ordered plan — you never edit anything yourself.',
        '',
        'Turn scattered findings into a short, numbered plan: what to do, in what order, and which open questions still need an answer before work starts. Name every open question explicitly rather than assuming an answer.',
      ].join('\n'),
    }),
    assertKnown({
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
    assertKnown({
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
    almosafarDsExpert(dir, profile, assertKnown),
    // ---- Project-conditional agents ------------------------------------
    ...(figmaServer ? [figmaAssetScoutAgent(figmaServer.name, assertKnown)] : []),
  ]
}

/**
 * `almosafer-ds-expert` — the one roster entry whose content depends on the
 * project. §7.2's sourcing rule: read `CLAUDE.md`/`design.md` from the
 * INSTALLED package, never vendor a copy that goes stale on the next
 * `bun update`.
 *
 * A subagent literally cannot fetch these two files itself: `studio_read_file`
 * — the file-read tool for the user's OWN source — refuses any `node_modules`
 * segment by design (the same containment guard every other Studio read
 * uses; loosening it here would be a real hole, not a convenience). So this
 * function reads them SERVER-SIDE, at roster-GENERATION time, and embeds
 * their OUTLINE (headings + byte sizes, {@link buildDocOutline}) directly
 * into the agent's own prompt body — never the whole file. The real
 * published package's files run ~103 KB / ~106 KB; embedding either whole
 * would mean regenerating six-figure bytes of prose into a subagent prompt
 * on every real chat turn, which is its own cost independent of any size
 * cap. The agent pulls the one section it actually needs at call time via
 * `studio_read_package_doc` (`server/ai/mcp/tools/studio/packageDocTools.ts`
 * — the same tool this generator cannot call itself, see
 * `agentRosterDocOutline.ts`'s own doc for why). The outline is a live
 * snapshot refreshed every time the roster regenerates (every real chat
 * turn) — a subagent invoked between two regenerations still reads whatever
 * the last regeneration captured, not the literal current file on disk.
 *
 * Degrades honestly when the package isn't a dependency here (or its files
 * are missing from `node_modules`), rather than generating a confidently
 * wrong agent for every project that doesn't use ALM.
 */
function almosafarDsExpert(
  dir: string,
  profile: ProjectProfile,
  assertKnown: (def: StudioAgentDef) => StudioAgentDef,
): StudioAgentDef {
  const installed = profile.componentPackages.includes(ALM_PACKAGE)
  // `joinAppRoot(dir, profile.appRoot)`, NOT `resolveAppRoot(dir)` — the
  // latter re-reads/re-resolves the profile from scratch (a second, entirely
  // redundant `resolveProjectProfile` call), and `profile` is already a
  // parameter here. Measured: this alone was a full extra uncached probe
  // (~7ms on a project with no persisted profile cache) on every single
  // real chat turn, paid for a value this function already had (perf-06).
  const appRoot = joinAppRoot(dir, profile.appRoot)
  const pkgDir = join(appRoot, 'node_modules', '@alm-design', 'design-system')
  const claudeOutline = installed ? buildDocOutline(join(pkgDir, 'CLAUDE.md')) : undefined
  const designOutline = installed ? buildDocOutline(join(pkgDir, 'design.md')) : undefined
  const hasDesignSystemDigest = (profile.designSystems?.length ?? 0) > 0

  // Every branch shares the same priority order and the same honesty
  // constraint about an empty studio_list_components result — see
  // designPrinciplesReference()'s "Use the design system before writing CSS"
  // section, which states the general rule this agent's prompt applies.
  const priorityOrder = [
    'Priority order, every time: call studio_list_components / studio_find_component',
    '(or this design system\'s OWN MCP server\'s list_components/find_component when the',
    'project has approved one in .studio/meta.json\'s approvedMcpServers — that route is',
    'authored by the package itself against its own component internals, and is the',
    'better source whenever both are available) to find an existing component and its',
    'real props FIRST, then a design token SECOND, and only THEN hand-written CSS.',
    'An EMPTY studio_list_components result is not proof there is nothing to reach for —',
    'a design system shipping untyped JSX with no .d.ts returns zero components from that',
    'extractor even when it is real and installed. Check the response\'s designSystems/note',
    'fields before concluding anything.',
  ].join(' ')

  const body = claudeOutline !== undefined && designOutline !== undefined
    ? [
        'You are almosafer-ds-expert, the authority on this project\'s ALM 2.0 design system.',
        '',
        `The package ships its own CLAUDE.md (technical API — props, tokens, component surface) and design.md (intent, content guidelines, decision logic) — both real but far too large to embed whole (CLAUDE.md alone runs to ${claudeOutline.totalBytes.toLocaleString('en-US')} bytes). Below is each file's OUTLINE — every heading with its size — current as of the last time this roster regenerated. Pull exactly the section you need with studio_read_package_doc({ package: "@alm-design/design-system", doc: "CLAUDE.md", section: "<heading>" }) (doc: "design.md" for the other file) rather than guessing from a heading name alone.`,
        '',
        `${priorityOrder} Its :root custom properties are an editable "vendor-css" token source in Studio's framework panel. NEVER edit the package's own CSS directly — it lives in node_modules and the next install erases it.`,
        '',
        `--- CLAUDE.md outline (${claudeOutline.totalBytes.toLocaleString('en-US')} bytes, ${claudeOutline.sections.length} sections) ---`,
        renderDocOutline(claudeOutline),
        '',
        `--- design.md outline (${designOutline.totalBytes.toLocaleString('en-US')} bytes, ${designOutline.sections.length} sections) ---`,
        renderDocOutline(designOutline),
      ].join('\n')
    : hasDesignSystemDigest
      ? [
          'You are almosafer-ds-expert, the authority on this project\'s design system.',
          '',
          `This project's design system has no package docs reachable here (no @alm-design/design-system install, or a project imported as a plain CSS copy under styles/imported/ — that path never carries a CLAUDE.md/design.md). Read ${referencePath('design-system.md')} (via studio_read_file) instead: it is generated straight from this project's OWN CSS — every color/typography/spacing/radius/elevation token family, plus a one-line-per-component index of class name + available variants + the exact file to open for the full rule. Regenerated every turn from a content hash, so it never goes stale.`,
          '',
          `${priorityOrder} Source the component/token side from ${referencePath('design-system.md')}'s own BEM class index (or this design system's own MCP server if approved) instead of a package README — reach for a sibling screen's existing class names before hand-rolling if neither is enough.`,
        ].join('\n')
      : [
          'You are almosafer-ds-expert. This project does NOT currently depend on @alm-design/design-system (or its reference files are missing), so you have nothing authoritative to consult.',
          '',
          'Say so plainly rather than reasoning about ALM components from memory — a wrong guess here is worse than admitting you cannot help until the package is installed.',
        ].join('\n')

  return assertKnown({
    name: 'almosafer-ds-expert',
    description: 'The authority on ALM 2.0: which component to reach for, its real props, its content rules, and its Arabic/RTL guidance — reads the installed package\'s own docs, never a vendored copy.',
    tools: ['studio_project_profile', 'studio_find_nodes', 'studio_list_components', 'studio_find_component', 'studio_read_package_doc', 'studio_read_file'],
    prompt: body,
  })
}

function buildReferenceFiles(dir: string, profile: ProjectProfile): ReferenceFile[] {
  const designSystemDigest = getOrBuildDesignSystemDigest(dir, profile.designSystems ?? [])
  const figmaServer = findApprovedFigmaServer(dir)
  return [
    { relPath: referencePath('canonical-jsx.md'), content: canonicalJsxReference() },
    { relPath: referencePath('studio-invariants.md'), content: studioInvariantsReference() },
    { relPath: referencePath('node-ids-and-writeback.md'), content: nodeIdsReference() },
    { relPath: referencePath('studio-tools.md'), content: studioToolsReference() },
    { relPath: referencePath('studio-design-principles.md'), content: designPrinciplesReference() },
    { relPath: referencePath('project-conventions.md'), content: projectConventionsReference(dir, profile) },
    ...(designSystemDigest !== undefined ? [{ relPath: referencePath('design-system.md'), content: designSystemDigest }] : []),
    // Same conditional pattern as design-system.md above — generated only
    // when agentRosterFigma.ts's heuristic finds an approved Figma-capable
    // MCP server for this project (see that module's own doc comment).
    ...(figmaServer ? [{ relPath: referencePath('figma.md'), content: figmaReference(figmaServer.name) }] : []),
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
// Regeneration — never clobber a file the user has hand-edited (trap #12).
// The fingerprint/manifest mechanics (perf-06) live in
// `agentRosterManifest.ts`, split out to keep this file under the module-size
// ceiling — that module's own doc comment explains the two-check gate.
// ---------------------------------------------------------------------------

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
 *
 * perf-06: called once per real chat turn, on the critical path before the
 * `claude` subprocess spawns. The FIRST call for a project (or the first
 * call after something actually changed) still does the full walk — resolve
 * the profile, build ten agents' worth of markdown plus 7 reference files,
 * hash and compare each of the 17 targets against `.claude/.studio-generated
 * .json`. Every call after that, with nothing changed, does exactly two
 * cheap things instead: recompute {@link computeRosterFingerprint} (no
 * filesystem write, one small directory stat scan already paid by the design
 * -system digest cache) and stat the 17 already-written files
 * ({@link allOwnedFilesUnchangedSince}) — no content build, no reads, no
 * hashing, no manifest write. Measured on a real 46-file design-system
 * corpus: ~18ms warm → ~1ms warm-and-unchanged.
 *
 * The two checks are BOTH required, for different reasons: the fingerprint
 * catches "the project changed" (new design tokens, a different profile);
 * the per-file stat catches "an OUTPUT file changed" (the user hand-edited
 * `.claude/agents/screen-scout.md`) — something the fingerprint, which only
 * covers INPUTS, cannot see by construction. A hand edit with nothing else
 * changed still yields a matching fingerprint but a stat mismatch, which
 * forces the full path and lets the existing hash-comparison loop detect
 * and report it exactly as before test-verified regression coverage in
 * `agentRoster.test.ts`.
 */
export function generateStudioAgentRoster(dir: string): GenerateRosterResult {
  try {
    // perf-06: persists a freshly-probed profile the first time there is no
    // cache to read (see that function's own doc) — a project with no
    // package.json/node_modules at all (e.g. an "Import design tokens"
    // wizard project) otherwise re-probes from scratch on every single call,
    // forever, since nothing else ever heals its cache. One-time cost, paid
    // once per project rather than once per turn.
    const profile = resolveProjectProfilePersisting(dir)
    const manifest = readManifest(dir)
    const fingerprint = computeRosterFingerprint(dir, profile)

    if (manifest.fingerprint === fingerprint && allOwnedFilesUnchangedSince(dir, manifest.files)) {
      return { written: [], skipped: [] }
    }

    const roster = buildRoster(dir, profile)
    const references = buildReferenceFiles(dir, profile)
    const nextFiles: Record<string, ManifestFileEntry> = {}
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
        const lastWrittenHash = manifest.files[target.relPath]?.hash
        if (lastWrittenHash !== sha256(existing)) {
          // Either Studio never wrote this file, or the user edited it since
          // — either way, not ours to overwrite. Record its CURRENT stat so
          // the fast path above can recognise "still exactly this hand-edit,
          // nothing new" on the next call instead of re-detecting it forever.
          skipped.push(target.relPath)
          const stat = statSync(absPath)
          nextFiles[target.relPath] = { hash: lastWrittenHash ?? sha256(existing), size: stat.size, mtimeMs: stat.mtimeMs }
          continue
        }
        if (existing === target.content) {
          // Unchanged — nothing to write, still ours.
          const stat = statSync(absPath)
          nextFiles[target.relPath] = { hash: contentHash, size: stat.size, mtimeMs: stat.mtimeMs }
          continue
        }
      }

      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, target.content)
      const stat = statSync(absPath)
      nextFiles[target.relPath] = { hash: contentHash, size: stat.size, mtimeMs: stat.mtimeMs }
      written.push(target.relPath)
    }

    writeManifest(dir, { fingerprint, files: nextFiles })
    return { written, skipped }
  } catch (err) {
    console.error('[agentRoster] failed to generate the subagent roster — continuing without one:', err)
    return { written: [], skipped: [] }
  }
}
