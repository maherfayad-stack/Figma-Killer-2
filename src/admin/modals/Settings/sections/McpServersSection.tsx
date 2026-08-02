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
import { useState, type FormEvent } from 'react'
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
import { cn } from '@ui/cn'
import type { ProjectMcpServerView, RegisteredMcpServerDefinition } from '@core/ai'
import {
  listProjectMcpServers,
  addRegisteredMcpServer,
  removeRegisteredMcpServer,
  setMcpServerApproval,
  checkMcpServerAuth,
} from '../../../ai/api'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import s from './McpServersSection.module.css'

type Transport = 'stdio' | 'http' | 'sse'

const TRANSPORT_OPTIONS: Array<{ value: Transport; label: string }> = [
  { value: 'stdio', label: 'stdio (a local command Studio runs)' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
]

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
  server,
  busy,
  onApprove,
  onRevoke,
  onRemove,
}: {
  server: ProjectMcpServerView
  busy: boolean
  onApprove: () => void
  onRevoke: () => void
  onRemove?: () => void
}) {
  const transport = transportOf(server)
  const [authLink, setAuthLink] = useState<string | null | undefined>(undefined)
  const [checkingAuth, setCheckingAuth] = useState(false)

  async function handleCheckAuth() {
    const url = server.summary.replace(/^(HTTP|SSE)\s+/, '')
    setCheckingAuth(true)
    try {
      const result = await checkMcpServerAuth(url)
      setAuthLink(result.authorizationUrl)
      if (!result.authorizationUrl) {
        pushToast({
          kind: 'error',
          title: 'No sign-in link found',
          body: result.requiresAuth
            ? 'The server requires authorization but did not publish a discoverable sign-in link.'
            : 'This server did not report an authorization requirement.',
        })
      }
    } catch (err) {
      pushToast({ kind: 'error', title: 'Could not check authorization', body: getErrorMessage(err, 'Unknown error.') })
    } finally {
      setCheckingAuth(false)
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
        {(transport === 'http' || transport === 'sse') && (
          <div className={s.secretRow}>
            <Button type="button" variant="ghost" size="sm" onClick={() => void handleCheckAuth()} disabled={checkingAuth}>
              <span>{checkingAuth ? 'Checking…' : 'Check for sign-in link'}</span>
            </Button>
            {authLink && (
              <a href={authLink} target="_blank" rel="noreferrer noopener" className={s.authLink}>
                <ExternalLinkSolidIcon size={12} aria-hidden="true" />
                <span>Sign in to this server</span>
              </a>
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
