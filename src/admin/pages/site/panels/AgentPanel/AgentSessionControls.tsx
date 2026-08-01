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
 * **Bypass mode is shown but refused.** WS-12 §5.2 asks for four modes wired
 * 1:1 onto `--permission-mode`, but this driver's own hard rule (see
 * `claudeCli.ts`'s `resolvePermissionMode` doc comment) refuses to ever pass
 * `bypassPermissions` to the subprocess — the constraint carried through
 * every WS-11/WS-12 task in this thread names that exact value as forbidden,
 * and a later feature request does not override a standing hard-security
 * rule by itself. The option is still selectable here (so the control
 * genuinely offers all four, matching the coordinator's request, and so the
 * refusal is visible rather than the option silently missing) — selecting it
 * shows the same refusal message the server would return, without spending a
 * turn to discover that.
 *
 * **The mode never persists.** No read from, and no write to, any storage —
 * `agentSlice.ts` initializes `agentPermissionMode: 'default'` at store
 * creation, and this component resets it back to `'default'` whenever the
 * open Studio project changes (project switch is the other reset trigger
 * WS-12 §5.2 names, alongside "on reload" — which the fresh store-init value
 * already covers for free).
 */
import { useEffect, useId, useRef } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { Select } from '@ui/components/Select'
import styles from './AgentSessionControls.module.css'

const EFFORT_OPTIONS = [
  { value: '', label: 'Effort: default' },
  { value: 'low', label: 'Effort: low' },
  { value: 'medium', label: 'Effort: medium' },
  { value: 'high', label: 'Effort: high' },
  { value: 'xhigh', label: 'Effort: x-high' },
  { value: 'max', label: 'Effort: max' },
]

const MODE_OPTIONS = [
  { value: 'default', label: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Auto' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass (unavailable)' },
]

export function AgentSessionControls() {
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
      // WS-12 §5.2 — Bypass never survives a project switch.
      setAgentPermissionMode('default')
    }
  }, [studioProjectDir, setAgentPermissionMode])

  const isBypass = agentPermissionMode === 'bypassPermissions'

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <label htmlFor={effortId} className={styles.label}>Effort</label>
        <Select
          id={effortId}
          fieldSize="xs"
          value={agentEffort ?? ''}
          onChange={(e) => {
            const value = e.currentTarget.value
            setAgentEffort(value === '' ? null : (value as NonNullable<typeof agentEffort>))
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
      {isBypass && (
        <p role="alert" className={styles.bypassWarning}>
          Bypass mode is not available — Claude CLI turns never disable permission prompts. Choose Ask before edits, Auto, or Plan instead.
        </p>
      )}
    </div>
  )
}
