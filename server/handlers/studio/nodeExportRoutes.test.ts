/**
 * `/admin/api/studio/node-png` + `/admin/api/studio/node-jsx` — the Export
 * section's server surface (W8-4).
 *
 * Two properties are gated here. First, both routes own their paths and
 * nothing else, so they can sit in `tryServeStudio` without shadowing a
 * sibling. Second, both REQUIRE a session before anything else happens: the
 * PNG path drives a capture on behalf of a user, and the JSX path hands back
 * the contents of a file in the user's repository. An unauthenticated caller
 * must not reach either.
 *
 * The db is a throwing stub — with no session cookie the auth path
 * short-circuits before it queries, so a test that reaches the database has
 * already failed the thing it is testing.
 *
 * The body contract is asserted against the exported schemas directly. Going
 * through the route would mean minting a real session first, which tests the
 * auth stack rather than the shape.
 */
import { describe, expect, it } from 'bun:test'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { NodeJsxBodySchema, NodePngBodySchema, tryServeStudioNodeExport } from './nodeExportRoutes'

const PNG_ROUTE = '/admin/api/studio/node-png'
const JSX_ROUTE = '/admin/api/studio/node-jsx'

const db = (() => {
  throw new Error('an unauthenticated export request must never reach the database')
}) as unknown as DbClient

function call(pathname: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://localhost${pathname}`)
  return tryServeStudioNodeExport(new Request(url, init), { db }, url, url.pathname)
}

describe('tryServeStudioNodeExport — routing and auth', () => {
  it('ignores a path it does not own', async () => {
    expect(await call('/admin/api/studio/comments', { method: 'POST', body: '{}' })).toBeNull()
    expect(await call('/admin/api/studio/node-png/extra', { method: 'POST', body: '{}' })).toBeNull()
    expect(await call('/admin/api/studio/node', { method: 'POST', body: '{}' })).toBeNull()
  })

  it('ignores non-POST verbs on the paths it owns', async () => {
    expect(await call(PNG_ROUTE)).toBeNull()
    expect(await call(JSX_ROUTE, { method: 'DELETE' })).toBeNull()
  })

  it('requires a session before it looks at the body', async () => {
    for (const route of [PNG_ROUTE, JSX_ROUTE]) {
      const res = await call(route, { method: 'POST', body: '{}' })
      expect(res?.status).toBe(401)
    }
  })
})

describe('node-png body contract', () => {
  it('accepts a well-formed body, with dir optional', () => {
    expect(safeParseValue(NodePngBodySchema, { pageId: 'pages/Home.tsx', nodeId: 'pages/Home.tsx:4:2', scale: 2 }).ok).toBe(true)
    expect(
      safeParseValue(NodePngBodySchema, { dir: '/w/proj', pageId: 'p', nodeId: 'n', scale: 1 }).ok,
    ).toBe(true)
  })

  it('rejects a density the section does not offer', () => {
    // The `+` menu offers @1×/@2×/@3× and nothing else, so 4× (or 0, or 2.5)
    // is a malformed request rather than a value to silently clamp.
    for (const scale of [0, 2.5, 4, -1, '2']) {
      expect(safeParseValue(NodePngBodySchema, { pageId: 'p', nodeId: 'n', scale }).ok).toBe(false)
    }
  })

  it('rejects a missing or empty page/node id', () => {
    expect(safeParseValue(NodePngBodySchema, { nodeId: 'n', scale: 1 }).ok).toBe(false)
    // `nodeId` is OPTIONAL — omitted means "the whole frame", the
    // nothing-selected half of Copy as PNG. Present-but-empty is still a
    // malformed request.
    expect(safeParseValue(NodePngBodySchema, { pageId: 'p', scale: 1 }).ok).toBe(true)
    expect(safeParseValue(NodePngBodySchema, { pageId: '', nodeId: 'n', scale: 1 }).ok).toBe(false)
    expect(safeParseValue(NodePngBodySchema, { pageId: 'p', nodeId: '', scale: 1 }).ok).toBe(false)
  })
})

describe('node-jsx body contract', () => {
  it('accepts a node id, with dir optional', () => {
    expect(safeParseValue(NodeJsxBodySchema, { nodeId: 'pages/Home.tsx:4:2' }).ok).toBe(true)
    expect(safeParseValue(NodeJsxBodySchema, { dir: '/w/proj', nodeId: 'n' }).ok).toBe(true)
  })

  it('rejects a missing or empty node id', () => {
    expect(safeParseValue(NodeJsxBodySchema, {}).ok).toBe(false)
    expect(safeParseValue(NodeJsxBodySchema, { nodeId: '' }).ok).toBe(false)
  })
})
