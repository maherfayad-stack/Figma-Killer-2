/**
 * McpServersSection — Settings panel for a Studio project's OUTBOUND MCP
 * servers: the ones Studio's own agent connects OUT to (as opposed to the AI
 * section's "MCP connectors" tab, which is the inbound direction — external
 * clients connecting IN to Studio).
 *
 * Lists both server sources for the currently-open Studio project:
 *   - project-declared — the repo's own `.mcp.json` (read-only definitions;
 *     approve/revoke only, since the project file itself owns the shape).
 *   - registered — servers added here directly, for one that needs a secret
 *     `.mcp.json` cannot safely hold (see `server/ai/drivers/
 *     registeredMcpServers.ts`'s doc comment for the full design). These can
 *     be added, redefined, removed, and given secret values.
 *
 * Nothing here is approved by default — registering or merely having a
 * `.mcp.json` entry is NOT consent. The Approve control is the explicit
 * human action `projectMcpServers.ts` names as "(in future) an approval UI";
 * this is that UI. Approving a stdio server means STUDIO WILL RUN THAT
 * COMMAND on the next chat turn — the consent copy says so plainly, every
 * time, never just once on first use.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ApiError } from '@core/http'
import { cn } from '@ui/cn'
import type { ProjectMcpServerView, RegisteredMcpServerDefinition } from '@core/ai'
import {
  listProjectMcpServers,
  addRegisteredMcpServer,
  removeRegisteredMcpServer,
  setMcpServerApproval,
  getMcpOAuthStatus,
  getMcpCliConnection,
  startMcpOAuth,
  signOutMcpOAuth,
} from '../../../ai/api'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import s from './McpServersSection.module.css'

type Transport = 'stdio' | 'http' | 'sse'

const TRANSPORT_OPTIONS: Array<{ value: Transport; label: string }> = [
  { value: 'stdio', label: 'stdio (a local command Studio runs)' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
]

/** The host, for prose. Falls back to the raw string rather than throwing on a summary this component could not parse. */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The exact commands for a one-time CLI sign-in against Studio's own
 * `CLAUDE_CONFIG_DIR`.
 *
 * Needed because some providers run a closed client allow-list behind an
 * advertised registration endpoint — Figma's docs say only clients in its MCP
 * Catalog (Claude Code, VS Code, Cursor) may connect. Studio cannot register;
 * the CLI it already spawns is on the list, and its credential is scoped to
 * the config directory Studio points it at, so the sign-in has to happen
 * there and not in the user's ordinary `~/.claude`.
 *
 * Printed rather than executed: launching a terminal is unavailable on macOS
 * (`claudeCliPlatformSupport`) and the interactive `/mcp` step needs a real
 * TTY regardless, so a command the user can read and paste is the honest
 * affordance — not a button that works on one platform.
 *
 * **`-s user` is load-bearing, not a style choice.** Without it `claude mcp
 * add` writes a LOCAL-scope entry keyed to whatever directory it was run in,
 * and the CLI resolves servers — and their OAuth state — per directory.
 * Measured against one config dir and one endpoint, back to back: a
 * local-scope registration made at the repo root reported `! Needs
 * authentication` there while a user-scope one reported `✔ Connected` from
 * both an empty directory and a studio-workspace project. A credential that
 * exists to serve every project belongs at user scope, and it is also the only
 * scope `cliMcpConnectionProbe` (which runs in a neutral empty directory, so
 * it cannot execute a project's own `.mcp.json` servers) can see.
 */
function cliSignInCommands(configDir: string): string[] {
  // ONE command. Studio already ran the `claude mcp add -s user …` half itself
  // (`ensureCliMcpServerRegistered`) — it is non-interactive and idempotent, so
  // making a human paste it was pure ceremony. What remains is the only step
  // that cannot be automated: a TTY and a browser consent screen.
  return [`CLAUDE_CONFIG_DIR="${configDir}" claude`]
}

function transportOf(server: ProjectMcpServerView): Transport | 'unknown' {
  if (server.summary.startsWith('runs:')) return 'stdio'
  if (server.summary.startsWith('HTTP')) return 'http'
  if (server.summary.startsWith('SSE')) return 'sse'
  return 'unknown'
}

export function McpServersSection() {
  const dir = useAdminUi((state) => state.studioProject?.dir ?? null)

  const {
    data: loaded,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(
    (signal) => (dir ? listProjectMcpServers(dir, signal) : Promise.resolve([])),
    [dir],
    { fallbackError: 'Failed to load MCP servers.' },
  )
  const servers: ProjectMcpServerView[] = loaded ?? []
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [busyNames, setBusyNames] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  if (!dir) {
    return (
      <div className={s.body}>
        <div className={s.emptyState}>
          Open a Studio project to manage its MCP servers.
        </div>
      </div>
    )
  }

  async function withBusy(name: string, fn: () => Promise<void>) {
    setBusyNames((prev) => new Set(prev).add(name))
    try {
      await fn()
      setActionError(null)
      refresh()
    } catch (err) {
      const message = getErrorMessage(err, 'Action failed.')
      setActionError(message)
      pushToast({ kind: 'error', title: 'MCP server action failed', body: message })
    } finally {
      setBusyNames((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  async function handleApprove(server: ProjectMcpServerView) {
    await withBusy(server.name, () => setMcpServerApproval(dir!, server.name, server.source, true))
  }

  async function handleRevoke(server: ProjectMcpServerView) {
    await withBusy(server.name, () => setMcpServerApproval(dir!, server.name, server.source, false))
  }

  async function handleRemove(server: ProjectMcpServerView) {
    await withBusy(server.name, () => removeRegisteredMcpServer(dir!, server.name))
  }

  return (
    <div className={s.body}>
      <div className={s.sectionHeader}>
        <div>
          <h2>MCP servers</h2>
          <p>
            Let Studio&apos;s own agent reach a project&apos;s MCP servers — declared in its{' '}
            <code>.mcp.json</code>, or registered here directly for one that needs a secret the repo
            can&apos;t safely hold. Nothing is used until you explicitly approve it below.
          </p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={() => setShowAddDialog(true)}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Register server</span>
        </Button>
      </div>

      {error && <p role="alert" className={s.errorAlert}>{error}</p>}

      {loading ? (
        <div className={s.emptyState}>Loading…</div>
      ) : servers.length === 0 ? (
        <div className={s.emptyState}>
          No MCP servers for this project yet. Register one, or declare one in the project&apos;s own <code>.mcp.json</code>.
        </div>
      ) : (
        <div className={s.serverGrid}>
          {servers.map((server) => (
            <ServerRow
              key={`${server.source}:${server.name}`}
              dir={dir}
              server={server}
              busy={busyNames.has(server.name)}
              onApprove={() => void handleApprove(server)}
              onRevoke={() => void handleRevoke(server)}
              onRemove={server.source === 'registered' ? () => void handleRemove(server) : undefined}
            />
          ))}
        </div>
      )}

      {showAddDialog && (
        <AddServerDialog
          dir={dir}
          onClose={() => setShowAddDialog(false)}
          onAdded={() => {
            setActionError(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function ServerRow({
  dir,
  server,
  busy,
  onApprove,
  onRevoke,
  onRemove,
}: {
  dir: string
  server: ProjectMcpServerView
  busy: boolean
  onApprove: () => void
  onRevoke: () => void
  onRemove?: () => void
}) {
  const transport = transportOf(server)
  const isRemote = transport === 'http' || transport === 'sse'
  const serverUrl = server.summary.replace(/^(HTTP|SSE)\s+/, '')
  const serverHost = safeHost(serverUrl)
  const [signingIn, setSigningIn] = useState(false)
  const [awaitingReturn, setAwaitingReturn] = useState(false)
  // This attempt's own refusal, before the status refetch that persists it
  // catches up. The stored answer below is the durable one — a provider's
  // allow-list does not reopen between two clicks.
  const [refusedThisAttempt, setRefusedThisAttempt] = useState(false)
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)

  const {
    data: oauth,
    refresh: refreshOAuth,
  } = useAsyncResource(
    (signal) => (isRemote ? getMcpOAuthStatus(dir, server.name, signal) : Promise.resolve(null)),
    [dir, server.name, isRemote],
    { fallbackError: 'Failed to read sign-in status.' },
  )

  // Asked separately, and only when Studio holds no session of its own: the
  // answer costs a live health check, and it is the ONLY way to see a sign-in
  // that landed in the CLI's keychain rather than Studio's token store — which
  // is the only place it CAN land for a provider that refuses to register
  // Studio as a client. Without this the badge could never flip.
  const needsCliCheck = isRemote && oauth?.supportsOAuth === true && oauth.connected === false
  const { data: cli, loading: cliLoading, refresh: refreshCli } = useAsyncResource(
    (signal) => (needsCliCheck ? getMcpCliConnection(dir, server.name, signal) : Promise.resolve(null)),
    [dir, server.name, needsCliCheck],
    { fallbackError: 'Failed to read the CLI sign-in state.' },
  )
  const signedInViaCli = cli?.state === 'connected'

  // Learned once, on this project, the first time the provider refused —
  // `registrationClosed` in the status. Before that record exists (or before
  // the refetch lands) this attempt's own 403 stands in. Either way the panel
  // opens on the route that works instead of making the user prove again that
  // the other one does not.
  const registrationClosed = refusedThisAttempt || oauth?.registrationClosed === true

  // The probe answers `unknown` for a missing binary, a timeout, or a server
  // simply absent from the listing — none of which is "not signed in". Left
  // unsaid, a probe that could not run looks exactly like a definitive
  // negative, which is how a working sign-in reads as a broken one.
  const cliUnknown = cli !== null && cli.state === 'unknown'

  // The sign-in happens in another tab, so nothing in this one can observe it
  // finishing. Coming BACK to this tab is the signal — cheaper and more
  // reliable than polling, and it is exactly when the answer is about to be
  // looked at. Armed only while a sign-in is actually outstanding.
  useEffect(() => {
    if (!awaitingReturn) return
    const onFocus = () => {
      setAwaitingReturn(false)
      refreshOAuth()
      refreshCli()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [awaitingReturn, refreshOAuth, refreshCli])

  async function handleSignIn() {
    // Opened synchronously, BEFORE the await: a popup opened after an async
    // hop is no longer attributable to the click and gets blocked. The tab
    // starts blank and is pointed at the authorization URL once Studio has
    // discovered it and registered a client.
    const popup = window.open('', '_blank', 'noopener,noreferrer')
    setSigningIn(true)
    try {
      const authorizeUrl = await startMcpOAuth(dir, server.name)
      if (popup) {
        popup.location.href = authorizeUrl
        setAwaitingReturn(true)
      } else {
        // Popup blocked outright — navigating this tab still completes the
        // flow, since the callback redirects back into Studio.
        window.location.href = authorizeUrl
      }
    } catch (err) {
      popup?.close()
      // 403 is the server saying the PROVIDER forbade Studio — a closed client
      // allow-list, which no retry can change and which the status endpoint
      // now remembers. Swap the control for the route that does work instead
      // of toasting a failure the user cannot act on; every other status is a
      // real error and still toasts.
      if (err instanceof ApiError && err.status === 403) {
        setRefusedThisAttempt(true)
        refreshOAuth()
      } else {
        pushToast({ kind: 'error', title: 'Could not start sign-in', body: getErrorMessage(err, 'Unknown error.') })
      }
    } finally {
      setSigningIn(false)
    }
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedCommand(command)
      // Copying this command IS the "I am going to the terminal now" signal,
      // and coming back to this tab is the only observable end of a sign-in
      // that happens in another process. Arms the same focus re-probe the
      // browser flow arms — without it the panel keeps saying "Not signed in"
      // after a sign-in that worked, until Settings is closed and reopened.
      setAwaitingReturn(true)
    } catch (err) {
      // A denied clipboard permission is not a failure the user can act on —
      // the command is on screen and selectable either way.
      console.error('[McpServersSection] could not copy the sign-in command:', err)
      pushToast({ kind: 'error', title: 'Could not copy', body: 'Select the command and copy it manually.' })
    }
  }

  async function handleSignOut() {
    try {
      await signOutMcpOAuth(dir, server.name)
      refreshOAuth()
      refreshCli()
    } catch (err) {
      pushToast({ kind: 'error', title: 'Could not sign out', body: getErrorMessage(err, 'Unknown error.') })
    }
  }

  return (
    <div className={s.serverCard}>
      <div className={s.serverIdentity}>
        <div className={s.serverName}>
          <PlugSolidIcon size={14} aria-hidden="true" />
          <span>{server.name}</span>
        </div>
        <div className={s.serverSummary}>{server.summary}</div>
        <div className={s.serverMeta}>
          <span className={s.badge}>
            {server.source === 'project' ? 'Project-declared (.mcp.json)' : 'Registered in Studio'}
          </span>
          <span className={cn(s.badge, server.approved ? s.approved : s.unapproved)}>
            {server.approved ? 'Approved' : 'Not approved'}
          </span>
        </div>
        {transport === 'stdio' && (
          <p className={s.consentNote}>
            Approving this means Studio will RUN this command on your machine during a chat turn.
          </p>
        )}
        {server.source === 'registered' && server.secretFieldNames && server.secretFieldNames.length > 0 && (
          <div className={s.secretRow}>
            {server.secretFieldNames.map((field) => (
              <span key={field} className={s.badge}>
                {field}: {server.secretFieldsSet?.includes(field) ? 'secret set' : 'secret NOT set'}
              </span>
            ))}
          </div>
        )}
        {isRemote && oauth?.supportsOAuth && (
          <div className={s.secretRow}>
            {oauth.connected ? (
              <>
                <span className={cn(s.badge, s.approved)}>Signed in</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void handleSignOut()}>
                  <span>Sign out</span>
                </Button>
              </>
            ) : cliLoading ? (
              <span className={s.badge}>Checking sign-in…</span>
            ) : signedInViaCli ? (
              // Studio holds no session and never will for this provider — the
              // credential is the CLI's. Offering a Sign in button here would
              // be offering a button that cannot work, next to tools that
              // already do.
              <>
                <span className={cn(s.badge, s.approved)}>Signed in via the Claude CLI</span>
                <span className={s.cliHint}>Studio doesn&apos;t hold this credential; the CLI does.</span>
              </>
            ) : registrationClosed ? (
              // The provider's allow-list has already refused Studio once, and
              // that answer does not change on a retry. Keeping the button here
              // would contradict the panel below it, which says exactly that
              // and hands over the route that does work.
              <>
                <span className={cn(s.badge, s.unapproved)}>Not signed in</span>
                {cliUnknown && <span className={s.cliHint}>Studio could not ask the Claude CLI, so a sign-in there would not show up here.</span>}
              </>
            ) : (
              <>
                <span className={cn(s.badge, s.unapproved)}>Not signed in</span>
                <Button type="button" variant="primary" size="sm" onClick={() => void handleSignIn()} disabled={signingIn}>
                  <ExternalLinkSolidIcon size={12} aria-hidden="true" />
                  <span>{signingIn ? 'Opening…' : 'Sign in'}</span>
                </Button>
              </>
            )}
          </div>
        )}
        {isRemote && oauth?.supportsOAuth && !oauth.connected && !signedInViaCli && !cliLoading && server.approved && !registrationClosed && (
          <p className={s.consentNote}>
            This server needs a sign-in before the agent has any of its tools. Until then it connects
            with nothing and every call reports &ldquo;no such tool available&rdquo;.
          </p>
        )}
        {registrationClosed && !signedInViaCli && (
          <div className={s.cliSignIn} role="status">
            <p>
              {serverHost} only accepts sign-ins from MCP clients on its own approved list — Studio
              cannot register itself, and no amount of retrying will change that. The Claude CLI
              <em> is </em> on that list, and Studio already runs it against your own config
              directory, so signing in there once is inherited by every later turn.
            </p>
            {oauth?.cliConfigDir ? (
              <>
                <p>
                  Studio has registered the server with the CLI already. One step is left, and it
                  needs a terminal because it opens a browser consent screen:
                </p>
                <ol className={s.cliCommandList}>
                  {cliSignInCommands(oauth.cliConfigDir).map((command) => (
                    <li key={command} className={s.cliCommandRow}>
                      <code className={s.cliCommand}>{command}</code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyCommand(command)}
                        aria-label={`Copy command: ${command}`}
                      >
                        <span>{copiedCommand === command ? 'Copied' : 'Copy'}</span>
                      </Button>
                    </li>
                  ))}
                </ol>
                <p className={s.cliHint}>
                  In the session that opens, type <code>/mcp</code> and authenticate{' '}
                  <code>{server.name}</code>, then close it.
                </p>
              </>
            ) : (
              <p>
                This host cannot give each user their own CLI config directory, so there is no
                sign-in instruction Studio can honestly print here.
              </p>
            )}
          </div>
        )}
      </div>
      <div className={s.serverActions}>
        <Button type="button" variant={server.approved ? 'secondary' : 'primary'} size="sm" onClick={server.approved ? onRevoke : onApprove} disabled={busy}>
          <span>{server.approved ? 'Revoke' : 'Approve'}</span>
        </Button>
        {onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={busy}>
            <TrashSolidIcon size={14} aria-hidden="true" />
            <span>Remove</span>
          </Button>
        )}
      </div>
    </div>
  )
}

const ADD_SERVER_FORM_ID = 'mcp-server-add-form'

interface SecretFieldRow {
  name: string
  value: string
}

function AddServerDialog({
  dir,
  onClose,
  onAdded,
}: {
  dir: string
  onClose: () => void
  onAdded: () => void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [secretFields, setSecretFields] = useState<SecretFieldRow[]>([{ name: '', value: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateSecretField(index: number, patch: Partial<SecretFieldRow>) {
    setSecretFields((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function addSecretFieldRow() {
    setSecretFields((prev) => [...prev, { name: '', value: '' }])
  }

  function removeSecretFieldRow(index: number) {
    setSecretFields((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const namedSecrets = secretFields.filter((row) => row.name.trim().length > 0)
      const secretFieldNames = namedSecrets.map((row) => row.name.trim())

      const definition: RegisteredMcpServerDefinition =
        transport === 'stdio'
          ? {
              transport: 'stdio',
              command: command.trim(),
              args: args.trim().length > 0 ? args.trim().split(/\s+/) : undefined,
              secretEnvVarNames: secretFieldNames.length > 0 ? secretFieldNames : undefined,
            }
          : {
              transport,
              url: url.trim(),
              secretHeaderNames: secretFieldNames.length > 0 ? secretFieldNames : undefined,
            }

      const secrets: Record<string, string> = {}
      for (const row of namedSecrets) {
        if (row.value.length > 0) secrets[row.name.trim()] = row.value
      }

      await addRegisteredMcpServer({
        dir,
        name: name.trim(),
        definition,
        secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
      })
      onAdded()
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to register server.'))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = name.trim().length > 0 && (transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0)

  return (
    <Dialog
      open
      onClose={onClose}
      title="Register MCP server"
      size="xl"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button type="submit" form={ADD_SERVER_FORM_ID} variant="primary" size="sm" disabled={busy || !canSubmit}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Register (unapproved)</span>
          </Button>
        </>
      }
    >
      <form id={ADD_SERVER_FORM_ID} className={dialogStyles.form} onSubmit={(e) => void handleSubmit(e)}>
        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Name</span>
          <Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="e.g. figma" required />
        </div>
        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Transport</span>
          <Select value={transport} onChange={(e) => setTransport(e.currentTarget.value as Transport)} options={TRANSPORT_OPTIONS} />
        </div>
        {transport === 'stdio' ? (
          <>
            <div className={dialogStyles.field}>
              <span className={dialogStyles.label}>Command</span>
              <Input value={command} onChange={(e) => setCommand(e.currentTarget.value)} placeholder="npx" required />
            </div>
            <div className={dialogStyles.field}>
              <span className={dialogStyles.label}>Arguments (space-separated)</span>
              <Input value={args} onChange={(e) => setArgs(e.currentTarget.value)} placeholder="-y figma-mcp" />
            </div>
          </>
        ) : (
          <div className={dialogStyles.field}>
            <span className={dialogStyles.label}>URL</span>
            <Input value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://example.com/mcp" required />
          </div>
        )}

        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>
            {transport === 'stdio' ? 'Secret environment variables' : 'Secret headers'}
          </span>
          {secretFields.map((row, index) => (
            <div key={index} className={s.secretFieldRow}>
              <Input
                value={row.name}
                onChange={(e) => updateSecretField(index, { name: e.currentTarget.value })}
                placeholder={transport === 'stdio' ? 'FIGMA_TOKEN' : 'Authorization'}
              />
              <Input
                value={row.value}
                onChange={(e) => updateSecretField(index, { value: e.currentTarget.value })}
                placeholder="value (optional now, can be set later)"
                type="password"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeSecretFieldRow(index)}
                aria-label={row.name ? `Remove secret field ${row.name}` : 'Remove secret field'}
              >
                <TrashSolidIcon size={14} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" onClick={addSecretFieldRow}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Add secret field</span>
          </Button>
        </div>

        <p className={s.consentNote}>
          Registering saves this as UNAPPROVED. Approve it afterward once you&apos;ve reviewed the exact
          command or URL above.
        </p>

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
