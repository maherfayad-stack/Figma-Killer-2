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
 * What is deliberately absent: everything that existed only because the agent
 * had no filesystem. `studio_read_file`, `studio_list_files`,
 * `studio_create_page`, `studio_apply_edits`, `studio_codemod`,
 * `studio_find_nodes`, `studio_get_node_source` are all strictly slower than
 * the native `Read`/`Write`/`Edit`/`Glob`/`Grep` the driver now grants
 * (`claudeCliToolSurface.ts`). They remain in the MCP registry for external
 * clients that genuinely cannot touch the filesystem.
 */
export const STUDIO_AGENT_TOOL_NAMES: readonly string[] = [
  // See the canvas.
  'studio_screenshot',
  'studio_diff_frames',
  'studio_render_reference',
  'studio_register_design_reference',
  'studio_list_design_references',
  'studio_read_design_reference',
  'studio_recommend_export_dpr',
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
  'studio_install_deps',
  'studio_install_status',
]
