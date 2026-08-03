/**
 * `--tools` allowlist for a real `claude` chat turn (sec-XX) — split out of
 * `claudeCli.ts` purely to keep that file under the 700-line module-size
 * ceiling (`module-size-budgets.test.ts`); this is one cohesive concern with
 * its own doc comment, the same extraction pattern already used for
 * `claudeCliVerify.ts`, `claudeCliAttachments.ts`, `claudeCliMcpConfigFile.ts`,
 * and `claudeCliSession.ts` in this same directory.
 *
 * ## Why this exists
 *
 * Every real Studio operation this driver's system prompt tells the model to
 * use already has an MCP tool — read (`studio_read_file`,
 * `studio_get_node_source`), write (`studio_apply_edits`/`studio_codemod`,
 * routed through the AST-codemod "exactly one honest target" engine), page
 * creation (`studio_create_page`), and dependency install
 * (`studio_install_deps`, trust-tier- and capability-gated). Every one of
 * those is containment-checked, trust-tier-checked, and `.studio/`-excluded
 * in the ONE place every path shares (`resolveSafeWorkspaceFile`,
 * `studioWriteback.ts`'s `studioEditLocation`) — none of that exists for the
 * CLI's own native `Bash`/`Write`/`Edit`/`Read`/`Glob`/`Grep`/`WebFetch`
 * tools, which is exactly why `agentRoster.ts` gives every GENERATED
 * subagent an explicit, non-empty-or-omitted `tools:` allowlist instead of
 * leaving it unset (that file's own doc comment: omitting `tools` "would
 * silently hand a subagent a shell and a raw file-write path — exactly the
 * two things WS-12 explicitly withholds"). Before this fix, that discipline
 * covered every SUBAGENT but not the session `claudeCli.ts` itself spawns —
 * the top-level `claude` process had no `--tools`/`--allowedTools`
 * restriction at all, so it could reach `Bash`/`Write`/`Edit` directly,
 * bypassing every one of the gates above. `../tools/studio/systemPrompt.ts`'s
 * own static prefix already told the model "No filesystem or shell access
 * outside these tools" and "There is no shell tool, no raw file-overwrite
 * tool" — both were FALSE for the process the model was actually running in.
 *
 * `--tools` (confirmed real via `claude --help`, and already the exact
 * mechanism `claudeCliVerify.ts`'s `--tools ''` uses to strip a verification
 * turn to nothing) is a hard AVAILABILITY list, evaluated independently of
 * and prior to `--permission-mode` — a tool that isn't in this list doesn't
 * exist for the session to be granted permission to, so it is honoured even
 * under a user-selected `bypassPermissions` (see
 * `assertBypassOnlyFromExplicitRequest`'s doc comment in `claudeCli.ts`:
 * permission mode only ever affects PROMPTING for an already-available tool,
 * never widens which tools exist).
 *
 * `resolveNativeToolAllowlist` grants at most two built-ins, each for a
 * specific, verified reason — everything else (`Bash`, `Write`, `Edit`,
 * `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEdit`, …) is withheld
 * unconditionally, on every turn, regardless of trust tier (trust tiers
 * gate MCP-mediated capabilities like `studio_install_deps`; they were
 * never meant to gate a raw shell, and nothing in this driver grants one at
 * any tier):
 *
 *   - `Task`, ONLY when a real project is open (`workspaceCwd` truthy) —
 *     the one thing genuinely not reachable through MCP: dispatching to the
 *     WS-12 §7 subagent roster (`agentRoster.ts`) generated into
 *     `<project>/.claude/agents/`. Every GENERATED subagent already carries
 *     its own explicit `tools:` allowlist that can never include a shell or
 *     a raw write (`agentRoster.ts`'s `assertKnownTools` — "hold no tool
 *     the main agent itself does not have" — an invariant this fix is what
 *     actually makes load-bearing: before it, the main agent held every
 *     tool, so that ceiling was a no-op). The CLI ALSO merges its own
 *     built-in default agent types into the same roster (`general-purpose`,
 *     `Explore`, `Plan` — confirmed via the installed binary's own embedded
 *     prompt text: "general-purpose … have access to all tools including
 *     file editing, writing, and bash"), and Task defaults to
 *     `general-purpose` when the model omits a `subagent_type`. This
 *     driver's `--tools` list is the SESSION's tool ceiling, and every
 *     subagent — generated or built-in — is bounded by it, never able to
 *     manifest a tool the session itself was never given; this is the same
 *     ceiling property `assertKnownTools` already assumes for the generated
 *     roster. **Not independently proven against the real binary with a
 *     live turn** (this driver's tests must never spend real money — see
 *     "Tests never spawn the real binary" in `docs/features/agent.md`) —
 *     strong circumstantial evidence only (the CLI's own dynamically-built
 *     per-session agent/tool listing, and `assertKnownTools`'s pre-existing
 *     design assumption). If you get the chance to run one real, cheap turn
 *     to settle this for good, see `STATE.md`'s `sec-XX` entry for the exact
 *     probe.
 *   - `Read`, ONLY when this turn staged an attachment (`hasAttachments`
 *     truthy — see the caller's `files.length > 0` note, NOT merely a
 *     non-null staging result, which can be refusal-only) — WS-12 §5.3's
 *     image/file attachment mechanism has the model "read them with your
 *     own file tools" (`claudeCliAttachments.ts`'s
 *     `describeAttachmentsForPrompt`) at the exact path Studio staged them
 *     to; there is no MCP tool that reads a file into a vision content
 *     block, so this is genuinely load-bearing, not redundant with
 *     `studio_read_file`. `--add-dir` pre-authorises only the staging
 *     directory, so this doesn't imply a standing permission to read the
 *     rest of the host — `--permission-mode` still gates a `Read` outside
 *     `cwd`/`--add-dir`.
 *
 * `''` (the CLI's own documented "no tools" value) when neither applies,
 * never omitted: `--tools` must always be passed on a real turn, so a future
 * default flip in the CLI itself can't silently widen this driver back to
 * the full built-in set.
 */
export function resolveNativeToolAllowlist(workspaceCwd: string | null, hasAttachments: boolean): string {
  const allowed: string[] = []
  if (workspaceCwd) allowed.push('Task')
  if (hasAttachments) allowed.push('Read')
  return allowed.join(',')
}
