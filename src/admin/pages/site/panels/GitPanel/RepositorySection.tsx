/**
 * RepositorySection — the top of the version-control panel: who you are on
 * GitHub, and which repository this project pushes to.
 *
 * It sits above the branch bar because it answers the two questions that come
 * FIRST and that the panel previously never answered at all. Before G1/G2 the
 * panel's push button was disabled with the tooltip "This project has no
 * origin remote", and there was nothing anywhere in Studio that could add one;
 * and an auth failure showed git's "Support for password authentication was
 * removed" with no action attached. Both of those are now a button here.
 *
 * ## Sign-in
 *
 * The device flow is the good path and the default: a short code, a URL, and
 * a poll — no client secret, and no redirect URI that would have to match
 * whatever host this install runs on. Polling follows the same shape
 * `ProvidersTab.tsx` uses for the Claude login: an effect keyed on the
 * waiting state owns the interval, the timeout, and the `AbortController`, so
 * closing the panel stops it with no extra wiring.
 *
 * When the server has no OAuth App client id configured (`clientConfigured:
 * false`, or a 501 from `device/start`), the paste-a-token disclosure opens
 * instead. That path needs no server configuration at all, which is why it
 * exists — not as a "power user" option but as the one that always works.
 *
 * **No token is ever rendered, stored in component state beyond the submit,
 * or logged.** The paste field's value is handed to `saveGithubToken` and then
 * cleared; every response this component reads carries a login and an avatar,
 * never a credential.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Code } from '@ui/components/Code'
import { Input } from '@ui/components/Input'
import { Section } from '@ui/components/Section'
import { pushToast } from '@ui/components/Toast'
import { ApiError, isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  connectGitRemote,
  getGitRemotes,
  getGithubAccount,
  listGithubRepositories,
  pollGithubDeviceLogin,
  saveGithubToken,
  signOutOfGithub,
  startGithubDeviceLogin,
  type GitRemote,
  type GithubAccount,
  type GithubRepository,
} from '@site/studio/gitRequests'
import styles from './RepositorySection.module.css'

/**
 * The sign-in state machine. `waiting` is the only one that polls, which is
 * what the effect below keys on — see the module doc.
 */
type SignInFlow =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; flowId: string; userCode: string; verificationUri: string; intervalSeconds: number }
  | { kind: 'failed'; reason: string }

/** Generous: the user has to switch to a browser tab, sign in, and type a code. */
const DEVICE_POLL_TIMEOUT_MS = 10 * 60_000

interface RepositorySectionProps {
  /** Whether the panel is open. Polling stops when it is not — the component unmounts, but this also stops a poll left running behind a collapsed section. */
  active: boolean
  /** The open project. `undefined` means "the server's default project", exactly as everywhere else in this panel. */
  dir: string | undefined
  /** Whether the project has a `.git` at all. Remotes are only readable — and only meaningful — when it does. */
  isRepo: boolean
  /** Re-read git status after connecting a remote: `hasOrigin` decides whether Push is enabled. */
  onRemoteChanged: () => void
}

export function RepositorySection({ active, dir, isRepo, onRemoteChanged }: RepositorySectionProps) {
  const [account, setAccount] = useState<GithubAccount | null>(null)
  const [clientConfigured, setClientConfigured] = useState(true)
  /**
   * The read this component has an answer for. `loading` is derived from it
   * rather than set at the top of the effect — a synchronous `setState` in an
   * effect body forces a second render before the fetch starts, and
   * `react-hooks/set-state-in-effect` rejects it. Same shape (and the same
   * reasoning) as `useGitStatus.ts`.
   */
  const [answeredKey, setAnsweredKey] = useState<string | null>(null)
  const [flow, setFlow] = useState<SignInFlow>({ kind: 'idle' })
  const [showTokenPaste, setShowTokenPaste] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  // Remote state. `origin` is the only one this panel writes; the rest are
  // shown so the panel never quietly disagrees with the user's terminal.
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [remoteNonce, setRemoteNonce] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [pickerRepos, setPickerRepos] = useState<GithubRepository[] | null>(null)

  const readKey = active ? 'active' : 'idle'
  const loading = active && answeredKey !== readKey
  const origin = remotes.find((remote) => remote.name === 'origin') ?? null

  // Who is signed in. Re-read whenever the panel becomes active: a sign-out
  // in another tab, or a token GitHub revoked, both show up here.
  useEffect(() => {
    if (!active) return undefined
    const controller = new AbortController()
    getGithubAccount(controller.signal)
      .then((res) => {
        setAccount(res.account)
        setClientConfigured(res.clientConfigured)
        // No OAuth App on this server and nobody signed in: the paste path is
        // the only one that can work, so open it rather than showing a
        // disabled button with a tooltip nobody hovers.
        if (!res.clientConfigured && !res.account) setShowTokenPaste(true)
        setAnsweredKey(readKey)
      })
      .catch((err) => {
        if (isAbortError(err)) return
        console.error('[RepositorySection] could not read the GitHub account:', err)
        setAnsweredKey(readKey)
      })
    return () => controller.abort()
  }, [active, readKey])

  // The project's remotes. Only meaningful once a repository exists —
  // `GET git/remotes` sits behind `assertOwnGitRepo` and would 404 for a
  // project nobody has run `git init` in yet, which is a state, not a failure.
  useEffect(() => {
    if (!active || !isRepo) return undefined
    const controller = new AbortController()
    getGitRemotes(dir, controller.signal)
      .then(setRemotes)
      .catch((err) => {
        if (isAbortError(err)) return
        console.error('[RepositorySection] could not read the remotes:', err)
      })
    return () => controller.abort()
  }, [active, isRepo, dir, remoteNonce])

  // Poll while — and only while — a device sign-in is actually pending. The
  // interval, the timeout, and the abort all live here so there is exactly
  // one place that stops.
  useEffect(() => {
    if (flow.kind !== 'waiting') return undefined
    const { flowId, intervalSeconds } = flow
    const controller = new AbortController()
    const startedAt = Date.now()
    const interval = setInterval(() => {
      if (Date.now() - startedAt > DEVICE_POLL_TIMEOUT_MS) {
        clearInterval(interval)
        setFlow({ kind: 'failed', reason: 'The sign-in code expired. Start again.' })
        setShowTokenPaste(true)
        return
      }
      void pollGithubDeviceLogin(flowId, controller.signal)
        .then((result) => {
          if (result.status === 'pending') return
          clearInterval(interval)
          if (result.status === 'authorized' && result.account) {
            setAccount(result.account)
            setFlow({ kind: 'idle' })
            pushToast({
              kind: 'success',
              title: `Signed in as ${result.account.login}`,
              body: 'Studio can now push to your repositories.',
            })
            return
          }
          setFlow({
            kind: 'failed',
            reason:
              result.status === 'denied'
                ? 'The sign-in was declined on GitHub.'
                : 'The sign-in code expired. Start again.',
          })
          setShowTokenPaste(true)
        })
        .catch((err) => {
          if (isAbortError(err)) return
          // A 404 means the server forgot the flow (a restart). Anything else
          // is transient — keep polling until the timeout above fires.
          if (err instanceof ApiError && err.status === 404) {
            clearInterval(interval)
            setFlow({ kind: 'failed', reason: 'That sign-in stopped being tracked. Start again.' })
            setShowTokenPaste(true)
          }
        })
    }, Math.max(1, intervalSeconds) * 1000)
    return () => {
      clearInterval(interval)
      controller.abort()
    }
  }, [flow])

  async function handleStartDeviceLogin() {
    setFlow({ kind: 'starting' })
    try {
      const start = await startGithubDeviceLogin()
      setFlow({
        kind: 'waiting',
        flowId: start.flowId,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        intervalSeconds: start.intervalSeconds,
      })
    } catch (err) {
      console.error('[RepositorySection] could not start the GitHub device sign-in:', err)
      setFlow({ kind: 'failed', reason: getErrorMessage(err, 'Could not start a GitHub sign-in.') })
      // A 501 is "this server has no OAuth App configured" — the paste path is
      // the answer, not a retry.
      setShowTokenPaste(true)
    }
  }

  async function handlePasteToken() {
    const value = token.trim()
    if (!value) return
    setBusy(true)
    try {
      const signedIn = await saveGithubToken(value)
      setAccount(signedIn)
      setToken('')
      setFlow({ kind: 'idle' })
      setShowTokenPaste(false)
      pushToast({ kind: 'success', title: `Signed in as ${signedIn.login}`, body: 'Studio can now push to your repositories.' })
    } catch (err) {
      console.error('[RepositorySection] the pasted GitHub token was rejected:', err)
      pushToast({
        kind: 'error',
        title: 'That token was not accepted',
        body: getErrorMessage(err, 'GitHub did not recognise the token.'),
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleConnect(url: string) {
    const value = url.trim()
    if (!value) return
    setConnecting(true)
    try {
      const connected = await connectGitRemote(dir, value)
      setRemoteUrl('')
      setPickerRepos(null)
      setRemoteNonce((n) => n + 1)
      // `hasOrigin` is what enables Push, and it lives in the panel's status
      // read — not this one.
      onRemoteChanged()
      pushToast({ kind: 'success', title: 'Connected to origin', body: connected.pushUrl || connected.fetchUrl })
    } catch (err) {
      console.error('[RepositorySection] could not connect the remote:', err)
      pushToast({
        kind: 'error',
        title: 'Could not connect that repository',
        body: getErrorMessage(err, 'Unknown git error'),
      })
    } finally {
      setConnecting(false)
    }
  }

  async function handleOpenPicker() {
    setConnecting(true)
    try {
      setPickerRepos(await listGithubRepositories())
    } catch (err) {
      console.error('[RepositorySection] could not list repositories:', err)
      pushToast({
        kind: 'error',
        title: 'Could not read your repositories',
        body: getErrorMessage(err, 'Unknown GitHub error'),
      })
    } finally {
      setConnecting(false)
    }
  }

  async function handleSignOut() {
    setBusy(true)
    try {
      await signOutOfGithub()
      setAccount(null)
      setFlow({ kind: 'idle' })
      pushToast({ kind: 'success', title: 'Signed out of GitHub', body: 'The stored token was deleted.' })
    } catch (err) {
      console.error('[RepositorySection] sign-out failed:', err)
      pushToast({ kind: 'error', title: 'Could not sign out', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Repository" defaultOpen>
      {account ? (
        <div className={styles.account}>
          {account.avatarUrl ? (
            <img className={styles.avatar} src={account.avatarUrl} alt="" width={24} height={24} />
          ) : null}
          <div className={styles.accountText}>
            <strong>{account.login}</strong>
            <span className={styles.accountMeta}>
              {account.scopes.length > 0 ? account.scopes.join(', ') : 'no scopes reported'}
            </span>
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      ) : (
        <div className={styles.signIn}>
          {flow.kind === 'waiting' ? (
            <>
              <p className={styles.instruction}>
                Open <strong>{flow.verificationUri}</strong> and enter this code:
              </p>
              <Code className={styles.userCode}>{flow.userCode}</Code>
              <p className={styles.hint}>Waiting for you to authorise Studio on GitHub…</p>
              <Button variant="ghost" size="sm" onClick={() => setFlow({ kind: 'idle' })}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <p className={styles.instruction}>
                Sign in so Studio can push to your repositories — no terminal, no credential helper.
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={loading || busy || flow.kind === 'starting' || !clientConfigured}
                tooltip={
                  clientConfigured
                    ? 'Shows a code to enter at github.com'
                    : 'This server has no GitHub OAuth App configured — paste a token instead.'
                }
                onClick={handleStartDeviceLogin}
              >
                {flow.kind === 'starting' ? 'Starting…' : 'Sign in to GitHub'}
              </Button>
            </>
          )}

          {flow.kind === 'failed' ? (
            <p className={styles.failure} role="alert">
              {flow.reason}
            </p>
          ) : null}

          {showTokenPaste ? (
            <div className={styles.tokenRow}>
              <Input
                type="password"
                fieldSize="sm"
                value={token}
                placeholder="ghp_… (a token with the repo scope)"
                aria-label="GitHub personal access token"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button variant="secondary" size="sm" disabled={busy || !token.trim()} onClick={handlePasteToken}>
                Save
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setShowTokenPaste(true)}>
              Paste a token instead
            </Button>
          )}
        </div>
      )}

      {/* -------------------------------------------------------------------
          Where this project pushes. Shown only once the project HAS a
          repository: `git remote` has nothing to say about a directory with no
          `.git`, and the panel's own "Create a repository" offer is the step
          before this one.
      ------------------------------------------------------------------- */}
      {isRepo ? (
        <div className={styles.remote}>
          {origin ? (
            <div className={styles.originRow}>
              <span className={styles.originLabel}>origin</span>
              <span className={styles.originUrl}>{origin.pushUrl || origin.fetchUrl}</span>
              <Button
                variant="ghost"
                size="xs"
                disabled={connecting}
                onClick={() => setRemoteUrl(origin.pushUrl || origin.fetchUrl)}
              >
                Change
              </Button>
            </div>
          ) : (
            <p className={styles.hint}>
              This project has no <strong>origin</strong>, so there is nowhere to push yet.
            </p>
          )}

          {!origin || remoteUrl ? (
            <>
              <div className={styles.tokenRow}>
                <Input
                  fieldSize="sm"
                  value={remoteUrl}
                  placeholder="https://github.com/owner/repo"
                  aria-label="Repository URL"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connecting}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={connecting || !remoteUrl.trim()}
                  onClick={() => void handleConnect(remoteUrl)}
                >
                  Connect
                </Button>
              </div>

              {account && pickerRepos === null ? (
                <Button variant="ghost" size="sm" disabled={connecting} onClick={handleOpenPicker}>
                  Pick from your repositories
                </Button>
              ) : null}

              {pickerRepos !== null ? (
                <ul className={styles.repoList}>
                  {pickerRepos.length === 0 ? (
                    <li className={styles.hint}>GitHub returned no repositories for this account.</li>
                  ) : (
                    pickerRepos.map((repo) => (
                      <li key={repo.fullName}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={styles.repoButton}
                          disabled={connecting}
                          onClick={() => void handleConnect(repo.cloneUrl)}
                        >
                          <span className={styles.repoName}>{repo.fullName}</span>
                          {repo.isPrivate ? <span className={styles.repoTag}>private</span> : null}
                        </Button>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}
