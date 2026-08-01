/**
 * Providers tab — list, add, test, delete AI provider credentials.
 *
 * Every credential is per-user (handled server-side); the view shown here
 * is the wire-safe `CredentialView` (no plaintext, no ciphertext).
 */

import { useEffect, useId, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import {
  type ClaudeCliStatus,
  type CredentialView,
  type CreateCredentialBody,
  type TestResult,
  createCredential,
  deleteCredential,
  getClaudeCliStatus,
  launchClaudeCliLoginTerminal,
  listCredentials,
  testCredential,
} from '../../../ai/api'
import { ApiError, isAbortError } from '@core/http'
import styles from '../AiPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

type ProviderId = 'anthropic' | 'openai' | 'ollama' | 'openrouter' | 'openai-compatible' | 'claudeCli'
type AuthMode = 'apiKey' | 'baseUrl'

// Each provider has exactly one credential shape; the UI derives it instead
// of asking the user to choose an auth mode that cannot vary.
//
// `claudeCli` is WS-11's local-subprocess provider, with two login paths —
// only one of which stores a row (WS-11 §3 P2: "L1 needs no row, and no
// default either" — a terminal login leaves nothing for Studio to store):
//   L1 — "Log in with Claude" opens a detached terminal on this host running
//        `claude auth login` (`AddCredentialDialog`'s login-flow state
//        below). Once the poll observes `loggedIn: true` this flow's job is
//        done — no credential row, no default. `AgentPanel.tsx` separately
//        reads the same status to say "Claude Code is logged in — add it as
//        a credential" instead of a generic empty state.
//   L2 — the user runs `claude setup-token` themselves (anywhere — the only
//        option on a remote server) and pastes the result, behind the
//        dialog's "Or paste a setup-token instead" disclosure. This IS what
//        creates the `authMode: 'apiKey'` row the model picker can select.
const PROVIDERS: Array<{ id: ProviderId; label: string; authMode: AuthMode }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)', authMode: 'apiKey' },
  { id: 'openai', label: 'OpenAI', authMode: 'apiKey' },
  { id: 'openrouter', label: 'OpenRouter', authMode: 'apiKey' },
  { id: 'ollama', label: 'Ollama (local)', authMode: 'baseUrl' },
  { id: 'openai-compatible', label: 'Custom Provider', authMode: 'baseUrl' },
  { id: 'claudeCli', label: 'Claude Code (subscription)', authMode: 'apiKey' },
]

const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  apiKey: 'API key',
  baseUrl: 'Endpoint URL',
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  'openai-compatible': 'Custom Provider',
  claudeCli: 'Claude Code',
}

// Hint text for the API-key field, per provider key prefix.
const API_KEY_PLACEHOLDER: Partial<Record<ProviderId, string>> = {
  anthropic: 'sk-ant-...',
  openrouter: 'sk-or-...',
  'openai-compatible': 'sk-... (optional)',
  claudeCli: 'paste the output of `claude setup-token`',
}

/**
 * The credential list card's auth-mode meta text. A stored `claudeCli`
 * credential is always the L2 `claude setup-token` OAuth token (L1's "Log in
 * with Claude" terminal flow creates no row at all — WS-11 §3 P2) — it isn't
 * an "API key", so this never shows that generic label for it.
 */
function credentialAuthModeLabel(cred: CredentialView): string {
  if (cred.providerId === 'claudeCli') return 'Setup token'
  return AUTH_MODE_LABEL[cred.authMode]
}

async function deleteCredentialAction(
  id: string,
  setBusyIds: (updater: (prev: Set<string>) => Set<string>) => void,
  setActionError: (error: string | null) => void,
  refresh: () => void,
): Promise<void> {
  setBusyIds((prev) => new Set(prev).add(id))
  try {
    await deleteCredential(id)
    setActionError(null)
    refresh()
  } catch (err) {
    setActionError(getErrorMessage(err, 'Failed to delete credential.'))
  } finally {
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
}

async function testCredentialAction(
  id: string,
  setBusyIds: (updater: (prev: Set<string>) => Set<string>) => void,
  setTestResults: (updater: (prev: Record<string, TestResult & { ts: number }>) => Record<string, TestResult & { ts: number }>) => void,
): Promise<void> {
  setBusyIds((prev) => new Set(prev).add(id))
  try {
    const result = await testCredential(id)
    setTestResults((prev) => ({ ...prev, [id]: { ...result, ts: Date.now() } }))
  } catch (err) {
    const message = getErrorMessage(err, 'Test failed.')
    setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: message, ts: Date.now() } }))
  } finally {
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
}

export function ProvidersTab() {
  const {
    data: loadedCredentials,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => listCredentials(), [], {
    fallbackError: 'Failed to load credentials.',
  })
  const credentials: CredentialView[] = loadedCredentials ?? []
  const [showDialog, setShowDialog] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, TestResult & { ts: number }>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Errors from mutations (delete/create) live alongside the load error from
  // the resource; the view shows whichever is present.
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  async function handleDelete(id: string) {
    await deleteCredentialAction(id, setBusyIds, setActionError, refresh)
  }

  async function handleTest(id: string) {
    await testCredentialAction(id, setBusyIds, setTestResults)
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Credentials</h2>
          <p>Provider credentials for AI features. Secrets are encrypted at rest.</p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={() => setShowDialog(true)}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Add credential</span>
        </Button>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div className={styles.emptyState}>
          No credentials yet. Add one to start using AI features.
        </div>
      ) : (
        <div className={styles.credentialGrid}>
          {credentials.map((cred) => {
            const isBusy = busyIds.has(cred.id)
            const result = testResults[cred.id]
            return (
              <div key={cred.id} className={styles.credentialCard}>
                <div className={styles.credentialIdentity}>
                  <div className={styles.credentialLabel}>{cred.displayLabel}</div>
                  <div className={styles.credentialMeta}>
                    <span>{PROVIDER_LABEL[cred.providerId]}</span>
                    <span>·</span>
                    <span>{credentialAuthModeLabel(cred)}</span>
                    {!cred.keyFingerprintCurrent && (
                      <span className={`${styles.statusBadge} ${styles.warning}`}>
                        Master key rotated — re-enter
                      </span>
                    )}
                    {cred.lastUsedAt && (
                      <>
                        <span>·</span>
                        <span>Last used {new Date(cred.lastUsedAt).toLocaleString()}</span>
                      </>
                    )}
                    {cred.expiresAt && (
                      <>
                        <span>·</span>
                        <span>
                          Expires {new Date(cred.expiresAt).toLocaleDateString()} — this token
                          does not refresh; run `claude setup-token` again and replace it before then.
                        </span>
                      </>
                    )}
                  </div>
                  {result && (
                    <p
                      role="status"
                      className={`${styles.testResult} ${result.ok ? styles.success : styles.danger}`}
                    >
                      {result.ok
                        ? `✓ Test ok (${result.modelCount ?? 0} models available)`
                        : `✗ ${result.error ?? 'Test failed.'}`}
                    </p>
                  )}
                </div>
                <div className={styles.credentialActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleTest(cred.id)}
                    disabled={isBusy}
                  >
                    <CheckIcon size={14} aria-hidden="true" />
                    <span>Test</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleDelete(cred.id)}
                    disabled={isBusy}
                  >
                    <TrashSolidIcon size={14} aria-hidden="true" />
                    <span>Delete</span>
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showDialog && (
        <AddCredentialDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => {
            setShowDialog(false)
            setActionError(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

async function submitCredential(
  effectiveAuthMode: AuthMode,
  providerId: ProviderId,
  displayLabel: string,
  apiKey: string,
  baseUrl: string,
  onCreated: () => void,
  setError: (error: string | null) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  setError(null)
  setBusy(true)
  try {
    const body: CreateCredentialBody =
      effectiveAuthMode === 'apiKey' ? {
        providerId, authMode: 'apiKey', displayLabel, apiKey,
      } : {
        providerId, authMode: 'baseUrl', displayLabel, baseUrl,
        ...(apiKey ? { apiKey } : {}),
      }
    await createCredential(body)
    onCreated()
  } catch (err) {
    if (err instanceof ApiError) {
      setError(err.message)
    } else {
      setError(getErrorMessage(err, 'Failed to create credential.'))
    }
  } finally {
    setBusy(false)
  }
}

// The Add-credential dialog's "Log in with Claude" terminal flow (WS-11
// §2.1's L1 path, made click-to-authorize instead of copy-paste). Poll
// interval is short enough to feel responsive once the user finishes in the
// terminal; the timeout is generous because authorizing in a browser tab the
// user has to switch to isn't instant.
//
// This flow creates NO credential row (WS-11 §3 P2 — "L1 needs no row, and
// no default either"; a terminal login leaves nothing for Studio to store,
// the credential lives entirely in the user's own `CLAUDE_CONFIG_DIR`). Its
// job ends at "you're logged in on this device" — the paste-a-token
// disclosure below is still what actually adds something the picker can
// select. `AgentPanel.tsx`'s empty-state messaging separately reads
// `GET .../claude-cli/status` to say "Claude Code is logged in — add it as a
// credential" instead of a generic "no provider" wall, but does not treat
// login alone as enough to unlock sending.
const CLAUDE_CLI_LOGIN_POLL_INTERVAL_MS = 3_000
const CLAUDE_CLI_LOGIN_POLL_TIMEOUT_MS = 5 * 60_000

type ClaudeCliLoginFlow = 'idle' | 'launching' | 'waiting' | 'success' | 'launch-failed' | 'timed-out'

function AddCredentialDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const providerInputId = useId()
  const labelInputId = useId()
  const apiKeyInputId = useId()
  const baseUrlInputId = useId()
  const formId = useId()

  const [providerId, setProviderId] = useState<ProviderId>('anthropic')
  const [displayLabel, setDisplayLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null)

  // "Log in with Claude" — launch state + the demoted paste-a-token
  // disclosure.
  const [loginFlow, setLoginFlow] = useState<ClaudeCliLoginFlow>('idle')
  const [loginFlowReason, setLoginFlowReason] = useState<string | null>(null)
  const [showTokenPaste, setShowTokenPaste] = useState(false)
  const loginBusy = loginFlow === 'launching' || loginFlow === 'waiting'
  const hostLoggedIn = claudeCliStatus?.availability === 'logged-in'

  // The Claude CLI is a local subprocess (WS-11), not an HTTP provider — the
  // dialog needs to know, before the user tries, whether it can work on this
  // host at all. Fetched once per dialog open; never blocks the rest of the
  // form (a fetch failure just leaves the provider selectable — the actual
  // credential create call is the authoritative check either way).
  useEffect(() => {
    let cancelled = false
    void getClaudeCliStatus()
      .then((status) => {
        if (cancelled) return
        setClaudeCliStatus(status)
        // No one-click path on this host (remote session, unsupported
        // platform), or nothing left to click because a token is still
        // required either way — the paste-a-token field IS the primary
        // option, so open it by default instead of hiding it behind a
        // disclosure the user has to discover.
        if (!status.terminalLogin.available) setShowTokenPaste(true)
      })
      .catch(() => {
        /* swallow — dialog stays usable without the status hint */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const providerSpec = PROVIDERS.find((p) => p.id === providerId)!
  const effectiveAuthMode = providerSpec.authMode
  const baseUrlPlaceholder =
    providerId === 'ollama' ? 'http://localhost:11434' : 'https://api.groq.com/openai/v1'

  // Only a true host-level blocker (binary missing, or macOS's Keychain
  // isolation gap) disables the option outright — both make the L1 login
  // path AND any stored L2 setup-token credential unusable, since either way
  // the same `claude` subprocess has to run. "Logged out" and an inconclusive
  // probe are NOT disabling here: this dialog's whole purpose for claudeCli is
  // either the "Log in with Claude" terminal flow or accepting a pasted L2
  // setup-token.
  const claudeCliBlocked =
    claudeCliStatus?.availability === 'not-installed' || claudeCliStatus?.availability === 'unsupported'
  const providerOptions = PROVIDERS.map((p) => ({
    value: p.id,
    label: p.id === 'claudeCli' && claudeCliBlocked ? `${p.label} — unavailable` : p.label,
    disabled: p.id === 'claudeCli' && claudeCliBlocked,
  }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await submitCredential(effectiveAuthMode, providerId, displayLabel, apiKey, baseUrl, onCreated, setError, setBusy)
  }

  // Launch the detached terminal, then start polling `GET .../status` for
  // `loggedIn: true`. The poll effect below (keyed on `loginFlow ===
  // 'waiting'`) owns the interval + timeout; this handler only owns the
  // one-shot launch call.
  async function handleLoginWithClaude() {
    setLoginFlowReason(null)
    setLoginFlow('launching')
    try {
      const result = await launchClaudeCliLoginTerminal()
      if (!result.ok) {
        setLoginFlow('launch-failed')
        setLoginFlowReason(result.reason ?? 'Could not open a terminal window on this host.')
        setShowTokenPaste(true)
        return
      }
      setLoginFlow('waiting')
    } catch (err) {
      setLoginFlow('launch-failed')
      setLoginFlowReason(getErrorMessage(err, 'Could not open a terminal window on this host.'))
      setShowTokenPaste(true)
    }
  }

  function handleCancelWaiting() {
    setLoginFlow('idle')
    setShowTokenPaste(true)
  }

  // Poll while — and ONLY while — actively waiting on a terminal the user
  // just opened. Cleans up (stops polling, aborts any in-flight request) on
  // every dependency change AND when the dialog itself unmounts (closed),
  // satisfying "stop polling when the dialog closes" without extra wiring —
  // `AddCredentialDialog` is only ever rendered while the dialog is open.
  useEffect(() => {
    if (loginFlow !== 'waiting') return undefined
    const controller = new AbortController()
    const startedAt = Date.now()
    const interval = setInterval(() => {
      if (Date.now() - startedAt > CLAUDE_CLI_LOGIN_POLL_TIMEOUT_MS) {
        clearInterval(interval)
        setLoginFlow('timed-out')
        setShowTokenPaste(true)
        return
      }
      void getClaudeCliStatus(controller.signal)
        .then((status) => {
          setClaudeCliStatus(status)
          if (status.availability !== 'logged-in') return
          clearInterval(interval)
          // No credential row is created here (WS-11 §3 P2) — this flow's
          // job is done: the host is logged in. The paste-a-token disclosure
          // is what actually adds something the picker can select.
          setLoginFlow('success')
        })
        .catch((err) => {
          if (isAbortError(err)) return
          /* transient — keep polling until the timeout above fires */
        })
    }, CLAUDE_CLI_LOGIN_POLL_INTERVAL_MS)
    return () => {
      clearInterval(interval)
      controller.abort()
    }
  }, [loginFlow])

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add AI credential"
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="sm"
            // Deliberately NOT gated on `loginBusy`. The terminal login and the
            // pasted token are two independent paths — logging in on this host
            // never creates a credential row by itself (WS-11 §3 P2), so a
            // setup-token is always what this submit actually needs for
            // `claudeCli`; waiting on the terminal must never block submitting
            // a token that's already in the field. `busy` (a submit already in
            // flight) is the only thing that should hold this.
            disabled={busy || (providerId === 'claudeCli' && !apiKey.trim())}
          >
            <PlusIcon size={14} aria-hidden="true" />
            <span>Add credential</span>
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.dialogForm} onSubmit={(e) => void handleSubmit(e)}>
        <div className={styles.dialogField}>
          <label htmlFor={providerInputId} className={styles.dialogFieldLabel}>Provider</label>
          <Select
            id={providerInputId}
            value={providerId}
            onChange={(e) => setProviderId(e.currentTarget.value as ProviderId)}
            options={providerOptions}
            disabled={loginBusy}
          />
        </div>

        <div className={styles.dialogField}>
          <label htmlFor={labelInputId} className={styles.dialogFieldLabel}>Display label</label>
          <Input
            id={labelInputId}
            value={displayLabel}
            onChange={(e) => setDisplayLabel(e.currentTarget.value)}
            placeholder="e.g. Production"
            disabled={loginBusy}
            required
          />
        </div>

        {providerId === 'claudeCli' && claudeCliStatus && (
          <div className={styles.claudeCliSection}>
            <p role="status" className={styles.claudeCliStatusText}>
              {loginFlow === 'success' || hostLoggedIn
                ? `This host is logged in to Claude Code${claudeCliStatus.subscriptionType ? ` (${claudeCliStatus.subscriptionType})` : ''}. Paste a setup-token below to add it as a credential — logging in alone doesn't store one.`
                : claudeCliStatus.reason}
            </p>

            {!hostLoggedIn && loginFlow !== 'success' && claudeCliStatus.terminalLogin.available && (
              <div className={styles.claudeCliActions}>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => void handleLoginWithClaude()}
                  disabled={busy || loginBusy}
                >
                  <ExternalLinkSolidIcon size={14} aria-hidden="true" />
                  <span>{loginFlow === 'launching' ? 'Opening terminal…' : 'Log in with Claude'}</span>
                </Button>
                {loginFlow === 'waiting' && (
                  <Button type="button" variant="ghost" size="sm" onClick={handleCancelWaiting}>
                    <span>Cancel</span>
                  </Button>
                )}
              </div>
            )}

            {loginFlow === 'waiting' && (
              <p role="status" className={styles.claudeCliStatusText}>
                Waiting for you to finish signing in in the terminal window that just opened…
              </p>
            )}
            {loginFlow === 'timed-out' && (
              <p role="status" className={styles.claudeCliStatusText}>
                Still not signed in — the window may have closed. Try again above, or paste a setup-token below.
              </p>
            )}
            {loginFlow === 'launch-failed' && loginFlowReason && (
              <p role="alert" className={`${styles.claudeCliStatusText} ${styles.danger}`}>{loginFlowReason}</p>
            )}

            <details
              className={styles.claudeCliDisclosure}
              open={showTokenPaste}
              onToggle={(e) => setShowTokenPaste(e.currentTarget.open)}
            >
              <summary className={styles.claudeCliDisclosureSummary}>Or paste a setup-token instead</summary>
              <div className={styles.claudeCliDisclosureBody}>
                <p className={styles.claudeCliStatusText}>
                  Run <code>claude setup-token</code> anywhere the CLI is installed — your own
                  machine, or the machine Studio itself runs on — and paste the result below. This
                  is the only option when Studio is running on a remote server.
                </p>
                {claudeCliStatus.loginCommand && (
                  <p className={styles.claudeCliStatusText}>
                    Prefer to run the login yourself instead of the button above? Use this in your
                    own shell:
                    <code className={styles.dialogCode}>{claudeCliStatus.loginCommand}</code>
                  </p>
                )}
                <div className={styles.dialogField}>
                  <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>Setup token</label>
                  <Input
                    id={apiKeyInputId}
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.currentTarget.value)
                      // Typing a token IS choosing the other path. Stop waiting
                      // on the terminal so the footer's submit re-enables —
                      // otherwise a user who opened the terminal, gave up, and
                      // pasted a token instead sits in front of a disabled
                      // "Add credential" until the poll times out.
                      setLoginFlow((flow) => (flow === 'waiting' ? 'idle' : flow))
                    }}
                    placeholder={API_KEY_PLACEHOLDER.claudeCli}
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                  />
                </div>
              </div>
            </details>
          </div>
        )}

        {effectiveAuthMode === 'apiKey' && providerId !== 'claudeCli' && (
          <div className={styles.dialogField}>
            <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>API key</label>
            <Input
              id={apiKeyInputId}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              placeholder={API_KEY_PLACEHOLDER[providerId] ?? 'sk-...'}
              // Browsers ignore autoComplete="off" on password fields and
              // inject the saved admin login. "new-password" suppresses that;
              // the data-* attributes opt out of password-manager overlays.
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              required
            />
          </div>
        )}

        {effectiveAuthMode === 'baseUrl' && (
          <>
            <div className={styles.dialogField}>
              <label htmlFor={baseUrlInputId} className={styles.dialogFieldLabel}>Base URL</label>
              <Input
                id={baseUrlInputId}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.currentTarget.value)}
                placeholder={baseUrlPlaceholder}
                required
              />
            </div>
            <div className={styles.dialogField}>
              <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>
                {providerId === 'ollama' ? 'Bearer token (optional)' : 'API key (optional)'}
              </label>
              <Input
                id={apiKeyInputId}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.currentTarget.value)}
                placeholder="Leave blank if no auth"
                // See the API key field above: "new-password" + data-* opt-outs
                // stop the browser/password manager autofilling the admin login.
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
              />
            </div>
          </>
        )}

        {error && <p role="alert" className={styles.dialogError}>{error}</p>}
      </form>
    </Dialog>
  )
}
