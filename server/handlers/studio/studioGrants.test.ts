/**
 * `lesserGrants` — after a git verb, each grant is the lesser of what it was
 * before and what it is now (`studioGrants.ts`, rule 2).
 */
import { describe, expect, it } from 'bun:test'
import { lesserGrants } from './studioGrants'

const STDIO = { transport: 'stdio' as const, command: 'mcp-server' }
const SWAPPED = { transport: 'stdio' as const, command: 'node', args: ['-e', 'evil()'] }

describe('lesserGrants', () => {
  it('never lets the tier rise, and reads an absent tier as the default on both sides', () => {
    expect(lesserGrants({ trust: 'static' }, { trust: 'run-project' }).trust).toBe('static')
    expect(lesserGrants({ trust: 'static' }, {}).trust).toBe('static')
    expect(lesserGrants({ trust: 'render-packages' }, { trust: 'run-project' }).trust).toBe('render-packages')
    expect(lesserGrants({}, { trust: 'run-project' }).trust).toBe('run-project')
  })

  it("keeps a lowering made while the verb ran — the owner's, not the repository's", () => {
    expect(lesserGrants({ trust: 'run-project' }, { trust: 'static' }).trust).toBe('static')
    expect(lesserGrants({ approvedMcpServers: ['a', 'b'] }, { approvedMcpServers: ['a'] }).approvedMcpServers).toEqual(['a'])
    expect(lesserGrants({ approvedMcpServers: ['a'] }, {}).approvedMcpServers).toBeUndefined()
  })

  it('drops an approval that was not there before', () => {
    const next = lesserGrants(
      { approvedMcpServers: ['a'], approvedRegisteredMcpServers: [] },
      { approvedMcpServers: ['a', 'evil'], approvedRegisteredMcpServers: ['evil'] },
    )
    expect(next.approvedMcpServers).toEqual(['a'])
    expect(next.approvedRegisteredMcpServers).toEqual([])
  })

  it('drops a registered server whose definition changed under its name, and one that is new', () => {
    const next = lesserGrants(
      { registeredMcpServers: [{ name: 'tools', definition: STDIO }], approvedRegisteredMcpServers: ['tools'] },
      { registeredMcpServers: [{ name: 'tools', definition: SWAPPED }, { name: 'extra', definition: STDIO }], approvedRegisteredMcpServers: ['tools'] },
    )
    expect(next.registeredMcpServers).toEqual([])
    expect(next.approvedRegisteredMcpServers).toEqual(['tools'])
  })

  it('leaves unchanged grants exactly as they were', () => {
    const grants = { trust: 'static' as const, approvedMcpServers: ['a'], registeredMcpServers: [{ name: 'tools', definition: STDIO }], approvedRegisteredMcpServers: ['tools'] }
    expect(lesserGrants(grants, grants)).toEqual(grants)
  })
})
