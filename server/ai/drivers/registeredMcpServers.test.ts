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
    // Was `toEqual([])` before built-in servers existed. Studio now ships
    // `figma` (the desktop app's loopback Dev Mode server) into every
    // project, so "registered nothing" no longer means "sees nothing".
    const listed = listRegisteredMcpServers(projectDir)
    expect(listed.map((s) => s.name)).toEqual(['figma'])
    expect(listed[0]!.definition).toEqual({ transport: 'http', url: 'http://127.0.0.1:3845/mcp' })
    expect(listed[0]!.secretFieldNames).toEqual([])
  })

  describe('built-in servers', () => {
    it('self-approves a loopback, secret-free built-in without any human action', () => {
      // The ONE case where approval is granted without a person: nothing to
      // leak, nowhere off this machine.
      expect(listRegisteredMcpServers(projectDir)[0]!.approved).toBe(true)
    })

    it('lets a project turn a built-in off, and the opt-out beats the built-in', () => {
      mergeStudioMeta(projectDir, { disabledBuiltInMcpServers: ['figma'] })
      expect(listRegisteredMcpServers(projectDir)).toEqual([])
    })

    it('a project\'s own entry of the same name REPLACES the built-in and does NOT inherit its approval', () => {
      // The trap this pins: registering the Figma CLOUD endpoint (which
      // carries a personal access token) under the same name must not
      // silently ride the loopback built-in's self-approval.
      addRegisteredMcpServer(projectDir, {
        name: 'figma',
        definition: {
          transport: 'http',
          url: 'https://mcp.figma.com/mcp',
          secretHeaderNames: ['X-Figma-Token'],
        },
      })
      const listed = listRegisteredMcpServers(projectDir)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.definition).toMatchObject({ url: 'https://mcp.figma.com/mcp' })
      expect(listed[0]!.approved).toBe(false)
      expect(listed[0]!.secretFieldNames).toEqual(['X-Figma-Token'])
    })

    it('resolves an approved built-in into a turn with no headers at all', async () => {
      const resolved = await resolvedApprovedRegisteredMcpServers('user-1', projectDir, secretsRoot)
      expect(resolved.figma).toEqual({ type: 'http', url: 'http://127.0.0.1:3845/mcp' })
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
    expect(Object.keys(resolved)).toEqual(['figma'])
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
