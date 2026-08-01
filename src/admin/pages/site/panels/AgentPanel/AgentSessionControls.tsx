/**
 * AgentSessionControls — the composer's LEFT-edge permission-mode trigger
 * (WS-6 / D5 §11.5). Model selection + reasoning effort live together in
 * `ModelEffortPicker`'s single trigger + menu on the composer's right edge;
 * this is the remaining `claudeCli`-only knob, `--permission-mode`. A no-op
 * for every other provider — the server silently ignores it (`AiStreamRequest`'s
 * own doc comment) — so this trigger is safe to show regardless of which
 * provider the active conversation is using.
 *
 * **All four modes are real, including Bypass** — resolved from an earlier,
 * mistaken refusal (see `claudeCli.ts`'s `resolvePermissionMode` doc
 * comment): a user deliberately selecting Bypass IS the consent WS-12's
 * "never inject a bypassing flag on its own" rule protects, not something
 * that rule forbids. D5 §11.5's three guard rails on Bypass, each owned by
 * exactly one piece of code:
 *
 *   1. **Non-persisting** — `agentSlice.ts` initializes
 *      `agentPermissionMode: 'default'` at store creation (covers reload);
 *      this component resets it to `'default'` on every live Studio-project
 *      switch (covers switching without a remount). Nothing anywhere reads
 *      it from or writes it to storage.
 *   2. **Visibly indicated while active** — the trigger itself switches to
 *      the `danger` tone (foreground text/icon, never a filled block — the
 *      earlier banner design was rejected for reading like a settings form
 *      bolted onto the composer) and carries a warning glyph + a descriptive
 *      accessible name, for as long as `agentPermissionMode ===
 *      'bypassPermissions'`. Sits in the composer's own control row (not the
 *      scrollable message thread), so it can't scroll out of view, and it's
 *      permanent — not a one-time toast.
 *   3. **Still trust-tier-bound** — owned entirely server-side
 *      (`studio_install_deps`'s trust check in `projectTools.ts`, which has
 *      no permission-mode parameter to read in the first place); nothing in
 *      this component or in Bypass mode itself can touch it.
 */
import { useEffect, useRef, useState } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAgentStore } from '@admin/ai/useAgentStore'
import type { AgentSlice } from '@site/agent'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
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
      // D5 §11.5, rail 1 — Bypass never survives a project switch.
      setAgentPermissionMode('default')
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
        tone={isBypass ? 'danger' : 'default'}
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
    </div>
  )
}
