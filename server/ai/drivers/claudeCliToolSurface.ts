/**
 * `--tools` allowlist for a real `claude` chat turn — split out of
 * `claudeCli.ts` purely to keep that file under the 700-line module-size
 * ceiling (`module-size-budgets.test.ts`); this is one cohesive concern with
 * its own doc comment, the same extraction pattern already used for
 * `claudeCliVerify.ts`, `claudeCliAttachments.ts`, `claudeCliMcpConfigFile.ts`,
 * and `claudeCliSession.ts` in this same directory.
 *
 * ## The agent authors files directly (studio-fs)
 *
 * Screens used to be composed exclusively through `studio_apply_edits`' AST
 * insert engine, with every native file tool withheld. That was safe and
 * unusably slow: each insert reparses the file and shifts every node id, so
 * the agent re-read the world between elements and a single mobile screen
 * cost over twenty minutes — and routinely landed broken, because the path of
 * least resistance through a typed-edit API is one giant inline `style={{…}}`
 * rather than a real stylesheet.
 *
 * A Studio project is an ordinary React repository on disk. Authoring a screen
 * in it is writing a `.tsx` and a `.module.css` — two `Write` calls. So the
 * native file tools are granted whenever a real project is open, and the AST
 * edit engine stays where it is genuinely better than a text edit: the canvas
 * panels' own writeback path (`studioWriteback.ts`), which is not agent code.
 *
 * What bounds a native write is the process, not the tool list: the subprocess
 * is spawned with `cwd` set to the validated project directory
 * (`resolveClaudeCliWorkspaceCwd` — containment-checked against
 * `projectsRoot`), and the CLI's own path permission check refuses a
 * `Write`/`Edit` outside `cwd` plus whatever `--add-dir` pre-authorises (this
 * turn's attachment staging directory, nothing else). `studio-workspace/` is
 * the user's real project data with no other copy; the containment that
 * matters is that the process cannot reach outside the one project it was
 * pointed at.
 *
 * `--tools` (confirmed real via `claude --help`, and already the exact
 * mechanism `claudeCliVerify.ts`'s `--tools ''` uses to strip a verification
 * turn to nothing) is a hard AVAILABILITY list, evaluated independently of and
 * prior to `--permission-mode` — a tool that isn't in this list doesn't exist
 * for the session to be granted permission to, so it is honoured even under a
 * user-selected `bypassPermissions` (see `assertBypassOnlyFromExplicitRequest`'s
 * doc comment in `claudeCli.ts`: permission mode only ever affects PROMPTING
 * for an already-available tool, never widens which tools exist).
 *
 * ## Still withheld, deliberately
 *
 *   - **`Bash`** — the one tool whose blast radius is not bounded by `cwd`. It
 *     is also what trust tier 0 means ("this project runs nothing": no install,
 *     no Sass/Tailwind compilation, no build). Everything a shell would be
 *     reached for here already has a gated tool: `studio_install_deps` for
 *     dependencies, `studio_screenshot` for verification. Never granted, at
 *     any trust tier, in any permission mode.
 *   - **`Task`** — subagents. Removed outright, not narrowed. The CLI does not
 *     error on an unknown `subagent_type`: it silently falls back to its own
 *     built-in `general-purpose` agent and returns as if the work had
 *     happened. Observed exactly that way — the agent delegated screen
 *     authoring to an invented name, reported ten files written in detail, and
 *     every one was still an untouched scaffold. With native file tools in
 *     hand there is nothing a screen-building subagent can do that the main
 *     agent cannot do in one `Write`, and a delegation round-trip is pure
 *     latency, so the fix is to remove the failure mode rather than to keep
 *     describing it in the prompt. What the generated roster used to carry as
 *     agent prompts now lives in the project's generated `CLAUDE.md`
 *     (`server/handlers/studio/projectGuide.ts`), which the CLI loads for free.
 *   - `WebFetch`, `WebSearch`, `NotebookEdit` — no Studio flow needs them;
 *     `studio_fetch_remote_asset` covers the one real remote-read case
 *     (pulling a referenced image into the project) with a containment check.
 *
 * `''` (the CLI's own documented "no tools" value) when no project is open,
 * never omitted: `--tools` must always be passed on a real turn, so a future
 * default flip in the CLI itself can't silently widen this driver back to the
 * full built-in set.
 */

/**
 * Native built-ins granted when a real, containment-checked project is open.
 * `Read`/`Glob`/`Grep` replace `studio_read_file`/`studio_list_files` (same
 * reads, no MCP round trip, and `Read` additionally reaches `node_modules`,
 * which `studio_read_file` refuses by design); `Write`/`Edit` are the
 * authoring path.
 */
const WORKSPACE_NATIVE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const

export function resolveNativeToolAllowlist(workspaceCwd: string | null, hasAttachments: boolean): string {
  if (workspaceCwd) return WORKSPACE_NATIVE_TOOLS.join(',')
  // No project open: the only thing left worth granting is reading back an
  // attachment this turn staged (WS-12 §5.3 — the model is handed the exact
  // staged path and `--add-dir` pre-authorises that directory alone).
  return hasAttachments ? 'Read' : ''
}
