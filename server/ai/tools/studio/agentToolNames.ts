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
