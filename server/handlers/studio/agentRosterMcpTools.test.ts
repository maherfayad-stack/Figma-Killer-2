/**
 * agentRosterMcpTools — the fix for the structural blocker: a subagent can
 * now hold a vetted `mcp__<approved-server>__<tool>` name without throwing,
 * while an unapproved/unknown server name still throws exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertKnownAgentTools,
  mcpServerFingerprintWitness,
  resolveApprovedMcpServerNames,
} from './agentRosterMcpTools'
import type { StudioAgentDef } from './agentRosterTypes'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-roster-mcp-'))
  writeMeta({})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeMcpJson(entries: Record<string, unknown>): void {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: entries }))
}

/** Writes `.studio/meta.json`, always opting out of Studio's auto-approved loopback `figma` built-in — these tests assert on project-declared servers, not on the default. */
function writeMeta(meta: Record<string, unknown>): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(
    join(dir, '.studio', 'meta.json'),
    JSON.stringify({ disabledBuiltInMcpServers: ['figma'], ...meta }),
  )
}

function agentDef(tools: string[]): StudioAgentDef {
  return { name: 'fixture-agent', description: 'fixture', tools, prompt: 'fixture' }
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

describe('assertKnownAgentTools — the structural fix', () => {
  it('still passes through a real native studioAgentTools name unchanged', () => {
    const def = agentDef(['studio_list_pages'])
    expect(assertKnownAgentTools(def, new Set())).toBe(def)
  })

  it('still throws on an unknown native-shaped name (unchanged prior behaviour)', () => {
    const def = agentDef(['studio_this_tool_does_not_exist'])
    expect(() => assertKnownAgentTools(def, new Set())).toThrow(/unknown tool/)
  })

  it('THE FIX: accepts a vetted mcp__<approved-server>__<tool> name', () => {
    const def = agentDef(['mcp__figma__get_image'])
    expect(() => assertKnownAgentTools(def, new Set(['figma']))).not.toThrow()
  })

  it('refuses an mcp__<server>__<tool> name for a server that is NOT approved — "vetted" is tied to real approval, not the mcp__ shape alone', () => {
    const def = agentDef(['mcp__figma__get_image'])
    expect(() => assertKnownAgentTools(def, new Set())).toThrow(/unknown tool/)
    expect(() => assertKnownAgentTools(def, new Set(['some-other-server']))).toThrow(/unknown tool/)
  })

  it('refuses a bare mcp__<server> name with no tool segment, even for an approved server', () => {
    const def = agentDef(['mcp__figma'])
    expect(() => assertKnownAgentTools(def, new Set(['figma']))).toThrow(/unknown tool/)
  })

  it('a mixed tools list (native + vetted mcp__) is accepted as a whole', () => {
    const def = agentDef(['studio_find_component', 'mcp__figma__get_metadata'])
    expect(() => assertKnownAgentTools(def, new Set(['figma']))).not.toThrow()
  })

  it('one bad name in an otherwise-valid list still throws for the whole definition', () => {
    const def = agentDef(['studio_find_component', 'mcp__unapproved__get_metadata'])
    expect(() => assertKnownAgentTools(def, new Set(['figma']))).toThrow(/unknown tool/)
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
