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
  ReservedMcpServerNameError,
} from './registeredMcpServers'
import { setMcpServerSecret, getMcpServerSecret } from '../credentials/mcpServerSecretStore'
import { readStudioMeta } from '../../handlers/studio/studioMeta'

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

  it('lists nothing for a project with no registered servers', () => {
    expect(listRegisteredMcpServers(projectDir)).toEqual([])
  })

  it('adds a stdio server as unapproved, with its secret field names surfaced but no secret value', () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-mcp'],
        secretEnvVarNames: ['FIGMA_TOKEN'],
      },
    })

    const servers = listRegisteredMcpServers(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe('figma')
    expect(servers[0].approved).toBe(false)
    expect(servers[0].secretFieldNames).toEqual(['FIGMA_TOKEN'])
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
    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(false)

    approveRegisteredMcpServer(projectDir, 'github')
    approveRegisteredMcpServer(projectDir, 'github')
    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(true)

    revokeRegisteredMcpServer(projectDir, 'github')
    revokeRegisteredMcpServer(projectDir, 'github')
    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(false)
  })

  it('redefining an existing server name revokes its prior approval', () => {
    addRegisteredMcpServer(projectDir, {
      name: 'github',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    approveRegisteredMcpServer(projectDir, 'github')
    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(true)

    // Same name, different command line — this must not silently inherit trust.
    addRegisteredMcpServer(projectDir, {
      name: 'github',
      definition: { transport: 'http', url: 'https://evil.example.com/mcp' },
    })
    const servers = listRegisteredMcpServers(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].approved).toBe(false)
    expect(servers[0].definition).toMatchObject({ url: 'https://evil.example.com/mcp' })
  })

  it('removeRegisteredMcpServer drops the definition, approval, and stored secrets', async () => {
    const projectKey = registeredMcpServerProjectKey(projectDir)
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['FIGMA_TOKEN'] },
    })
    approveRegisteredMcpServer(projectDir, 'figma')
    await setMcpServerSecret('user-1', projectKey, 'figma', 'FIGMA_TOKEN', 'sk-secret', secretsRoot)

    removeRegisteredMcpServer('user-1', projectDir, 'figma', secretsRoot)

    expect(listRegisteredMcpServers(projectDir)).toEqual([])
    expect(await getMcpServerSecret('user-1', projectKey, 'figma', 'FIGMA_TOKEN', secretsRoot)).toBeNull()
  })

  it('resolvedApprovedRegisteredMcpServers only includes approved servers, with secret env vars decrypted and injected', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-mcp'],
        env: { FIGMA_HOST: 'figma.com' },
        secretEnvVarNames: ['FIGMA_TOKEN'],
      },
    })
    addRegisteredMcpServer(projectDir, {
      name: 'not-approved',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    approveRegisteredMcpServer(projectDir, 'figma')

    const projectKey = registeredMcpServerProjectKey(projectDir)
    await setMcpServerSecret('user-1', projectKey, 'figma', 'FIGMA_TOKEN', 'sk-secret-value', secretsRoot)

    const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)

    expect(Object.keys(resolved)).toEqual(['figma'])
    const figma = resolved.figma as { command: string; env?: Record<string, string> }
    expect(figma.command).toBe('npx')
    expect(figma.env).toMatchObject({ FIGMA_HOST: 'figma.com', FIGMA_TOKEN: 'sk-secret-value' })
  })

  it('resolvedApprovedRegisteredMcpServers drops (never crashes on) a server whose declared secret was never set', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['FIGMA_TOKEN'] },
    })
    approveRegisteredMcpServer(projectDir, 'figma')
    // Secret deliberately never set.

    const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
    expect(resolved).toEqual({})
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
