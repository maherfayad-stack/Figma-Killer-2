/**
 * Canvas parity matrix — "the agent can do what you can do in the canvas" is
 * checkable, so this is the enforcement mechanism, not documentation: every
 * real editor action resolves to exactly one status, and every named tool is
 * one the agent actually holds. `parityMatrix.test.ts` is the gate.
 *
 * Three ways an action can be covered, and the distinction is the point:
 *
 *   - `native` — done with the CLI's own tools (`Read`/`Write`/`Edit`/
 *     `Glob`/`Grep`/`Task`), which the driver grants scoped to the project
 *     `cwd` (`claudeCliToolSurface.ts`). Most source editing lives here now. It is
 *     a separate status from `tool` rather than folded into it because these
 *     rows carry no Studio-side gate at all — they are bounded by the
 *     subprocess's working directory, not by a capability check — and a
 *     reader of this table must be able to see that difference.
 *   - `tool` — a real Studio tool the agent is offered
 *     (`agentToolNames.ts`). On the HTTP drivers, which have no native tools,
 *     the `native` rows are done through the file-authoring `tool` row below
 *     (P4-C): the same edit, landed by Studio instead of by the CLI.
 *   - `withheld` — deliberately not available, with the reason stated.
 *
 * The AST edit tools (`studio_apply_edits`, `studio_codemod`) still exist and
 * are still what the canvas PANELS write through (`studioWriteback.ts`); they
 * are simply not part of the agent's surface, so they cannot appear as a
 * `tool` status here.
 *
 * ## The inverse direction, and the one escape from it
 *
 * The gate also runs the table backwards: every registered
 * `sideEffects: 'write'` tool must be named by some row, because a write tool
 * that maps to no editor
 * action is either undocumented here or should not exist. A tool that
 * genuinely has no canvas counterpart says so on ITSELF —
 * `AiTool.headlessOnly`, a sentence stating why — and the gate reads that
 * field. There is deliberately no allowlist in the test: a name on a list
 * inside a test file is a gate switched off, while a sentence on the tool is
 * a claim the next reader can check and `docs/features/agent.md` renders.
 */

export type ParityStatus =
  | { readonly kind: 'tool'; readonly toolNames: readonly string[] }
  /** Done with the CLI's own file tools inside the project `cwd` — no Studio tool involved. */
  | { readonly kind: 'native'; readonly how: string }
  | { readonly kind: 'withheld'; readonly reason: string }
  /** A REAL gap — confirmed against current code, not carried over from a stale doc. */
  | { readonly kind: 'missing'; readonly reason: string }

export interface ParityRow {
  readonly action: string
  readonly status: ParityStatus
}

export const STUDIO_CANVAS_PARITY_MATRIX: readonly ParityRow[] = [
  // ── Source editing: the agent's own file tools, inside the project cwd.
  {
    action: 'Select / inspect a node',
    status: { kind: 'native', how: 'A node id IS a source location (relFile:line:col) — the live selection is in the prompt, and Read opens that file at that line.' },
  },
  { action: 'Edit text', status: { kind: 'native', how: 'Edit — exact string replacement at the literal.' } },
  { action: 'Edit a prop', status: { kind: 'native', how: 'Edit — the prop is a literal in the JSX.' } },
  { action: 'Edit styles', status: { kind: 'native', how: "Edit on the screen's own stylesheet, which is where real styling belongs." } },
  { action: 'Change a tag', status: { kind: 'native', how: 'Edit — both the opening and the closing tag.' } },
  { action: 'Insert an element', status: { kind: 'native', how: 'Edit, or Write for a whole screen — the case that used to cost one AST round trip per element.' } },
  { action: 'Delete an element', status: { kind: 'native', how: 'Edit.' } },
  { action: 'Move / reorder an element', status: { kind: 'native', how: 'Edit.' } },
  { action: 'Replace an image', status: { kind: 'native', how: 'Edit the src, after studio_upload_asset or studio_fetch_remote_asset lands the file.' } },
  { action: 'Detach a component instance', status: { kind: 'native', how: 'Read the component source, then Edit its JSX into the call site.' } },
  { action: 'Swap a component instance', status: { kind: 'native', how: 'Edit the element name and its import.' } },
  { action: 'Extract a component', status: { kind: 'native', how: 'Write the new component file, then Edit the call site to import it.' } },
  { action: 'Create a page', status: { kind: 'native', how: 'Write the component file and its stylesheet; studio_screenshot places the board frame on the first capture.' } },
  { action: 'Read a project file', status: { kind: 'native', how: 'Read, Glob, Grep on the claude CLI path; studio_read_file, studio_list_files, studio_grep and studio_get_node_source on the HTTP drivers.' } },
  { action: 'List projects', status: { kind: 'native', how: 'Exactly one project is open per turn and its path is already in the prompt.' } },

  {
    // The HTTP drivers' way to do every `native` edit row above: an API key
    // gives the model no file tools of its own (AI-2).
    action: 'Write or edit a source file on an HTTP driver (API key, OpenAI, OpenRouter, Ollama, custom)',
    status: { kind: 'tool', toolNames: ['studio_write_file', 'studio_edit_file', 'studio_edit_files'] },
  },

  // ── Studio tools: what the filesystem cannot do.
  { action: 'Resize board frames (bulk)', status: { kind: 'tool', toolNames: ['studio_set_frames'] } },
  {
    // AI-17 — the canvas drags frames and the agent could not: `set_frames`
    // sizes only, so "put the variants side by side" had no tool behind it.
    action: 'Move board frames — explicit x/y, a row, a column or a grid — with a note on each',
    status: { kind: 'tool', toolNames: ['studio_arrange_frames'] },
  },
  {
    // AI-15 — the Framework/token panel edits a token's value in place; the
    // agent's equivalent is one CST edit on the declaration that wins.
    action: "Change a design token's value (light or dark)",
    status: { kind: 'tool', toolNames: ['studio_set_tokens'] },
  },
  { action: 'Install dependencies', status: { kind: 'tool', toolNames: ['studio_install_deps'] } },
  { action: 'Poll an install job', status: { kind: 'tool', toolNames: ['studio_install_status'] } },
  { action: 'Confirm the code just written actually compiles', status: { kind: 'tool', toolNames: ['studio_typecheck'] } },
  // AI-21 — the Problems view a developer reads next to the canvas.
  { action: "Check the code just written against the project's own lint rules (Tier 2)", status: { kind: 'tool', toolNames: ['studio_lint'] } },
  { action: 'Read a project profile (framework/styling/deps)', status: { kind: 'tool', toolNames: ['studio_project_profile'] } },
  { action: 'List pages / board frames', status: { kind: 'tool', toolNames: ['studio_list_pages'] } },
  { action: 'See what a screen actually looks like', status: { kind: 'tool', toolNames: ['studio_screenshot'] } },
  { action: 'Render a reference screenshot', status: { kind: 'tool', toolNames: ['studio_render_reference'] } },
  { action: 'Measure a screen against the design it must match', status: { kind: 'tool', toolNames: ['studio_compare'] } },
  {
    // `studio_compare` scores the OUTPUT; this reads the INPUT. Separate rows
    // because they answer different questions — "which rectangle is wrong"
    // versus "what does the design actually say" — and having only the first
    // is what left colours and type sizes to be guessed off a picture.
    action: "Read the design's own colours and type sizes (with the matching project token)",
    status: { kind: 'tool', toolNames: ['studio_measure_reference'] },
  },
  {
    // The canvas's own ruler/measure affordance, and the third leg beside the
    // two rows above: `studio_measure_reference` reads the design, this reads
    // the OUTPUT's rendered boxes and the gaps between them. Without it,
    // spacing was the one dimension the agent could only estimate off a
    // picture — `studio_computed_styles` had already removed the equivalent
    // guesswork for type.
    action: "Measure the rendered geometry of a screen's own elements (boxes, padding, gaps to siblings)",
    status: { kind: 'tool', toolNames: ['studio_measure_element'] },
  },
  {
    action: 'Upload a new asset (image) into the project',
    status: { kind: 'tool', toolNames: ['studio_upload_asset'] },
  },
  {
    action: 'Land a remote (e.g. Figma-exported) asset URL into the project without routing its bytes through the model',
    status: { kind: 'tool', toolNames: ['studio_fetch_remote_asset'] },
  },
  {
    action: 'Extract artwork that exists only inside the supplied design (hero image, logo, badge) into a real project file',
    status: { kind: 'tool', toolNames: ['studio_extract_reference_asset'] },
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
    status: { kind: 'tool', toolNames: ['studio_register_design_reference', 'studio_list_design_references', 'studio_read_design_reference'] },
  },
  {
    action: "Record a design's own declared variable table so a measurement resolves by lookup instead of by pixel inference",
    status: { kind: 'tool', toolNames: ['studio_ingest_design_variables', 'studio_list_design_variables', 'studio_read_design_variable_set'] },
  },
  {
    // The composite of three rows above, and a real editor action in its own
    // right: the user's version is attach the design (the reference-upload
    // panel, `uploadDesignReference.ts` -> `POST /admin/api/studio/
    // reference-upload`), then drag the board frame to the design's own size
    // so the comparison is exact rather than resampled. One tool because the
    // ORDER is what a weaker model got wrong, not any single leg.
    action: 'Arm a screen against a supplied design — attach it, record its variables, and size the board frame to it',
    status: { kind: 'tool', toolNames: ['studio_import_figma_frame'] },
  },
  {
    action: 'Read the board\'s review comment threads, reply in one, and resolve it',
    status: { kind: 'tool', toolNames: ['studio_list_comments', 'studio_reply_comment', 'studio_resolve_comment'] },
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
    status: { kind: 'withheld', reason: 'No Bash, at any trust tier, in any permission mode — the one tool whose blast radius is not bounded by the project cwd. Dependency installs go through studio_install_deps, which IS trust-tier gated.' },
  },
  {
    // Granted since `claudeCliToolSurface.ts` put `Task` back in
    // `WORKSPACE_NATIVE_TOOLS`; this row said "withheld" for a wave after
    // that, and agent.md repeated it (AI-24).
    action: 'Delegate to a subagent',
    status: { kind: 'native', how: "Task, with subagent_type 'general-purpose' and nothing else — granted on the claude CLI path whenever a project is open (claudeCliToolSurface.ts). One subagent per page, and that page's .tsx and .module.css are the subagent's alone; every shared file stays the orchestrator's. The HTTP drivers have no delegation tool." },
  },
  {
    action: 'Reach a file outside the open project',
    status: { kind: 'withheld', reason: "The subprocess cwd is the containment-checked project directory, and the CLI refuses a write outside it plus --add-dir (this turn's attachment staging, nothing else). On the HTTP drivers every file tool goes through one containment rule (agentFileAccess.ts): inside the project on the real path, never into .studio/.claude/.git/node_modules, never a credential file." },
  },
]
