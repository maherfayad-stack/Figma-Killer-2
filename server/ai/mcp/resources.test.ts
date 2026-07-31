import { describe, expect, it } from 'bun:test'
import { MCP_RESOURCES, findMcpResource } from './resources'

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
})
