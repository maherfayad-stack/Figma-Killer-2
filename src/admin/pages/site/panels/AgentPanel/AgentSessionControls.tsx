/**
 * AgentSessionControls — WS-12 §5.1 session bar: effort + permission mode.
 *
 * Model selection already exists (`ModelPicker.tsx`, populated live from
 * each provider — no hardcoded list, same rule the Anthropic driver already
 * follows for `/v1/models`). This component owns the two remaining `claudeCli`-
 * only controls: `--effort` and `--permission-mode`. Both are no-ops for
 * every other provider — the server silently ignores them (`AiStreamRequest`'s
 * own doc comment) — so this bar is safe to show regardless of which
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
 *   2. **Visibly indicated while active** — the banner below, rendered
 *      directly above the composer (never inside the scrollable message
 *      thread, so it can't scroll out of view) for as long as
 *      `agentPermissionMode === 'bypassPermissions'`. Not a one-time toast.
 *   3. **Still trust-tier-bound** — owned entirely server-side
 *      (`studio_install_deps`'s trust check in `projectTools.ts`, which has
 *      no permission-mode parameter to read in the first place); nothing in
 *      this component or in Bypass mode itself can touch it.
 */
import { useEffect, useId, useRef } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { Select } from '@ui/components/Select'
import { fetchStudioAgentEffort, persistStudioAgentEffort } from '@site/agent'
import styles from './AgentSessionControls.module.css'

const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-high' },
  { value: 'max', label: 'Max' },
]

const MODE_OPTIONS = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Auto' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
]

interface AgentSessionControlsProps {
  /**
   * Whether at least one usable AI credential exists. Reuses the same
   * `listCredentials` fetch `AgentPanel` already runs for the composer's
   * "No credentials yet" empty state — do not re-derive this elsewhere.
   * Effort and permission-mode configure a session that literally cannot
   * start without a credential, so with none configured this component
   * renders nothing at all (not a disabled control).
   */
  hasCredentials: boolean
}

export function AgentSessionControls({ hasCredentials }: AgentSessionControlsProps) {
  const effortId = useId()
  const modeId = useId()

  const agentEffort = useAgentStore((s) => s.agentEffort)
  const agentPermissionMode = useAgentStore((s) => s.agentPermissionMode)
  const setAgentEffort = useAgentStore((s) => s.setAgentEffort)
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

  // WS-12 §5.1 — restore the persisted effort whenever a Studio project
  // opens (or the panel remounts on one already open). Best-effort: a fetch
  // failure just leaves the session on the server default, same posture
  // `fetchStudioDefault` already uses for credential/model.
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

  const isBypass = agentPermissionMode === 'bypassPermissions'

  // Effort and permission mode configure a session that can't start without
  // a credential — with none configured, don't render dead controls above
  // the composer's own "Add AI credentials to start chatting" empty state.
  if (!hasCredentials) return null

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <div className={styles.field}>
          <label htmlFor={effortId} className={styles.label}>Effort</label>
          <Select
            id={effortId}
            fieldSize="xs"
            value={agentEffort ?? ''}
            onChange={(e) => {
              const value = e.currentTarget.value
              const next = value === '' ? null : (value as NonNullable<typeof agentEffort>)
              setAgentEffort(next)
              // WS-12 §5.1 — persists per project; deliberately NOT awaited,
              // a slow/failed persist must never block sending a message.
              if (studioProjectDir) void persistStudioAgentEffort(studioProjectDir, next)
            }}
            options={EFFORT_OPTIONS}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={modeId} className={styles.label}>Mode</label>
          <Select
            id={modeId}
            fieldSize="xs"
            value={agentPermissionMode}
            onChange={(e) => setAgentPermissionMode(e.currentTarget.value as typeof agentPermissionMode)}
            options={MODE_OPTIONS}
          />
        </div>
      </div>
      {/* D5 §11.5, rail 2 — a persistent, hard-to-miss indicator for the
          entire time Bypass is active, sitting directly above the composer
          the user is about to type an edit-triggering message into. */}
      {isBypass && (
        <p role="status" className={styles.bypassBanner}>
          Bypass is on — edits apply without asking. Switch modes above to go back to asking first.
        </p>
      )}
    </div>
  )
}
