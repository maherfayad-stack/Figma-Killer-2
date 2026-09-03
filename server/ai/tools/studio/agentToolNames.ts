/**
 * The names of the Studio tools the in-canvas agent is offered, as a
 * dependency-free leaf.
 *
 * Written as an explicit ordered list rather than derived by filtering the MCP
 * registry, so adding a tool there does NOT silently widen the agent's
 * surface — that is a deliberate decision each time, and this file is where it
 * gets made. `./index.ts` resolves each name to its real `AiTool` (and throws
 * at module load if one no longer exists); `./systemPrompt.ts` renders the
 * same list into the prompt's "Tools available" line.
 *
 * A leaf, because both of those consumers need it and `./index.ts`
 * re-exports `./systemPrompt.ts` — importing the list from either one into the
 * other would make the list's own initialisation order depend on a module
 * cycle.
 *
 * What is deliberately absent, in two groups.
 *
 * Everything that existed only because the agent had no filesystem:
 * `studio_read_file`, `studio_list_files`, `studio_create_page`,
 * `studio_apply_edits`, `studio_codemod`, `studio_get_node_source` are all
 * strictly slower than the native `Read`/`Write`/`Edit`/`Glob`/`Grep` the
 * driver now grants (`claudeCliToolSurface.ts`).
 *
 * `studio_find_nodes` was cut with that group and has been put back, because
 * the justification did not actually apply to it. The others answer questions
 * about FILE CONTENT, which the filesystem answers faster. That one answers
 * "what is this element's node id", and a node id is `relFile:line:col` where
 * the column is the tag-name start — a parser-derived fact that Grep cannot
 * produce and that must match exactly. Without it the interaction tools below
 * are unusable from this surface: the agent can see the button and edit the
 * button, and has no way to name it.
 *
 * And the two measurement tools `studio_compare` replaced.
 * `studio_diff_frames` takes its baseline as a base64 STRING; a capture
 * reaches this agent as an MCP image block, which it cannot transcribe back
 * into base64 — offering it a tool it can never successfully call just buys
 * failed turns. `studio_recommend_export_dpr` only ever existed to feed that
 * workflow, and `studio_compare` does the same computation internally.
 *
 * Both groups remain in the MCP registry for external clients, which hold
 * their own bytes and can genuinely use them.
 */
export const STUDIO_AGENT_TOOL_NAMES: readonly string[] = [
  // See the canvas, and measure it.
  'studio_screenshot',
  'studio_compare',
  // Measure the DESIGN, not just the output. `studio_compare` says which
  // rectangle is wrong; it never says what right was. Without this the agent
  // reads colours off a picture by eye and picks type tokens by NAME, which
  // skews consistently large — see `measureReference.ts`.
  'studio_measure_reference',
  // What the screen's CSS actually resolved to. The other half of a fidelity
  // comparison: the reference tools say what the design wants, this says what
  // the build produced. Without it a type or colour mismatch is only inferable
  // from a screenshot, which is how a wrong font-size survives being "fixed".
  'studio_computed_styles',
  'studio_render_reference',
  // A3 (STUDIO-FIGMA-PARITY-PLAN.md) — the reference-free counterpart to
  // studio_compare/studio_measure_reference above: neither has anything to
  // measure a from-scratch screen against, so without this the agent's only
  // signal on a design-less brief was studio_screenshot plus its own
  // subjective judgement of a picture. Statically scans the screen's own
  // stylesheet for one-off values a project token already covers and for
  // same-rule colour pairs that fail WCAG AA contrast.
  'studio_quality_check',
  // The ONE verification studio_compare/studio_screenshot cannot give: does
  // the code the agent just wrote actually compile. Runs the PROJECT's own
  // tsc — see systemPrompt.ts's "not done until it both compares clean AND
  // typechecks" rule.
  'studio_typecheck',
  // The machine-readable "what will not import faithfully" report: turns
  // `PageNode.lockReason`/`resolution`/`codeProps` into stable finding codes
  // with a node id, file:line, and a fix. Was absent here — every OTHER
  // exclusion in this file is justified above; this one was WS-9.4 landing
  // after WS-12's tool curation, not a deliberate cut (STUDIO-FIGMA-PARITY-PLAN.md
  // 0.12). Without it, a `studio_compare` region with no obvious CSS
  // explanation has no path to "why", only more pixel-guessing.
  'studio_fidelity_report',
  'studio_register_design_reference',
  'studio_list_design_references',
  'studio_read_design_reference',
  // The design's OWN declared values (typically read via a connected Figma
  // MCP server's get_variable_defs), so studio_measure_reference can answer
  // "what colour/size does the design say" by lookup instead of inferring it
  // from pixels. Studio never fetches these itself — this is where the agent
  // hands over what IT already fetched. `_delete_` is deliberately excluded
  // from this surface, matching the design-reference tools above: cleanup by
  // id is not a decision this agent needs to make mid-turn.
  'studio_ingest_design_variables',
  'studio_list_design_variables',
  'studio_read_design_variable_set',
  // Board geometry and per-frame axes — state that lives in `.studio/`, not
  // in the source files the agent can write.
  'studio_set_frames',
  'studio_set_frame_axes',
  'studio_duplicate_frame_as_variant',
  // The user's own feedback on the board, as a work queue — and the two writes
  // that close a thread out. Absent until now, which made a routine request
  // impossible to satisfy rather than merely awkward: the panel's own
  // "address these comments" prompt says in as many words "reply in the thread
  // saying what you did, and resolve it", and the agent had no tool that could
  // do either. Measured on a real session (6 threads, 5 open): every edit
  // landed, not one thread was replied to or resolved, and nothing anywhere
  // told the user why. `studio_resolve_comment` re-resolves the anchor against
  // the live tree and refuses a thread whose element has drifted or gone, so
  // the honest-target rule is enforced by the tool, not by the prompt.
  'studio_list_comments',
  'studio_reply_comment',
  'studio_resolve_comment',
  // Interactions — the clickable flow between screens, and the one design
  // layer that is NOT in the user's source. Absent until now, which made
  // "wire the Continue button to the SMS screen" unanswerable rather than
  // merely awkward: the agent could see the button, edit the button, and
  // screenshot the button, but the thing that makes a prototype a prototype
  // was invisible to it. The set tool captures the durable anchor itself, so
  // the agent cannot write a link pointing at nothing.
  // How the agent names an element for the tools below. See the note above on
  // why the filesystem cannot stand in for this one.
  'studio_find_nodes',
  'studio_list_prototype_links',
  'studio_set_prototype_link',
  'studio_delete_prototype_link',
  // Orientation the filesystem cannot answer as cheaply or as truthfully.
  'studio_project_profile',
  'studio_list_pages',
  'studio_list_tokens',
  'studio_list_components',
  'studio_find_component',
  // Assets and dependencies.
  'studio_upload_asset',
  'studio_fetch_remote_asset',
  // The only reachable source for artwork that exists solely inside a design
  // pasted into chat — the case where every other asset path is closed and
  // the alternative was a placeholder box or a CSS-gradient fake.
  'studio_extract_reference_asset',
  'studio_install_deps',
  'studio_install_status',
]
