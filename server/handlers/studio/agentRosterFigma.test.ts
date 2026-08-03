/**
 * agentRosterFigma — detection heuristic, the `figma.md` reference content,
 * and the `figma-asset-scout` subagent definition itself (unit-level; the
 * end-to-end "does generateStudioAgentRoster actually WRITE these files"
 * behaviour is covered in `agentRoster.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findApprovedFigmaServer, figmaAssetScoutAgent, figmaReference } from './agentRosterFigma'
import type { StudioAgentDef } from './agentRosterTypes'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-roster-figma-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeMcpJson(entries: Record<string, unknown>): void {
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: entries }))
}

function writeMeta(meta: Record<string, unknown>): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify(meta))
}

describe('findApprovedFigmaServer', () => {
  it('finds nothing when there is no MCP config at all', () => {
    expect(findApprovedFigmaServer(dir)).toBeUndefined()
  })

  it('finds nothing for a Figma server that is declared but NOT approved', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    expect(findApprovedFigmaServer(dir)).toBeUndefined()
  })

  it('finds an approved server by NAME match', () => {
    writeMcpJson({ figma: { command: 'npx', args: ['figma-mcp'] } })
    writeMeta({ approvedMcpServers: ['figma'] })
    expect(findApprovedFigmaServer(dir)).toEqual({ name: 'figma' })
  })

  it('finds an approved server by SUMMARY match even with a non-obvious name', () => {
    writeMcpJson({ 'design-bridge': { type: 'http', url: 'https://figma-mcp.example.com/mcp' } })
    writeMeta({ approvedMcpServers: ['design-bridge'] })
    expect(findApprovedFigmaServer(dir)).toEqual({ name: 'design-bridge' })
  })

  it('does not match an unrelated approved server', () => {
    writeMcpJson({ 'design-system-docs': { command: 'design-system-mcp' } })
    writeMeta({ approvedMcpServers: ['design-system-docs'] })
    expect(findApprovedFigmaServer(dir)).toBeUndefined()
  })

  it('finds an approved Studio-REGISTERED Figma server too', () => {
    writeMeta({
      registeredMcpServers: [
        { name: 'figma-tokens', definition: { transport: 'http', url: 'https://api.figma.com/mcp' } },
      ],
      approvedRegisteredMcpServers: ['figma-tokens'],
    })
    expect(findApprovedFigmaServer(dir)).toEqual({ name: 'figma-tokens' })
  })
})

describe('figmaReference', () => {
  it('names the connected server and teaches the real per-component-key workflow', () => {
    const md = figmaReference('figma')
    expect(md).toContain('"figma"')
    expect(md).toContain('studio_list_component_bindings')
    expect(md).toContain('nodeIdPlaceholder')
    expect(md).toContain('studio_fetch_remote_asset')
    // Never one hardcoded file key — the guidance must be per-component.
    expect(md.toLowerCase()).toContain('never assume one')
  })

  it('tells the agent to land assets without hand-carrying bytes, not to use studio_upload_asset as the default path', () => {
    const md = figmaReference('figma')
    expect(md).toContain('WITHOUT routing bytes through yourself')
  })
})

describe('figmaAssetScoutAgent', () => {
  function identity(def: StudioAgentDef): StudioAgentDef {
    return def
  }

  it('grants exactly the narrow tool set: read + Studio catalog/land tools, no structural tool', () => {
    const def = figmaAssetScoutAgent('figma', identity)
    expect(def.name).toBe('figma-asset-scout')
    expect(def.tools).toContain('studio_read_file')
    expect(def.tools).toContain('studio_list_component_bindings')
    expect(def.tools).toContain('studio_fetch_remote_asset')
    expect(def.tools).toContain('mcp__figma__get_metadata')
    expect(def.tools).toContain('mcp__figma__get_image')
    // Never a structural/composition tool — locate, pull, land is the whole remit.
    expect(def.tools).not.toContain('studio_apply_edits')
    expect(def.tools).not.toContain('studio_create_page')
  })

  it('every mcp__ grant is namespaced under the ACTUAL approved server name passed in, never a hardcoded one', () => {
    const def = figmaAssetScoutAgent('a-totally-different-server-name', identity)
    for (const tool of def.tools) {
      if (tool.startsWith('mcp__')) {
        expect(tool.startsWith('mcp__a-totally-different-server-name__')).toBe(true)
      }
    }
  })

  it('passes itself through the caller-supplied assertKnown gate', () => {
    let received: StudioAgentDef | null = null
    figmaAssetScoutAgent('figma', (def) => {
      received = def
      return def
    })
    expect(received).not.toBeNull()
    expect(received!.name).toBe('figma-asset-scout')
  })

  it('the prompt tells the agent to verify the mcp__ tools actually exist before relying on them', () => {
    const def = figmaAssetScoutAgent('figma', identity)
    expect(def.prompt).toContain('not actually in your available tool list')
  })
})
