/**
 * AgentSessionControls — the composer's LEFT-edge session triggers:
 * permission mode (WS-6 / D5 §11.5) and, beside it, W9-2's fidelity mode.
 * Model selection + reasoning effort live together in `ModelEffortPicker`'s
 * single trigger + menu on the composer's right edge.
 *
 * Two triggers rather than one menu with two submenus, because they answer
 * different questions — permission mode is "may you", fidelity is "how well".
 *
 * Permission mode is the `claudeCli`-only knob, `--permission-mode`. A no-op
 * for every other provider — the server silently ignores it (`AiStreamRequest`'s
 * own doc comment) — so this trigger is safe to show regardless of which
 * provider the active conversation is using.
 *
 * **Bypass is the DEFAULT mode**, not an escalation from one — see
 * `agentSessionControls.ts`'s initializer for the reasoning and for the
 * boundaries it does not move. That retires D5 §11.5's rail 1
 * ("non-persisting"), which existed to stop Studio arriving at Bypass without
 * the user; it is now where the user is put deliberately. The other two rails
 * survive, one of them altered:
 *
 *   1. **Visibly indicated** — the trigger carries a warning glyph and a
 *      descriptive accessible name whenever the mode is Bypass, in the
 *      composer's own control row (not the scrollable thread), so it cannot
 *      scroll out of view. The `danger` TONE was dropped when Bypass became
 *      the default: a red that is on every session for every user is not an
 *      indication, it is wallpaper, and it drains the colour of meaning
 *      everywhere else it is used. The trigger's own label already reads
 *      "Bypass"; the glyph marks it as the loosest of the four. The menu ITEM
 *      keeps `danger`, where it is still doing real work — distinguishing the
 *      options from each other at the moment of choosing.
 *   2. **Still trust-tier-bound** — owned entirely server-side
 *      (`studio_install_deps`'s trust check in `projectTools.ts`, which has
 *      no permission-mode parameter to read in the first place); nothing in
 *      this component or in Bypass mode itself can touch it.
 *
 * What has NOT changed, and must not: the server still never resolves to
 * Bypass on its own (`claudeCliPermissionMode.ts`'s
 * `assertBypassCameFromRequest`). It reaches argv only because this client
 * sent it.
 *
 * Also renders `RestartSessionButton` — a second, unrelated composer-row
 * control that happens to share this file because it is likewise a
 * `claudeCli`-only session knob with no other natural home. It lets the user
 * force a brand-new `claude` CLI session (so a newly-approved MCP server or
 * other per-spawn config takes effect) WITHOUT discarding the Studio-side
 * conversation transcript — the only prior escape hatch was "New chat"
 * (`ConversationHistory.tsx`), which throws the transcript away too. See
 * `restartAgentSession` (`@admin/ai/api`) and migration 021's
 * `session_epoch` column for the server side of this.
 */
import { useEffect, useRef, useState } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAgentStore } from '@admin/ai/useAgentStore'
import {
  agentSessionControlsInitialState,
  fetchStudioAgentDesignPolicy,
  fetchStudioAgentFidelityMode,
  persistStudioAgentDesignPolicy,
  persistStudioAgentFidelityMode,
  type AgentSlice,
} from '@site/agent'
import { restartAgentSession } from '@admin/ai/api'
import { ApiError, isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import styles from './AgentSessionControls.module.css'

type AgentPermissionMode = AgentSlice['agentPermissionMode']
type AgentFidelityMode = AgentSlice['agentFidelityMode']
type AgentDesignPolicy = AgentSlice['agentDesignPolicy']

const MODE_OPTIONS: ReadonlyArray<{ value: AgentPermissionMode; label: string; shortLabel: string }> = [
  { value: 'default', label: 'Ask before edits', shortLabel: 'Ask' },
  { value: 'acceptEdits', label: 'Auto', shortLabel: 'Auto' },
  { value: 'plan', label: 'Plan', shortLabel: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass', shortLabel: 'Bypass' },
]

/**
 * W9-2's fidelity picker. `null` is a first-class option, not an absent
 * value: it means "use this project's own default", which is what the server
 * resolves when the turn carries no mode (the persisted per-project default,
 * else derived — a design reference is registered → balanced, none →
 * creative). Offering it explicitly is what lets a user UNDO a session
 * override without guessing which literal the project is set to.
 */
const FIDELITY_OPTIONS: ReadonlyArray<{ value: AgentFidelityMode; label: string; shortLabel: string; hint: string }> = [
  { value: null, label: 'Project default', shortLabel: 'Fidelity', hint: 'Grade the way this project is set up to be graded' },
  { value: 'creative', label: 'Creative', shortLabel: 'Creative', hint: 'A reference is a direction — design, propose variants, do not chase pixels' },
  { value: 'balanced', label: 'Balanced', shortLabel: 'Balanced', hint: 'Match the design, deviate deliberately and say so' },
  { value: 'strict', label: 'Strict', shortLabel: 'Strict', hint: 'Reproduce the design — highest thresholds, no reference guessing' },
]

/**
 * A12's design-policy picker. `null` is a first-class option for exactly the
 * reason it is on the fidelity picker: it means "use this project's own
 * default", which is the only way to UNDO a session override without guessing
 * which literal the project is set to.
 *
 * The hints name what each position DOES to the grader, not how it feels — a
 * picker whose options read as moods gets picked by mood, and this one decides
 * whether a raw hex fails the Stop gate.
 */
const DESIGN_POLICY_OPTIONS: ReadonlyArray<{ value: AgentDesignPolicy; label: string; shortLabel: string; hint: string }> = [
  { value: null, label: 'Project default', shortLabel: 'System', hint: 'Use whatever this project is set up to expect' },
  { value: 'follow', label: 'Follow the system', shortLabel: 'Follow', hint: 'Tokens and this project’s own components only — a raw or off-scale value is an error' },
  { value: 'balanced', label: 'Balanced', shortLabel: 'Balanced', hint: 'Prefer tokens and components; a one-off is allowed when the reply says why' },
  { value: 'free', label: 'Free', shortLabel: 'Free', hint: 'The design system is optional — design a distinct visual language instead' },
]

interface AgentSessionControlsProps {
  /**
   * Whether at least one usable AI credential exists. Reuses the same
   * `listCredentials` fetch `AgentPanel` already runs for the composer's
   * "No credentials yet" empty state — do not re-derive this elsewhere.
   * Permission mode configures a session that literally cannot start
   * without a credential, so with none configured this component renders
   * nothing at all (not a disabled control).
   */
  hasCredentials: boolean
}

export function AgentSessionControls({ hasCredentials }: AgentSessionControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const agentPermissionMode = useAgentStore((s) => s.agentPermissionMode)
  const setAgentPermissionMode = useAgentStore((s) => s.setAgentPermissionMode)

  const studioProjectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const lastProjectDirRef = useRef(studioProjectDir)
  useEffect(() => {
    if (lastProjectDirRef.current !== studioProjectDir) {
      lastProjectDirRef.current = studioProjectDir
      // Switching projects lands in the default working mode, whatever that
      // is — the point is that a mode chosen for one project does not silently
      // carry into another, in EITHER direction. Reads the initializer rather
      // than repeating a literal, so this can never drift from it.
      setAgentPermissionMode(agentSessionControlsInitialState().agentPermissionMode)
    }
  }, [studioProjectDir, setAgentPermissionMode])

  // Permission mode configures a session that can't start without a
  // credential — with none configured, don't render a dead control next to
  // the composer's own "Add AI credentials to start chatting" empty state.
  if (!hasCredentials) return null

  const isBypass = agentPermissionMode === 'bypassPermissions'
  const current = MODE_OPTIONS.find((opt) => opt.value === agentPermissionMode) ?? MODE_OPTIONS[0]

  function closeMenu(): void {
    setOpen(false)
  }

  return (
    <div className={styles.root}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={isBypass
          ? `Permission mode: ${current.label} — edits apply without asking first`
          : `Permission mode: ${current.label}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        {isBypass && <WarningDiamondSolidIcon size={11} aria-hidden="true" />}
        <span>{current.shortLabel}</span>
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={190}
          ariaLabel="Permission mode"
          onClose={closeMenu}
        >
          {MODE_OPTIONS.map((opt) => (
            <ContextMenuItem
              key={opt.value}
              danger={opt.value === 'bypassPermissions'}
              selected={opt.value === agentPermissionMode}
              onClick={() => {
                setAgentPermissionMode(opt.value)
                closeMenu()
              }}
            >
              {opt.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
      <FidelityModeControl />
      <DesignPolicyControl />
      <RestartSessionButton />
    </div>
  )
}

/**
 * The fidelity trigger (W9-2) — creative / balanced / strict, or the
 * project's own default.
 *
 * Its own trigger rather than a submenu of the permission one, because they
 * answer different questions: permission mode is "may you", fidelity is "how
 * well". Putting the second inside the first would have buried the control
 * this wave exists to expose.
 *
 * PERSISTED, unlike permission mode, and the asymmetry is deliberate rather
 * than an inconsistency. Permission mode is not written to disk because a
 * reset must never land a user in a LOOSER state than they chose; fidelity
 * mode has no looser-than-chosen state to land in — clearing it hands the
 * decision back to the project default and then to the server's derived
 * value, both of which are decisions the user or the project already made.
 * `.studio/meta.json`'s `agentSession`, per account, via the same route
 * effort uses.
 */
function FidelityModeControl() {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const agentFidelityMode = useAgentStore((s) => s.agentFidelityMode)
  const setAgentFidelityMode = useAgentStore((s) => s.setAgentFidelityMode)
  const studioProjectDir = useAdminUi((s) => s.studioProject?.dir ?? null)

  // Restore this project's persisted mode when it opens (or on remount over
  // an already-open one). Best-effort, same posture `ModelEffortPicker` takes
  // for effort: a failed read leaves the session on null, which is exactly
  // "let the server decide" and never a wrong grading bar.
  useEffect(() => {
    // No project open means no persisted mode to restore and nothing to
    // clear: with no `workspaceDir` on the turn the server never reaches the
    // fidelity chain at all. Switching between two projects DOES re-fetch,
    // which is what stops one project's saved mode leaking into another.
    if (!studioProjectDir) return
    const controller = new AbortController()
    void fetchStudioAgentFidelityMode(studioProjectDir, controller.signal)
      .then((mode) => {
        if (!controller.signal.aborted) setAgentFidelityMode(mode)
      })
      .catch(() => { /* best-effort — see doc comment */ })
    return () => controller.abort()
  }, [studioProjectDir, setAgentFidelityMode])

  const current = FIDELITY_OPTIONS.find((opt) => opt.value === agentFidelityMode) ?? FIDELITY_OPTIONS[0]!

  function choose(next: AgentFidelityMode): void {
    setAgentFidelityMode(next)
    // Not awaited — a failed persist costs the next reopen's default, not
    // this turn's mode, which is already in the store and goes out with it.
    if (studioProjectDir) void persistStudioAgentFidelityMode(studioProjectDir, next)
    setOpen(false)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Fidelity: ${current.label} — ${current.hint}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current.shortLabel}</span>
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={220}
          ariaLabel="Fidelity"
          onClose={() => setOpen(false)}
        >
          {FIDELITY_OPTIONS.map((opt) => (
            <ContextMenuItem
              key={opt.value ?? 'project-default'}
              selected={opt.value === agentFidelityMode}
              onClick={() => choose(opt.value)}
            >
              {opt.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}

/**
 * The design-policy trigger (A12) — follow / balanced / free, or the
 * project's own default.
 *
 * A THIRD trigger, beside fidelity, because it answers a third question.
 * Permission mode is "may you", fidelity is "how closely must this match the
 * design", and this is "how much of the design system must you use". Folding
 * it into the fidelity menu was the obvious saving and the wrong one: the two
 * combine in both directions (strict fidelity with a free policy is "the comp
 * is the spec, the system is not"; creative fidelity with follow is "invent,
 * but out of our own vocabulary"), and a single control cannot express a
 * pair.
 *
 * Persisted per project and per account through the same
 * `/admin/api/ai/studio-session` route and the same `.studio/meta.json`
 * `agentSession` shape as fidelity mode, for the same reason it is safe to
 * persist: clearing it lands on `balanced`, which asks for MORE design-system
 * discipline than `free`, never less. No reload can hand a user a looser bar
 * than the one they chose.
 */
function DesignPolicyControl() {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const agentDesignPolicy = useAgentStore((s) => s.agentDesignPolicy)
  const setAgentDesignPolicy = useAgentStore((s) => s.setAgentDesignPolicy)
  const studioProjectDir = useAdminUi((s) => s.studioProject?.dir ?? null)

  // Restore this project's persisted policy when it opens — same best-effort
  // posture the fidelity control takes: a failed read leaves the session on
  // null, which is "let the server decide" and never a wrong grading bar.
  useEffect(() => {
    if (!studioProjectDir) return
    const controller = new AbortController()
    void fetchStudioAgentDesignPolicy(studioProjectDir, controller.signal)
      .then((policy) => {
        if (!controller.signal.aborted) setAgentDesignPolicy(policy)
      })
      .catch(() => { /* best-effort — see doc comment */ })
    return () => controller.abort()
  }, [studioProjectDir, setAgentDesignPolicy])

  const current = DESIGN_POLICY_OPTIONS.find((opt) => opt.value === agentDesignPolicy) ?? DESIGN_POLICY_OPTIONS[0]!

  function choose(next: AgentDesignPolicy): void {
    setAgentDesignPolicy(next)
    // Not awaited — a failed persist costs the next reopen's default, not
    // this turn's policy, which is already in the store and goes out with it.
    if (studioProjectDir) void persistStudioAgentDesignPolicy(studioProjectDir, next)
    setOpen(false)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Design system: ${current.label} — ${current.hint}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current.shortLabel}</span>
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={230}
          ariaLabel="Design system"
          onClose={() => setOpen(false)}
        >
          {DESIGN_POLICY_OPTIONS.map((opt) => (
            <ContextMenuItem
              key={opt.value ?? 'project-default'}
              selected={opt.value === agentDesignPolicy}
              onClick={() => choose(opt.value)}
            >
              {opt.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}

/**
 * "Restart agent session" — a `claudeCli`-only control (a no-op server-side
 * for every other provider, but shown regardless: same posture the
 * permission-mode trigger above takes). Renders nothing until a conversation
 * actually exists (`agentConversationId`) — there is no session to restart
 * before the first message creates the row.
 */
function RestartSessionButton() {
  const conversationId = useAgentStore((s) => s.agentConversationId)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const [restarting, setRestarting] = useState(false)

  if (!conversationId) return null

  async function handleClick(): Promise<void> {
    if (!conversationId || restarting) return
    setRestarting(true)
    try {
      await restartAgentSession(conversationId)
      pushToast({
        kind: 'success',
        title: 'Agent session restarted',
        body: 'The next message starts a fresh Claude CLI session — this chat and its history are unchanged.',
      })
    } catch (err) {
      if (isAbortError(err)) return
      const status = err instanceof ApiError ? err.status : undefined
      pushToast({
        kind: 'error',
        title: 'Could not restart the agent session',
        body: status === 409
          ? 'Wait for the current response to finish, then try again.'
          : getErrorMessage(err, 'Unknown error restarting the agent session'),
      })
    } finally {
      setRestarting(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      iconOnly
      disabled={isStreaming || restarting}
      onClick={() => { void handleClick() }}
      tooltip="Restart agent session — starts a fresh Claude CLI session (re-reads MCP servers and config); keeps this chat and its history"
      aria-label="Restart agent session"
    >
      <ReloadIcon size={12} aria-hidden="true" />
    </Button>
  )
}
