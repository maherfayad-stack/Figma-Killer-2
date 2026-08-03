/**
 * Proves the agent-facing MCP-server tool boundary: `mcp_propose_server` can
 * register a definition but can NEVER approve it, enable it, or supply a
 * secret value — that is a human-only action taken in the Settings UI. See
 * `mcpServerTool.ts`'s own doc comment for why this boundary exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpServerMcpTools } from './mcpServerTool'
import { listRegisteredMcpServers, approveRegisteredMcpServer } from '../../drivers/registeredMcpServers'
import { readStudioMeta } from '../../../handlers/studio/studioMeta'
import type { ToolContext } from '../../runtime/types'

function tool(name: string) {
  const t = mcpServerMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

const fakeCtx = {} as ToolContext

describe('mcp_propose_server — hard consent boundary', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'mcp-propose-tool-'))
    // Opt out of Studio's auto-approved loopback `figma` built-in: these
    // tests are about the consent boundary for USER/AGENT-proposed servers,
    // and the built-in would otherwise appear in every listing.
    mkdirSync(join(projectDir, '.studio'), { recursive: true })
    writeFileSync(join(projectDir, '.studio', 'meta.json'), JSON.stringify({ disabledBuiltInMcpServers: ['figma'] }))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('is declared mutating and gated by studio.write — never reachable without it', () => {
    const propose = tool('mcp_propose_server')
    expect(propose.mutates).toBe(true)
    expect(propose.requiredCapabilities).toEqual(['studio.write'])
  })

  it('registers the definition as UNAPPROVED', async () => {
    const propose = tool('mcp_propose_server')
    const result = await propose.handler?.(
      {
        dir: projectDir,
        name: 'figma',
        definition: { transport: 'stdio', command: 'npx', args: ['-y', 'figma-mcp'], secretEnvVarNames: ['FIGMA_TOKEN'] },
      },
      fakeCtx,
    ) as { ok: boolean; approved: boolean }

    expect(result.ok).toBe(true)
    expect(result.approved).toBe(false)

    const servers = listRegisteredMcpServers(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].approved).toBe(false)
  })

  it('a crafted input carrying an "approved" or "secretValue"-shaped extra field has ZERO effect — the tool has no code path that reads them', async () => {
    const propose = tool('mcp_propose_server')
    // The TypeBox input schema has `additionalProperties: false`, but this
    // test proves the boundary at the DATA layer too — even if a caller
    // somehow got extra keys through, the handler destructures only
    // `dir`/`name`/`definition` and forwards only those three onward.
    const maliciousInput = {
      dir: projectDir,
      name: 'evil',
      definition: { transport: 'stdio', command: 'npx' },
      approved: true,
      secretValue: 'sk-should-never-be-stored',
      secretEnvVarValues: { TOKEN: 'sk-should-never-be-stored' },
    }

    await propose.handler?.(maliciousInput, fakeCtx)

    const servers = listRegisteredMcpServers(projectDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].approved).toBe(false)

    // Nothing resembling the "secret" ever landed in .studio/meta.json.
    const metaRaw = JSON.stringify(readStudioMeta(projectDir))
    expect(metaRaw).not.toContain('sk-should-never-be-stored')
  })

  it('refuses the reserved name "studio"', async () => {
    const propose = tool('mcp_propose_server')
    const result = await propose.handler?.(
      { dir: projectDir, name: 'studio', definition: { transport: 'http', url: 'https://example.com/mcp' } },
      fakeCtx,
    ) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(listRegisteredMcpServers(projectDir)).toEqual([])
  })

  it('proposing again after a human approval revokes that approval — the tool cannot preserve trust across a redefinition either', async () => {
    const propose = tool('mcp_propose_server')
    await propose.handler?.(
      { dir: projectDir, name: 'figma', definition: { transport: 'stdio', command: 'npx' } },
      fakeCtx,
    )
    approveRegisteredMcpServer(projectDir, 'figma')
    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(true)

    // The agent proposes an "update" to the same name.
    await propose.handler?.(
      { dir: projectDir, name: 'figma', definition: { transport: 'stdio', command: 'npx', args: ['--different'] } },
      fakeCtx,
    )

    expect(listRegisteredMcpServers(projectDir)[0].approved).toBe(false)
  })

  it('this file never IMPORTS an approve/revoke/secret-setting symbol — a structural guarantee, not just a behavioural one', () => {
    const source = readFileSync(join(import.meta.dir, 'mcpServerTool.ts'), 'utf8')
    // Scan only `import { ... } from '...'` statements (not the doc comment,
    // which deliberately NAMES these functions in prose to explain the
    // boundary) — the real guarantee is that none of them is ever bound as a
    // usable symbol in this module. Imports may span multiple lines, so match
    // each whole `import ... from '...'` block rather than single lines.
    const importedSymbols = (source.match(/^import\b[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? []).join('\n')
    for (const forbidden of ['approveRegisteredMcpServer', 'revokeRegisteredMcpServer', 'approveProjectMcpServer', 'setMcpServerSecret', 'mcpServerSecretStore']) {
      expect(importedSymbols).not.toContain(forbidden)
    }
  })
})

describe('mcp_list_project_servers', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'mcp-list-tool-'))
    // Opt out of Studio's auto-approved loopback `figma` built-in: these
    // tests are about the consent boundary for USER/AGENT-proposed servers,
    // and the built-in would otherwise appear in every listing.
    mkdirSync(join(projectDir, '.studio'), { recursive: true })
    writeFileSync(join(projectDir, '.studio', 'meta.json'), JSON.stringify({ disabledBuiltInMcpServers: ['figma'] }))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('has no requiredCapabilities — reachable by any ai.chat caller', () => {
    expect(tool('mcp_list_project_servers').requiredCapabilities).toBeUndefined()
  })

  it('lists a registered server with its secret field NAMES but never a value', async () => {
    const propose = tool('mcp_propose_server')
    await propose.handler?.(
      {
        dir: projectDir,
        name: 'figma',
        definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['FIGMA_TOKEN'] },
      },
      fakeCtx,
    )

    const list = tool('mcp_list_project_servers')
    const result = await list.handler?.({ dir: projectDir }, fakeCtx) as {
      servers: Array<{ name: string; source: string; approved: boolean; secretFieldNames?: string[] }>
    }

    expect(result.servers).toHaveLength(1)
    expect(result.servers[0]).toMatchObject({ name: 'figma', source: 'registered', approved: false, secretFieldNames: ['FIGMA_TOKEN'] })
  })
})
