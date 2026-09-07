/**
 * projectMcpApprovals — which external MCP servers a project has actually
 * approved, and the fingerprint witness of that fact.
 *
 * These two functions used to live in `agentRosterMcpTools.ts` alongside
 * `assertKnownAgentTools`, the gate over a generated subagent roster's
 * `tools:` frontmatter. The roster is gone (`projectMcpApprovals.ts`'s own
 * doc says why), and so is that gate and the module that held it — the
 * approval reads survived into `./projectMcpApprovals`, which is what this
 * file exercises.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpServerFingerprintWitness, resolveApprovedMcpServerNames } from './projectMcpApprovals'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-project-mcp-'))
  writeMeta({})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeMcpJson(entries: Record<string, unknown>): void {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: entries }))
}

/**
 * Writes `.studio/meta.json`, always opting the project out of the shipped
 * `figma` built-in so these tests assert on project-declared servers only.
 * The built-in is the REMOTE endpoint now (`BUILT_IN_MCP_SERVERS`), which does
 * not self-approve — but it is still LISTED, so it would otherwise show up in
 * `mcpServerFingerprintWitness`'s string and couple these assertions to the
 * shipped list.
 */
function writeMeta(meta: Record<string, unknown>): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(
    join(dir, '.studio', 'meta.json'),
    JSON.stringify({ disabledBuiltInMcpServers: ['figma'], ...meta }),
  )
}

describe('resolveApprovedMcpServerNames', () => {
  it('is empty for a project with no .mcp.json at all', () => {
    expect(resolveApprovedMcpServerNames(dir)).toEqual(new Set())
  })

  it('excludes a declared-but-unapproved server', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    expect(resolveApprovedMcpServerNames(dir)).toEqual(new Set())
  })

  it('includes a project-declared server once approved in .studio/meta.json', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    writeMeta({ approvedMcpServers: ['figma'] })
    expect(resolveApprovedMcpServerNames(dir)).toEqual(new Set(['figma']))
  })

  it('includes an approved Studio-registered server too, merged with project-declared ones', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    writeMeta({
      approvedMcpServers: ['figma'],
      registeredMcpServers: [
        { name: 'internal-tools', definition: { transport: 'http', url: 'https://example.com/mcp' } },
      ],
      approvedRegisteredMcpServers: ['internal-tools'],
    })
    expect(resolveApprovedMcpServerNames(dir)).toEqual(new Set(['figma', 'internal-tools']))
  })

  it('never includes the reserved "studio" name even if a project tries to declare it', () => {
    writeMcpJson({ studio: { command: 'evil', args: [] } })
    writeMeta({ approvedMcpServers: ['studio'] })
    expect(resolveApprovedMcpServerNames(dir)).toEqual(new Set())
  })
})

describe('mcpServerFingerprintWitness', () => {
  it('changes when a server is newly approved, so the roster fingerprint gate cannot silently skip regeneration', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    const before = mcpServerFingerprintWitness(dir)
    writeMeta({ approvedMcpServers: ['figma'] })
    const after = mcpServerFingerprintWitness(dir)
    expect(after).not.toBe(before)
  })

  it('never includes a secret value — only name/approved/summary', () => {
    writeMeta({
      registeredMcpServers: [
        {
          name: 'secret-server',
          definition: { transport: 'http', url: 'https://example.com/mcp', secretHeaderNames: ['Authorization'] },
        },
      ],
      approvedRegisteredMcpServers: ['secret-server'],
    })
    const witness = mcpServerFingerprintWitness(dir)
    expect(witness).not.toContain('Bearer')
    // The secret VALUE is never stored in .studio/meta.json at all (it lives
    // in the encrypted secret store) — this witness only ever sees what
    // listRegisteredMcpServers itself returns, which is the field NAME, not
    // a value.
    expect(witness).toContain('secret-server')
  })
})
