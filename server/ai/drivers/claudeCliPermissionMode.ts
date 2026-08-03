/**
 * `--permission-mode` resolution for a real `claude` chat turn — split out of
 * `claudeCli.ts` to keep that file under the 700-line module-size ceiling
 * (`module-size-budgets.test.ts`), the same extraction pattern already used
 * for `claudeCliToolSurface.ts`, `claudeCliVerify.ts`, and
 * `claudeCliAttachments.ts`. One cohesive concern: which mode reaches argv,
 * and the guard rail that keeps `bypassPermissions` a deliberate per-turn
 * user choice rather than something Studio can arrive at on its own.
 */

export type ClaudeCliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/**
 * `--permission-mode` fallback when the request names none. Never a bypass
 * value in either branch.
 *
 * With a project open, the agent's whole job is editing files in that project
 * — it holds `Write`/`Edit` scoped to the project `cwd`
 * (`claudeCliToolSurface.ts`) and nothing else. Under `'default'` the CLI
 * stops and asks before every single file write, which Studio relays as an
 * Allow/Deny card: a dozen identical questions to author one screen, each one
 * asking permission to do the thing the user just asked for. `acceptEdits`
 * auto-accepts file edits *inside the working directory* and nothing beyond
 * it, which is exactly the consent the user already gave by opening the
 * project and asking for a screen. Every other permission-bearing tool still
 * prompts, and trust tiers are untouched (`studio_install_deps` reads
 * `.studio/meta.json`, never the permission mode).
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
 * **`bypassPermissions` is allowed, but ONLY as an explicit per-turn user
 * choice — never a default, never inferred, never persisted.** An earlier
 * version of this function refused it outright, reading this driver's "never
 * pass a permission-bypassing flag" hard rule as covering any occurrence of
 * the literal value. The coordinator who set that rule resolved the
 * contradiction directly: the rule means *Studio must never inject a
 * bypassing flag on its own* — no silent default, no working around a
 * prompt the user would otherwise see. It does not mean refusing a mode the
 * user deliberately selected; a user choosing Bypass IS the consent, not
 * something bypassing it. WS-12 §5.2 (and the user's own words specifying
 * this feature — "the mode is it auto, bypass, or ask before edits or just
 * plan") name Bypass as one of exactly four modes the user controls.
 *
 * What stays permanently forbidden, unconditionally: `--dangerously-skip-
 * permissions` / `--allow-dangerously-skip-permissions` — a different,
 * blunter flag this driver's argv never constructs anywhere, checked or not.
 * `--permission-mode bypassPermissions` is the CLI's own documented mode,
 * distinct from that flag, and is the one this function resolves.
 *
 * The three D5 §11.5 guard rails on Bypass are enforced OUTSIDE this
 * function, each independently:
 *   1. Non-persisting — `agentSlice.ts` initializes `agentPermissionMode:
 *      'default'` at store creation (covers reload) and nothing anywhere
 *      reads it from storage; `AgentSessionControls.tsx` also resets it on
 *      a live project switch (no remount needed).
 *   2. Visibly indicated — `AgentSessionControls.tsx`'s composer trigger
 *      switches to `tone="danger"` with a warning icon, and stays that way
 *      the entire time `agentPermissionMode === 'bypassPermissions'`. The
 *      indication is permanent and non-dismissible, not a one-time toast;
 *      it lives on the control that sets the mode rather than in a separate
 *      banner, so it cannot drift out of sync with the actual state.
 *   3. Still trust-tier-bound — Bypass has NO effect on tool-level
 *      authorization at all. `studio_install_deps`'s trust check
 *      (`projectTools.ts`) reads only `.studio/meta.json`'s own `trust`
 *      field; it has no parameter for permission mode to influence, tested
 *      explicitly in `projectTools.test.ts`.
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
 * `req.permissionMode` itself carried that exact literal — i.e. a user
 * selected it THIS turn. `default` is what every other path (no selection,
 * an unrecognised value already refused above, a stale/reset session)
 * resolves to, so this assertion is really "the resolved mode came from the
 * request, not from a default" — cheap to state, cheap to keep true.
 */
export function assertBypassOnlyFromExplicitRequest(
  mode: ClaudeCliPermissionMode,
  requestedMode: string | undefined,
): string {
  if (mode === 'bypassPermissions' && requestedMode !== 'bypassPermissions') {
    throw new Error('[ai/claudeCli] refused to construct --permission-mode bypassPermissions without an explicit per-turn request — this must never be a default or inferred value.')
  }
  return mode
}
