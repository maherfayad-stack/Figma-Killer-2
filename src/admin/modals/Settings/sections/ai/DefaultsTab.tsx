/**
 * Defaults tab — Studio's default `(credentialId, modelId)` selection.
 *
 * Studio has exactly one agent, so this is a single row using the shared
 * {@link ModelPicker} — the same combined credential+model picker as the
 * chat composer — and a Save button. Saving PUTs to /admin/api/ai/defaults.
 */

import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { ModelPicker, type ModelChoice } from '@admin/ai/ModelPicker'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import {
  type AiDefault,
  type CredentialView,
  clearDefault,
  listCredentials,
  listDefaults,
  setDefault,
} from '../../../../ai/api'
import { ApiError } from '@core/http'
import styles from './ai.module.css'

export function DefaultsTab() {
  const { data, loading, error, refresh } = useAsyncResource(
    () => Promise.all([listCredentials(), listDefaults()]).then(([creds, current]) => ({ creds, current })),
    [],
    { fallbackError: 'Failed to load defaults.' },
  )
  const credentials: CredentialView[] = data?.creds ?? []
  const current: AiDefault = data?.current ?? null
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  // Track ONLY the user's pick. The displayed value falls back to the saved
  // default when it still resolves to a credential this user can access.
  //
  // Why: the saved default may point to a credential the current user can no
  // longer resolve (deleted, owned by another user, master-key rotated). In
  // that case we show nothing and require a fresh pick before Save.
  const [override, setOverride] = useState<ModelChoice | null>(null)

  const savedResolves = current?.credentialId
    ? credentials.some((c) => c.id === current.credentialId)
    : false

  const value: ModelChoice | null =
    override ??
    (savedResolves ? { credentialId: current!.credentialId, modelId: current!.modelId } : null)

  const stale = Boolean(current?.credentialId) && !savedResolves

  const dirty =
    override != null &&
    (override.credentialId !== current?.credentialId || override.modelId !== current?.modelId)
  const canSave = !busy && value != null && dirty
  const canClear = !busy && current != null

  async function handleSave() {
    if (!value) return
    setBusy(true)
    setStatus('')
    try {
      await setDefault({ credentialId: value.credentialId, modelId: value.modelId })
      setStatus('Saved.')
      refresh()
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Failed to save.'
      setStatus(message)
    } finally {
      setBusy(false)
    }
  }

  async function handleClear() {
    setBusy(true)
    setStatus('')
    try {
      await clearDefault()
      setStatus('Cleared.')
      setOverride(null)
      refresh()
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Failed to clear.'
      setStatus(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Default model</h2>
          <p>Pick which credential + model the Studio agent uses by default. You can override in the chat picker.</p>
        </div>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div className={styles.emptyState}>
          Add a credential on the Providers tab before setting a default.
        </div>
      ) : (
        <div className={styles.defaultRow}>
          <div>
            <div className={styles.defaultTitle}>Studio agent</div>
            {stale && (
              <p role="status" className={`${styles.testResult} ${styles.danger}`}>
                Previously saved credential is no longer available. Pick another and Save.
              </p>
            )}
          </div>
          <ModelPicker
            variant="field"
            ariaLabel="Default model"
            placeholder="Choose a model"
            credentials={credentials}
            credentialsLoaded
            value={value}
            onChange={setOverride}
          />
          <div className={styles.defaultActions}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => void handleSave()}
            >
              <SaveSolidIcon size={14} aria-hidden="true" />
              <span>Save</span>
            </Button>
            {current && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canClear}
                onClick={() => void handleClear()}
              >
                <CloseIcon size={14} aria-hidden="true" />
                <span>Clear</span>
              </Button>
            )}
            {status && (
              <p
                role="status"
                className={`${styles.testResult} ${status === 'Saved.' || status === 'Cleared.' ? styles.success : styles.danger}`}
              >
                {status}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
