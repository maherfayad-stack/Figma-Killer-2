/**
 * Canvas parity matrix (WS-12 §6.1/§9) — "the agent can do what you can do
 * in the canvas" is checkable, so this is the enforcement mechanism, not
 * documentation: every real editor action is either mapped to a real tool
 * or explicitly withheld with a stated reason. `parityMatrix.test.ts` is the
 * gate that keeps it true — every `tool` entry's name must exist in
 * `studioAgentTools`, and every row must resolve to exactly one status.
 *
 * Verified against the ACTUAL current code, not copied from the WS-12
 * planning doc's own table (which predates most of WS-10/WS-13 landing) —
 * each `tool`/`missing` entry below cites the file it was checked against.
 */

export type ParityStatus =
  | { readonly kind: 'tool'; readonly toolNames: readonly string[] }
  | { readonly kind: 'withheld'; readonly reason: string }
  /** A REAL gap — confirmed against current code, not carried over from a stale doc. */
  | { readonly kind: 'missing'; readonly reason: string }

export interface ParityRow {
  readonly action: string
  readonly status: ParityStatus
}

export const STUDIO_CANVAS_PARITY_MATRIX: readonly ParityRow[] = [
  {
    action: 'Select / inspect a node',
    status: { kind: 'tool', toolNames: ['studio_find_nodes', 'studio_get_node_source'] },
  },
  { action: 'Edit text', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Edit a prop', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Edit styles', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  {
    action: 'Change a tag',
    status: { kind: 'tool', toolNames: ['studio_apply_edits', 'studio_codemod'] },
  },
  { action: 'Insert an element', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Delete an element', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Move / reorder an element', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Replace an image', status: { kind: 'tool', toolNames: ['studio_apply_edits'] } },
  { action: 'Detach a component instance', status: { kind: 'tool', toolNames: ['studio_codemod'] } },
  { action: 'Swap a component instance', status: { kind: 'tool', toolNames: ['studio_codemod'] } },
  { action: 'Extract a component', status: { kind: 'tool', toolNames: ['studio_codemod'] } },
  { action: 'Resize / move a board frame (bulk)', status: { kind: 'tool', toolNames: ['studio_set_frames'] } },
  { action: 'Create a page', status: { kind: 'tool', toolNames: ['studio_create_page'] } },
  { action: 'Read a project file', status: { kind: 'tool', toolNames: ['studio_read_file'] } },
  { action: 'Install dependencies', status: { kind: 'tool', toolNames: ['studio_install_deps'] } },
  { action: 'Poll an install job', status: { kind: 'tool', toolNames: ['studio_install_status'] } },
  { action: 'List projects', status: { kind: 'tool', toolNames: ['studio_list_projects'] } },
  { action: 'Read a project profile (framework/styling/deps)', status: { kind: 'tool', toolNames: ['studio_project_profile'] } },
  { action: 'List pages / board frames', status: { kind: 'tool', toolNames: ['studio_list_pages'] } },
  { action: 'Read the fidelity report', status: { kind: 'tool', toolNames: ['studio_fidelity_report'] } },
  { action: 'Export a frame render', status: { kind: 'tool', toolNames: ['studio_export_frames'] } },
  { action: 'Render a reference screenshot', status: { kind: 'tool', toolNames: ['studio_render_reference'] } },
  { action: 'Diff a frame against a reference', status: { kind: 'tool', toolNames: ['studio_diff_frames'] } },
  {
    action: 'Upload a new asset (image) into the project',
    status: { kind: 'tool', toolNames: ['studio_upload_asset'] },
  },
  {
    action: 'Land a remote (e.g. Figma-exported) asset URL into the project without routing its bytes through the model',
    status: { kind: 'tool', toolNames: ['studio_fetch_remote_asset'] },
  },
  {
    action: 'Set a board frame\'s preview axes (direction/locale/color-scheme override)',
    status: { kind: 'tool', toolNames: ['studio_set_frame_axes'] },
  },
  {
    action: 'Duplicate a board frame as a variant (different axes, same page)',
    status: { kind: 'tool', toolNames: ['studio_duplicate_frame_as_variant'] },
  },
  {
    action: 'Register / remove a durable design reference for later measurement against a frame',
    status: { kind: 'tool', toolNames: ['studio_register_design_reference', 'studio_delete_design_reference'] },
  },

  // ── Deliberately withheld — by design, not by oversight.
  {
    action: 'Promote a project\'s trust tier',
    status: {
      kind: 'withheld',
      reason: 'A consent action — the agent may ask the user to promote a project; it may never perform the promotion itself (D5 §11.2, enforced server-side in studio_install_deps\'s own trust check, which has no tool path to raise the tier).',
    },
  },
  {
    action: 'Undo / redo',
    status: {
      kind: 'withheld',
      reason: 'The user\'s own safety net over the agent\'s own writes stays the user\'s — an agent that can undo the user\'s manual edits (or redo its own after the user undid them) defeats the point of the control existing.',
    },
  },
  {
    action: 'Pan / zoom / marquee-select the canvas viewport',
    status: { kind: 'withheld', reason: 'Viewport position is not document state — nothing for a tool to change that would mean anything once the turn ends.' },
  },
  {
    action: 'Delete a project',
    status: { kind: 'withheld', reason: 'studio-workspace/* is the user\'s real project data with no other copy (trap #12) — no tool the agent holds may reach a delete-the-project path, full stop.' },
  },
  {
    action: 'Run a raw shell command',
    status: { kind: 'withheld', reason: 'Deliberately never added (WS-12 §3) — breaks invariant 2 (a write must have exactly one honest target).' },
  },
  {
    action: 'Overwrite a file\'s full contents directly',
    status: { kind: 'withheld', reason: 'Deliberately never added (WS-12 §3) — the same invariant a raw shell command would break; every write goes through a typed edit kind or codemod verb instead.' },
  },
]
