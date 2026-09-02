/**
 * AgentSessionControls — the composer's LEFT-edge permission-mode trigger
 * (WS-6 / D5 §11.5). Model selection + reasoning effort live together in
 * `ModelEffortPicker`'s single trigger + menu on the composer's right edge;
 * this is the remaining `claudeCli`-only knob, `--permission-mode`. A no-op
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
import { agentSessionControlsInitialState, type AgentSlice } from '@site/agent'
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

const MODE_OPTIONS: ReadonlyArray<{ value: AgentPermissionMode; label: string; shortLabel: string }> = [
  { value: 'default', label: 'Ask before edits', shortLabel: 'Ask' },
  { value: 'acceptEdits', label: 'Auto', shortLabel: 'Auto' },
  { value: 'plan', label: 'Plan', shortLabel: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass', shortLabel: 'Bypass' },
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
      <RestartSessionButton />
    </div>
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
