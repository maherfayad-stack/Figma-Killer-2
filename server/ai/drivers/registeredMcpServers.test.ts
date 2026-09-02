import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listRegisteredMcpServers,
  addRegisteredMcpServer,
  removeRegisteredMcpServer,
  approveRegisteredMcpServer,
  revokeRegisteredMcpServer,
  resolvedApprovedRegisteredMcpServers,
  registeredMcpServerProjectKey,
  isSelfApprovingBuiltIn,
  ReservedMcpServerNameError,
} from './registeredMcpServers'
import { setMcpServerSecret, getMcpServerSecret } from '../credentials/mcpServerSecretStore'
import { buildMcpOAuthSession, writeMcpOAuthSession } from '../credentials/mcpOAuthStore'
import { readStudioMeta, mergeStudioMeta } from '../../handlers/studio/studioMeta'

/**
 * The servers this PROJECT registered, with Studio's own built-ins filtered
 * out. Built-ins are present in every project, so a bare
 * `listRegisteredMcpServers(dir)[0]` no longer means "the one I just added" —
 * these tests are about registration mechanics, not about what ships by
 * default, and they select by name so the two stay independent.
 */
function listOwn(dir: string) {
  const builtInNames = new Set(['figma'])
  return listRegisteredMcpServers(dir).filter((s) => !builtInNames.has(s.name))
}

describe('registeredMcpServers', () => {
  let projectDir: string
  let secretsRoot: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'registered-mcp-project-'))
    secretsRoot = mkdtempSync(join(tmpdir(), 'registered-mcp-secrets-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(secretsRoot, { recursive: true, force: true })
  })

  it('lists only the built-ins for a project that has registered nothing of its own', () => {
    // Was `toEqual([])` before built-in servers existed. Studio ships `figma`
    // — Figma's REMOTE MCP server — into every project, so "registered
    // nothing" no longer means "sees nothing".
    const listed = listRegisteredMcpServers(projectDir)
    expect(listed.map((s) => s.name)).toEqual(['figma'])
    expect(listed[0]!.definition).toEqual({ transport: 'http', url: 'https://mcp.figma.com/mcp' })
    // No secret FIELD: the remote server is OAuth-only, so there is no token
    // to prompt anyone to paste. The credential Studio does hold for it comes
    // from the browser sign-in flow and is stored out of band
    // (`credentials/mcpOAuthStore.ts`), never as a declared secret header.
    expect(listed[0]!.secretFieldNames).toEqual([])
  })

  describe('built-in servers', () => {
    // The built-in Figma server is REMOTE, so being shipped buys it visibility
    // and nothing else. This is the property that matters: a server that
    // leaves this machine must never reach a turn on Studio's say-so.
    it('does NOT self-approve the shipped Figma server — it is not loopback', () => {
      const listed = listRegisteredMcpServers(projectDir)
      expect(listed[0]!.approved).toBe(false)
    })

    // Tested directly rather than through the shipped list: no entry in it
    // passes this gate any more, and the gate is what any FUTURE built-in has
    // to clear, so its positive branch still needs to be pinned.
    it('self-approval requires loopback AND no secret AND no headers, and nothing else', () => {
      expect(isSelfApprovingBuiltIn({ transport: 'http', url: 'http://127.0.0.1:3845/mcp' })).toBe(true)
      expect(isSelfApprovingBuiltIn({ transport: 'http', url: 'http://localhost:9/mcp' })).toBe(true)
      // Remote host — the shipped Figma entry's own case.
      expect(isSelfApprovingBuiltIn({ transport: 'http', url: 'https://mcp.figma.com/mcp' })).toBe(false)
      // A name that merely LOOKS local. The check is set membership on the
      // parsed hostname, never a prefix or suffix test.
      expect(isSelfApprovingBuiltIn({ transport: 'http', url: 'http://localhost.evil.com/mcp' })).toBe(false)
      // Loopback, but carries a credential either way it can.
      expect(
        isSelfApprovingBuiltIn({ transport: 'http', url: 'http://127.0.0.1:3845/mcp', secretHeaderNames: ['X-Token'] }),
      ).toBe(false)
      expect(
        isSelfApprovingBuiltIn({ transport: 'http', url: 'http://127.0.0.1:3845/mcp', headers: { 'X-A': 'b' } }),
      ).toBe(false)
      // stdio is a command line — arbitrary code, never self-approved.
      expect(isSelfApprovingBuiltIn({ transport: 'stdio', command: 'npx' })).toBe(false)
    })

    // The escape hatch for anyone who wants the desktop app's Dev Mode server
    // back: register it yourself under the same name. Loopback and secret-free,
    // so it needs no token — but as a project entry it still takes an approval.
    it('lets a project put the loopback desktop server back under the same name', () => {
      addRegisteredMcpServer(projectDir, {
        name: 'figma',
        definition: { transport: 'http', url: 'http://127.0.0.1:3845/mcp' },
      })
      const listed = listRegisteredMcpServers(projectDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.definition).toMatchObject({ url: 'http://127.0.0.1:3845/mcp' })
      expect(listed[0]!.secretFieldNames).toEqual([])
    })

    it('lets a project turn a built-in off, and the opt-out beats the built-in', () => {
      mergeStudioMeta(projectDir, { disabledBuiltInMcpServers: ['figma'] })
      expect(listRegisteredMcpServers(projectDir)).toEqual([])
    })

    it('a project\'s own entry of the same name REPLACES the built-in and does NOT inherit its approval', () => {
      addRegisteredMcpServer(projectDir, {
        name: 'figma',
        definition: {
          transport: 'http',
          url: 'https://figma.example.internal/mcp',
          secretHeaderNames: ['X-Figma-Token'],
        },
      })
      const listed = listRegisteredMcpServers(projectDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.definition).toMatchObject({ url: 'https://figma.example.internal/mcp' })
      expect(listed[0]!.approved).toBe(false)
      expect(listed[0]!.secretFieldNames).toEqual(['X-Figma-Token'])
    })

    it('resolves the shipped Figma server into a turn only once approved, and unauthenticated until signed in', async () => {
      // Unapproved: absent entirely.
      expect(await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)).toEqual({})

      // Approved but not signed in: a bare URL with NO Authorization header.
      // This is the state that produced "No such tool available:
      // mcp__figma__get_screenshot" — the server connects and registers
      // nothing. Pinned so the two halves stay distinguishable: approval is
      // not authentication.
      approveRegisteredMcpServer(projectDir, 'figma')
      const unauthenticated = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
      expect(unauthenticated.figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' })
    })

    it('attaches the Bearer header once an OAuth session exists for that user', async () => {
      approveRegisteredMcpServer(projectDir, 'figma')
      await writeMcpOAuthSession(
        { userId: 'user-1', projectKey: registeredMcpServerProjectKey(projectDir), serverName: 'figma', dataRoot: secretsRoot },
        buildMcpOAuthSession({
          serverUrl: 'https://mcp.figma.com/mcp',
          metadata: {
            resource: 'https://mcp.figma.com/mcp',
            issuer: 'https://api.figma.com',
            authorizationEndpoint: 'https://www.figma.com/oauth/mcp',
            tokenEndpoint: 'https://api.figma.com/v1/oauth/token',
            registrationEndpoint: 'https://api.figma.com/v1/oauth/mcp/register',
            scope: 'mcp:connect',
          },
          clientId: 'cid-1',
          clientSecret: null,
          redirectUri: 'http://localhost:5173/admin/api/ai/mcp/oauth/callback',
          tokens: { accessToken: 'at-live', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, scope: 'mcp:connect' },
        }),
      )

      const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
      expect(resolved.figma).toEqual({
        type: 'http',
        url: 'https://mcp.figma.com/mcp',
        headers: { Authorization: 'Bearer at-live' },
      })
    })

    it('does not lend one user\'s session to another user\'s turn', async () => {
      approveRegisteredMcpServer(projectDir, 'figma')
      await writeMcpOAuthSession(
        { userId: 'user-1', projectKey: registeredMcpServerProjectKey(projectDir), serverName: 'figma', dataRoot: secretsRoot },
        buildMcpOAuthSession({
          serverUrl: 'https://mcp.figma.com/mcp',
          metadata: {
            resource: 'https://mcp.figma.com/mcp',
            issuer: 'https://api.figma.com',
            authorizationEndpoint: 'https://www.figma.com/oauth/mcp',
            tokenEndpoint: 'https://api.figma.com/v1/oauth/token',
            registrationEndpoint: null,
            scope: 'mcp:connect',
          },
          clientId: 'cid-1',
          clientSecret: null,
          redirectUri: 'http://localhost/cb',
          tokens: { accessToken: 'at-live', refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: null },
        }),
      )

      const other = await resolvedApprovedRegisteredMcpServers('user-2', projectDir, secretsRoot)
      expect(other.figma).toEqual({ type: 'http', url: 'https://mcp.figma.com/mcp' })
    })
  })

  it('adds a stdio server as unapproved, with its secret field names surfaced but no secret value', () => {
    addRegisteredMcpServer(projectDir, {
      name: 'acme-design',
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-mcp'],
        secretEnvVarNames: ['ACME_TOKEN'],
      },
    })

    const servers = listOwn(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('acme-design')
    expect(servers[0].approved).toBe(false)
    expect(servers[0].secretFieldNames).toEqual(['ACME_TOKEN'])
    expect(servers[0].summary).toContain('npx')
    // No secret value anywhere in the persisted meta or the listing.
    expect(JSON.stringify(readStudioMeta(projectDir))).not.toContain('sk-')
  })

  it('refuses the name "studio" — reserved for Studio\'s own MCP entry', () => {
    expect(() =>
      addRegisteredMcpServer(projectDir, {
        name: 'studio',
        definition: { transport: 'http', url: 'https://example.com/mcp' },
      }),
    ).toThrow(ReservedMcpServerNameError)
  })

  it('approve/revoke toggles the approved flag and is idempotent', () => {
    addRegisteredMcpServer(projectDir, {
      name: 'github',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    expect(listOwn(projectDir)[0].approved).toBe(false)

    approveRegisteredMcpServer(projectDir, 'github')
    approveRegisteredMcpServer(projectDir, 'github')
    expect(listOwn(projectDir)[0].approved).toBe(true)

    revokeRegisteredMcpServer(projectDir, 'github')
    revokeRegisteredMcpServer(projectDir, 'github')
    expect(listOwn(projectDir)[0].approved).toBe(false)
  })

  it('redefining an existing server name revokes its prior approval', () => {
    addRegisteredMcpServer(projectDir, {
      name: 'github',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    approveRegisteredMcpServer(projectDir, 'github')
    expect(listOwn(projectDir)[0].approved).toBe(true)

    // Same name, different command line — this must not silently inherit trust.
    addRegisteredMcpServer(projectDir, {
      name: 'github',
      definition: { transport: 'http', url: 'https://evil.example.com/mcp' },
    })
    const servers = listOwn(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].approved).toBe(false)
    expect(servers[0].definition).toMatchObject({ url: 'https://evil.example.com/mcp' })
  })

  it('removeRegisteredMcpServer drops the definition, approval, and stored secrets', async () => {
    const projectKey = registeredMcpServerProjectKey(projectDir)
    addRegisteredMcpServer(projectDir, {
      name: 'acme-design',
      definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['ACME_TOKEN'] },
    })
    approveRegisteredMcpServer(projectDir, 'acme-design')
    await setMcpServerSecret('user-1', projectKey, 'acme-design', 'ACME_TOKEN', 'sk-secret', secretsRoot)

    removeRegisteredMcpServer('user-1', projectDir, 'acme-design', secretsRoot)

    expect(listOwn(projectDir)).toEqual([])
    expect(await getMcpServerSecret('user-1', projectKey, 'acme-design', 'ACME_TOKEN', secretsRoot)).toBeNull()
  })

  it('resolvedApprovedRegisteredMcpServers only includes approved servers, with secret env vars decrypted and injected', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'acme-design',
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-mcp'],
        env: { FIGMA_HOST: 'figma.com' },
        secretEnvVarNames: ['ACME_TOKEN'],
      },
    })
    addRegisteredMcpServer(projectDir, {
      name: 'not-approved',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    approveRegisteredMcpServer(projectDir, 'acme-design')

    const projectKey = registeredMcpServerProjectKey(projectDir)
    await setMcpServerSecret('user-1', projectKey, 'acme-design', 'ACME_TOKEN', 'sk-secret-value', secretsRoot)

    const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)

    expect(Object.keys(resolved).filter((k) => k !== 'figma')).toEqual(['acme-design'])
    const own = resolved['acme-design'] as { command: string; env?: Record<string, string> }
    expect(own.command).toBe('npx')
    expect(own.env).toMatchObject({ FIGMA_HOST: 'figma.com', ACME_TOKEN: 'sk-secret-value' })
  })

  it('resolvedApprovedRegisteredMcpServers drops (never crashes on) a server whose declared secret was never set', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'acme-design',
      definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['ACME_TOKEN'] },
    })
    approveRegisteredMcpServer(projectDir, 'acme-design')
    // Secret deliberately never set.

    const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
    // The built-in still resolves (it has no secret to miss) — what matters
    // is that the server whose secret is absent is dropped rather than
    // throwing and taking the whole turn's MCP config down with it.
    expect(resolved['acme-design']).toBeUndefined()
    // The built-in Figma server is unapproved here, so it is absent too —
    // what matters is that the missing secret dropped ONE server rather than
    // throwing and taking the whole turn's MCP config down.
    expect(Object.keys(resolved)).toEqual([])
  })

  it('resolvedApprovedRegisteredMcpServers resolves http secret headers too', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'ghapi',
      definition: {
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Client': 'studio' },
        secretHeaderNames: ['Authorization'],
      },
    })
    approveRegisteredMcpServer(projectDir, 'ghapi')
    const projectKey = registeredMcpServerProjectKey(projectDir)
    await setMcpServerSecret('user-1', projectKey, 'ghapi', 'Authorization', 'Bearer abc123', secretsRoot)

    const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
    const ghapi = resolved.ghapi as { url: string; headers?: Record<string, string> }
    expect(ghapi.url).toBe('https://example.com/mcp')
    expect(ghapi.headers).toMatchObject({ 'X-Client': 'studio', Authorization: 'Bearer abc123' })
  })

  describe('registeredMcpServerProjectKey', () => {
    it('derives a stable, safe key from the project directory relative to the projects root', () => {
      const root = mkdtempSync(join(tmpdir(), 'projects-root-'))
      const project = join(root, 'my-project')
      mkdirSync(project)
      expect(registeredMcpServerProjectKey(project, root)).toBe('my-project')
      rmSync(root, { recursive: true, force: true })
    })

    it('never returns exactly ".." or "." even for a dir outside the given root', () => {
      const root = mkdtempSync(join(tmpdir(), 'projects-root-'))
      // `root` itself is one level "outside" a project nested directly under
      // it — relative(root, root) is '', and relative(root, dirname(root))
      // is '..'. Both must degrade to a safe, deterministic fallback rather
      // than ever reaching the secret store as a literal `.`/`..` segment.
      expect(registeredMcpServerProjectKey(root, root)).not.toBe('.')
      const parentKey = registeredMcpServerProjectKey(join(root, '..'), root)
      expect(parentKey).not.toBe('..')
      expect(parentKey).not.toBe('.')
      rmSync(root, { recursive: true, force: true })
    })
  })
})
