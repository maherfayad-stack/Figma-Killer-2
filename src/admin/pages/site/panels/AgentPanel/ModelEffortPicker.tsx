/**
 * ModelEffortPicker — AgentPanel's composer-right trigger: current model +
 * reasoning effort as one control, one menu (Claude Code composer pattern,
 * WS-6). Model selection/listing/search stays entirely inside the shared
 * {@link SharedModelPicker} — the single source of truth for "what models
 * exist" — and this file only supplies:
 *
 *   - the effort text folded into that SAME trigger, via `trailingLabel`
 *   - the "Effort ›" submenu appended to that SAME dropdown, via `menuFooter`
 *
 * Effort is a `claudeCli`-only knob (`--effort`); every other provider
 * ignores it server-side (`AiStreamRequest`'s own doc comment). Persistence
 * is per Studio project, deliberately un-awaited so a slow/failed write
 * never blocks sending — WS-12 §5.1.
 */
import { useEffect } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { ModelPicker as SharedModelPicker } from '@admin/ai/ModelPicker'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSubmenu } from '@ui/components/ContextMenu'
import type { CredentialView } from '@admin/ai/api'
import { fetchStudioAgentEffort, persistStudioAgentEffort, type AgentSlice } from '@site/agent'
import styles from './ModelEffortPicker.module.css'

type AgentEffort = AgentSlice['agentEffort']

const EFFORT_OPTIONS: ReadonlyArray<{ value: NonNullable<AgentEffort> | ''; label: string }> = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-high' },
  { value: 'max', label: 'Max' },
]

interface ModelEffortPickerProps {
  /** Optional extra className for the trigger wrapper. */
  className?: string
  /** Credentials are loaded by AgentPanel so header + thread state stay in sync. */
  credentials: CredentialView[]
  /** True once the credential list fetch has completed at least once. */
  credentialsLoaded: boolean
  /** Re-run the credential list query when the picker opens. */
  onRefreshCredentials: () => void
  disabled?: boolean
}

export function ModelEffortPicker({
  className,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
  disabled = false,
}: ModelEffortPickerProps) {
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const setAgentProvider = useAgentStore((s) => s.setAgentProvider)
  const agentEffort = useAgentStore((s) => s.agentEffort)
  const setAgentEffort = useAgentStore((s) => s.setAgentEffort)

  const studioProjectDir = useAdminUi((s) => s.studioProject?.dir ?? null)

  // WS-12 §5.1 — restore the persisted effort whenever a Studio project
  // opens (or this component remounts on one already open). Best-effort: a
  // fetch failure just leaves the session on the server default, same
  // posture `fetchStudioDefault` already uses for credential/model.
  useEffect(() => {
    if (!studioProjectDir) return
    const controller = new AbortController()
    void fetchStudioAgentEffort(studioProjectDir, controller.signal)
      .then((effort) => {
        if (!controller.signal.aborted) setAgentEffort(effort)
      })
      .catch(() => { /* best-effort — see doc comment */ })
    return () => controller.abort()
  }, [studioProjectDir, setAgentEffort])

  const value =
    activeCredentialId && activeModelId
      ? { credentialId: activeCredentialId, modelId: activeModelId }
      : null

  const currentEffort = agentEffort ?? ''
  const currentEffortLabel = EFFORT_OPTIONS.find((opt) => opt.value === currentEffort)?.label ?? 'Default'

  function changeEffort(next: NonNullable<AgentEffort> | ''): void {
    const resolved = next === '' ? null : next
    setAgentEffort(resolved)
    // Deliberately not awaited — see doc comment.
    if (studioProjectDir) void persistStudioAgentEffort(studioProjectDir, resolved)
  }

  return (
    <SharedModelPicker
      className={className}
      variant="inline"
      placeholder="Choose a model"
      credentials={credentials}
      credentialsLoaded={credentialsLoaded}
      disabled={disabled}
      value={value}
      onOpen={onRefreshCredentials}
      onChange={({ credentialId, modelId }) => void setAgentProvider(credentialId, modelId)}
      // Only surface effort in the trigger once it's an explicit choice —
      // showing a fabricated "Default" label would claim a specific value
      // the session doesn't actually have.
      trailingLabel={agentEffort ? currentEffortLabel : undefined}
      trailingLabelKind="effort"
      menuFooter={(closeMenu) => (
        <>
          <ContextMenuSeparator />
          <ContextMenuSubmenu
            label={
              <span className={styles.submenuLabel}>
                <span>Effort</span>
                <span className={styles.submenuValue}>{currentEffortLabel}</span>
              </span>
            }
            ariaLabel={`Effort: ${currentEffortLabel}`}
            onClose={closeMenu}
            width={260}
            closeOnItemClickOnly
          >
            <p role="presentation" className={styles.effortIntro}>
              Higher effort means more thorough responses, but takes longer and uses your limits faster.
            </p>
            {EFFORT_OPTIONS.map((opt) => (
              <ContextMenuItem
                key={opt.value || 'default'}
                selected={currentEffort === opt.value}
                disabled={disabled}
                onClick={() => changeEffort(opt.value)}
              >
                {opt.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubmenu>
        </>
      )}
    />
  )
}
