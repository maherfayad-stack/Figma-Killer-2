/**
 * importSetupPass — the brief the agent is handed the moment a project lands.
 *
 * An imported repository is almost never ready to design in. It has
 * dependencies Studio cannot resolve, aliases the parser does not know, values
 * that only exist at runtime, and no board layout at all. Every one of those
 * shows up as a lock icon or an empty frame, and until now the user met them
 * one at a time, by hand, on a codebase they had just pulled in and had not
 * read yet.
 *
 * So the import runs a setup pass: the project opens, the agent opens with it,
 * and its first turn is this brief.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PERSISTED
 * ─────────────────────────────────────────────────────────────────────────
 * The pending dir lives in a module variable and nowhere else. `import` fires
 * `requestCmsSiteReload()`, which is an in-app event and not a page reload, so
 * module state survives exactly as long as it needs to and no longer.
 *
 * Putting it in localStorage would be worse than useless: a browser refresh
 * hours later would re-run a setup pass against a project the user had since
 * spent an afternoon editing, and the agent would "fix" their work back toward
 * what the importer produced.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE BRIEF DELIBERATELY DOES NOT SAY
 * ─────────────────────────────────────────────────────────────────────────
 * It does not tell the agent to invent flows. Wiring interactions is in scope,
 * but only where the source ALREADY navigates — a real router push between two
 * imported pages is a fact about the project, and drawing it makes the
 * prototype clickable without anyone guessing what the designer meant. A
 * flow the agent made up would be indistinguishable, on the board, from one
 * the user drew.
 */

/**
 * The directory awaiting a setup pass, or null.
 *
 * At most one: a second import before the first pass starts means the user
 * changed their mind about which project they are opening.
 */
let pendingDir: string | null = null

/** Queue the setup pass for a freshly imported project. */
export function requestImportSetupPass(dir: string): void {
  pendingDir = dir
}

/** Take the pending dir, if any. Consuming it is what stops it running twice. */
export function consumeImportSetupPass(): string | null {
  const dir = pendingDir
  pendingDir = null
  return dir
}

/** Drop a queued pass without running it — used when the editor never mounts. */
export function clearImportSetupPass(): void {
  pendingDir = null
}

/**
 * The first turn's message.
 *
 * Written as an ordered checklist because the steps genuinely depend on each
 * other: nothing parses until the dependencies are installed, the fidelity
 * report is meaningless before that, and frame sizes cannot be chosen before
 * the pages render. An unordered list of goals produced turns that installed
 * dependencies last.
 */
export function importSetupBrief(projectName: string): string {
  return [
    `I just imported "${projectName}" into Studio. Set it up so it works well here, in this order, then tell me what you changed and what you could not.`,
    '',
    '1. Read studio_project_profile and note the framework, styling toolchain, package manager and any warnings. Read the generated CLAUDE.md if there is one. Do not re-derive this by grepping.',
    '',
    '2. Install missing dependencies with studio_install_deps and poll studio_install_status until it finishes. Nothing below is trustworthy until the project can resolve its own imports.',
    '',
    '3. Fix the configuration that stops pages parsing — path aliases, an entry file Studio cannot find, a styling setup that is declared but not wired. These are the edits that turn empty frames into real ones.',
    '',
    '4. Run studio_fidelity_report and fix what it flags in the source. This is the user\'s own code: make the smallest change that resolves each finding, keep their conventions, and never replace a binding with the value it happened to resolve to. Leave a finding alone and say so when fixing it would mean rewriting how their screen works.',
    '',
    '5. Screenshot the pages with studio_screenshot and give each frame a sensible device size with studio_set_frames. A board where every frame is the default width is a board nobody arranged.',
    '',
    '6. Wire the interactions that ALREADY EXIST in the code. Where a page really navigates to another page — a router push, a link between two imported screens — draw it with studio_set_prototype_link so the prototype is clickable. Do not invent flows: if you think two screens should connect but the source does not say so, list it for me instead of drawing it.',
    '',
    'Report at the end: what you installed, what you fixed, what you left and why, and any flow you noticed but did not wire. If something needs a decision only I can make, stop and ask rather than guessing.',
  ].join('\n')
}
