import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BASE = '/admin/api/ai/editor-bridge'

describe('MCP editor bridge handler', () => {
  let harness: CapabilityTestHarness
  // A real project directory: since W10 the bridge is registered under
  // `site:${projectKey}` and the server derives that key from a VALIDATED
  // `dir`, so the request must name a project that actually exists inside the
  // workspace root (the suite's root is the OS temp dir — see
  // `src/__tests__/setup.ts`).
  let projectDir: string
  let query: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    projectDir = mkdtempSync(join(tmpdir(), 'mcp-bridge-project-'))
    query = `scope=site&dir=${encodeURIComponent(projectDir)}`
  })

  afterEach(async () => {
    await harness.cleanup()
    rmSync(projectDir, { recursive: true, force: true })
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

  it('requires a dir naming a real project — never registers a bridge on a guessed one', async () => {
    // A bridge registered under the wrong scope is worse than no bridge: the
    // agent's tool calls would silently reach a different project's editor.
    const { cookie } = await harness.createRoleUser({
      name: 'Site Reader',
      slug: 'mcp-site-reader-dir',
      capabilities: ['site.read'],
    })

    const noDir = await harness.ai(`${BASE}?scope=site`, { cookie })
    expect(noDir.status).toBe(400)

    const outsideWorkspace = await harness.ai(
      `${BASE}?scope=site&dir=${encodeURIComponent('/etc')}`,
      { cookie },
    )
    expect(outsideWorkspace.status).toBe(400)
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

    const deniedSite = await harness.ai(`${BASE}?${query}`, {
      cookie: noAccessUser.cookie,
    })
    expect(deniedSite.status).toBe(403)

    const siteCtrl = new AbortController()
    const siteAllowed = await harness.ai(`${BASE}?${query}`, {
      cookie: siteUser.cookie,
      signal: siteCtrl.signal,
    })
    expect(siteAllowed.status).toBe(200)
    expect(siteAllowed.headers.get('content-type')).toBe('application/x-ndjson')
    siteCtrl.abort()
  })
})
