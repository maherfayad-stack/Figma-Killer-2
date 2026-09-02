import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BASE = '/admin/api/ai/editor-bridge'

describe('MCP editor bridge handler', () => {
  let harness: CapabilityTestHarness

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('requires a valid workspace scope from an authenticated user', async () => {
    const { cookie } = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'mcp-site-reader-query',
      capabilities: ['site.read'],
    })

    const missing = await harness.ai(BASE, { cookie })
    expect(missing.status).toBe(400)
    const invalid = await harness.ai(`${BASE}?scope=data`, { cookie })
    expect(invalid.status).toBe(400)
  })

  it('gates the site bridge scope by access to the Site workspace', async () => {
    const siteUser = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'mcp-site-reader',
      capabilities: ['site.read'],
    })
    const noAccessUser = await harness.createRoleUser({
      name: 'No Access',
      slug: 'mcp-no-access',
      capabilities: [],
    })

    // 'content' is no longer a valid bridge scope, regardless of capabilities.
    const contentRejected = await harness.ai(`${BASE}?scope=content`, {
      cookie: siteUser.cookie,
    })
    expect(contentRejected.status).toBe(400)

    const deniedSite = await harness.ai(`${BASE}?scope=site`, {
      cookie: noAccessUser.cookie,
    })
    expect(deniedSite.status).toBe(403)

    const siteCtrl = new AbortController()
    const siteAllowed = await harness.ai(`${BASE}?scope=site`, {
      cookie: siteUser.cookie,
      signal: siteCtrl.signal,
    })
    expect(siteAllowed.status).toBe(200)
    expect(siteAllowed.headers.get('content-type')).toBe('application/x-ndjson')
    siteCtrl.abort()
  })
})
