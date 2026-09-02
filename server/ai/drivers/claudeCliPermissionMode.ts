/**
 * `--permission-mode` resolution for a real `claude` chat turn — split out of
 * `claudeCli.ts` to keep that file under the 700-line module-size ceiling
 * (`module-size-budgets.test.ts`), the same extraction pattern already used
 * for `claudeCliToolSurface.ts`, `claudeCliVerify.ts`, and
 * `claudeCliAttachments.ts`. One cohesive concern: which mode reaches argv,
 * and the guard rail that keeps `bypassPermissions` something the CLIENT
 * asked for rather than something this driver can arrive at on its own.
 */

export type ClaudeCliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/**
 * `--permission-mode` fallback when the request names none. **Never a bypass
 * value in either branch, and that is deliberate even though Bypass is now
 * the Studio panel's default.**
 *
 * The two are not in tension. The panel sends `bypassPermissions` explicitly
 * on every turn (`agentSessionControlsInitialState`), so this fallback is only
 * ever reached by a caller that named no mode at all — an external MCP client,
 * a script, a future driver. Silence from such a caller is not a person
 * choosing Bypass, and inventing it for them is exactly the "Studio must never
 * inject a bypassing flag on its own" rule this module exists to hold.
 *
 * With a project open, the agent's whole job is editing files in that project
 * — it holds `Write`/`Edit` scoped to the project `cwd`
 * (`claudeCliToolSurface.ts`) and nothing else. Under `'default'` the CLI
 * stops and asks before every single file write, which Studio relays as an
 * Allow/Deny card: a dozen identical questions to author one screen, each one
 * asking permission to do the thing the user just asked for. `acceptEdits`
 * auto-accepts file edits *inside the working directory* and nothing beyond
 * it, which is exactly the consent a caller gave by naming a project.
 *
 * With no project open there is nothing scoped to accept edits into, so the
 * conservative `'default'` stands.
 */
const DEFAULT_PERMISSION_MODE = 'default'
const DEFAULT_PROJECT_PERMISSION_MODE = 'acceptEdits'

/**
 * `--permission-mode` accepts exactly WS-12 §5.2's four modes (plus
 * `auto`/`dontAsk`, confirmed via `--help` but not part of the user-facing
 * four) — a 1:1 mapping, no translation layer.
 *
 * **`bypassPermissions` is allowed, but only when the REQUEST carried it.**
 * An earlier version of this function refused it outright, reading this
 * driver's "never pass a permission-bypassing flag" hard rule as covering any
 * occurrence of the literal value. The coordinator who set that rule resolved
 * the contradiction directly: the rule means *Studio must never inject a
 * bypassing flag on its own* — no silent server-side default, no working
 * around a prompt the caller would otherwise see. It does not mean refusing a
 * mode the client deliberately sent.
 *
 * Bypass is now the Studio panel's own default
 * (`agentSessionControlsInitialState`), which retires the older, stronger
 * claim that it was "never a default, never persisted". What is left is the
 * half that still means something and is still enforced HERE: this driver
 * never resolves to Bypass from silence. Read that initializer before changing
 * anything in this file — it carries the reasoning, and the specific note that
 * permission mode governs PROMPTING for an already-available tool and never
 * widens which tools exist.
 *
 * What stays permanently forbidden, unconditionally: `--dangerously-skip-
 * permissions` / `--allow-dangerously-skip-permissions` — a different,
 * blunter flag this driver's argv never constructs anywhere, checked or not.
 * `--permission-mode bypassPermissions` is the CLI's own documented mode,
 * distinct from that flag, and is the one this function resolves.
 *
 * What still holds around Bypass, enforced OUTSIDE this function:
 *   1. Visibly indicated — `AgentSessionControls.tsx`'s composer trigger
 *      carries a warning glyph and a descriptive accessible name whenever the
 *      mode is Bypass, on the control that sets it rather than in a separate
 *      banner, so it cannot drift out of sync with the actual state. (Its
 *      `tone="danger"` was dropped when Bypass became the default — a red on
 *      every session is wallpaper, not an indication.)
 *   2. Still trust-tier-bound — Bypass has NO effect on tool-level
 *      authorization at all. `studio_install_deps`'s trust check
 *      (`projectTools.ts`) reads only `.studio/meta.json`'s own `trust`
 *      field; it has no parameter for permission mode to influence, tested
 *      explicitly in `projectTools.test.ts`.
 *   3. No wider tool surface — `--tools` (`claudeCliToolSurface.ts`) is a hard
 *      availability list the CLI evaluates independently of and prior to
 *      `--permission-mode`, so `Bash`/`Task` stay withheld under Bypass, and a
 *      native write stays bounded by the subprocess `cwd`.
 */
export function resolvePermissionMode(
  requested: string | undefined,
  projectOpen: boolean,
): { ok: true; mode: ClaudeCliPermissionMode } | { ok: false; message: string } {
  const mode = requested ?? (projectOpen ? DEFAULT_PROJECT_PERMISSION_MODE : DEFAULT_PERMISSION_MODE)
  if (mode !== 'default' && mode !== 'acceptEdits' && mode !== 'plan' && mode !== 'bypassPermissions') {
    return { ok: false, message: `Unknown permission mode "${mode}".` }
  }
  return { ok: true, mode }
}


/**
 * Belt-and-braces: `bypassPermissions` may only ever reach argv when
 * `req.permissionMode` itself carried that exact literal.
 *
 * Renamed from `assertBypassOnlyFromExplicitRequest` when Bypass became the
 * Studio panel's default, because that name had stopped being true — the
 * request now carries Bypass because a default put it there, not because
 * someone selected it this turn, and a guard whose name overstates what it
 * checks is worse than no guard. What it does check is still worth checking
 * and is unchanged: the resolved mode came from the REQUEST, never from this
 * driver's own fallback. A caller that names no mode can never be given
 * Bypass by inference.
 */
export function assertBypassCameFromRequest(
  mode: ClaudeCliPermissionMode,
  requestedMode: string | undefined,
): string {
  if (mode === 'bypassPermissions' && requestedMode !== 'bypassPermissions') {
    throw new Error('[ai/claudeCli] refused to construct --permission-mode bypassPermissions from a server-side default — it may only ever come from the request.')
  }
  return mode
}
