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
 * `studio_apply_edits`, `studio_codemod`, `studio_find_nodes`,
 * `studio_get_node_source` are all strictly slower than the native
 * `Read`/`Write`/`Edit`/`Glob`/`Grep` the driver now grants
 * (`claudeCliToolSurface.ts`).
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
  'studio_render_reference',
  // A3 (STUDIO-FIGMA-PARITY-PLAN.md) — the reference-free counterpart to
  // studio_compare/studio_measure_reference above: neither has anything to
  // measure a from-scratch screen against, so without this the agent's only
  // signal on a design-less brief was studio_screenshot plus its own
  // subjective judgement of a picture. Statically scans the screen's own
  // stylesheet for one-off values a project token already covers and for
  // same-rule colour pairs that fail WCAG AA contrast.
  'studio_quality_check',
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
  // Board geometry and per-frame axes — state that lives in `.studio/`, not
  // in the source files the agent can write.
  'studio_set_frames',
  'studio_set_frame_axes',
  'studio_duplicate_frame_as_variant',
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
