/**
 * connectorUserUrls — the user's URLs reach a `claude` CLI turn's tool calls
 * through its connector, bound and released with the rest of the turn's
 * registries (P4-E, security review of #233 F8).
 */
import { describe, expect, it } from 'bun:test'
import { getConnectorUserUrls, registerConnectorUserUrls } from './connectorUserUrls'
import { getConnectorWorkspace } from './connectorWorkspace'
import { bindConnectorRegistries } from '../drivers/claudeCliConnector'

describe('connectorUserUrls', () => {
  it('binds and releases', () => {
    const release = registerConnectorUserUrls('c-urls-1', ['https://a.example/x.png'])
    expect(getConnectorUserUrls('c-urls-1')).toEqual(['https://a.example/x.png'])
    release()
    expect(getConnectorUserUrls('c-urls-1')).toBeUndefined()
  })

  it('a stale release does not unbind a newer turn on the same connector', () => {
    const releaseOld = registerConnectorUserUrls('c-urls-2', ['https://old.example/a.png'])
    registerConnectorUserUrls('c-urls-2', ['https://new.example/b.png'])
    releaseOld()
    expect(getConnectorUserUrls('c-urls-2')).toEqual(['https://new.example/b.png'])
  })

  it('bindConnectorRegistries binds the URLs with the workspace, and one release clears both', () => {
    const release = bindConnectorRegistries('c-urls-3', {
      bridge: { callBrowser: async () => ({ ok: true }) } as never,
      workspaceDir: '/w/project',
      userSuppliedUrls: ['https://brand.example/logo.png'],
    })
    expect(getConnectorWorkspace('c-urls-3')).toBe('/w/project')
    expect(getConnectorUserUrls('c-urls-3')).toEqual(['https://brand.example/logo.png'])
    release()
    expect(getConnectorWorkspace('c-urls-3')).toBeUndefined()
    expect(getConnectorUserUrls('c-urls-3')).toBeUndefined()
  })

  it('a turn with no user URLs binds an empty set, not the previous turn\'s', () => {
    registerConnectorUserUrls('c-urls-4', ['https://earlier.example/a.png'])
    const release = bindConnectorRegistries('c-urls-4', {
      bridge: { callBrowser: async () => ({ ok: true }) } as never,
      workspaceDir: undefined,
      userSuppliedUrls: undefined,
    })
    expect(getConnectorUserUrls('c-urls-4')).toEqual([])
    release()
  })
})
