import { describe, expect, it } from 'bun:test'
import { MCP_RESOURCES, findMcpResource } from './resources'
import { mcpToolsForCapabilities } from './registry'
import { CORE_CAPABILITIES } from '@core/capabilities'

describe('MCP resources', () => {
  it('exposes studio://guidelines', () => {
    const resource = findMcpResource('studio://guidelines')
    expect(resource).toBeDefined()
    expect(resource!.mimeType).toBe('text/markdown')
    expect(resource!.text).toContain('DYNAMIC_CONTENT_UNRESOLVED')
    expect(resource!.text).toContain('module-scope')
  })

  it('returns undefined for an unknown uri', () => {
    expect(findMcpResource('studio://nope')).toBeUndefined()
  })

  it('every resource has a non-empty uri/name/description/text', () => {
    for (const r of MCP_RESOURCES) {
      expect(r.uri.length).toBeGreaterThan(0)
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.description.length).toBeGreaterThan(0)
      expect(r.text.length).toBeGreaterThan(0)
    }
  })

  it('studio://tool-notes has a section for every tool whose description points at it (AI-29)', () => {
    const notes = findMcpResource('studio://tool-notes')
    expect(notes).toBeDefined()
    const pointing = mcpToolsForCapabilities([...CORE_CAPABILITIES]).filter((tool) => tool.description.includes('studio://tool-notes'))
    expect(pointing.map((tool) => tool.name).sort()).toEqual(['studio_apply_edits', 'studio_export_frames'])
    for (const tool of pointing) expect(notes!.text, tool.name).toContain(`## ${tool.name}`)
  })
})
