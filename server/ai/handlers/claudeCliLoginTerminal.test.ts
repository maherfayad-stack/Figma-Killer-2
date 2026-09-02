/**
 * POST /admin/api/ai/providers/claude-cli/login-terminal — HTTP wiring only.
 * The actual OS-level launch mechanics are `claudeCliTerminalLaunch.test.ts`'s
 * job; this file proves the route rejects the right things (method, auth,
 * non-loopback, unsupported platform) and passes through the launch result.
 *
 * Calls `tryHandleAiClaudeCliLoginTerminal` directly (not through
 * `tryHandleAi`'s CSRF/origin dispatch) so each request can be individually
 * stamped with a socket peer via `stampSocketIp` — never spawns anything real.
 */
import { describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import { stampSocketIp } from '../../auth/security'
import { tryHandleAiClaudeCliLoginTerminal } from './claudeCliLoginTerminal'

const PATH = '/admin/api/ai/providers/claude-cli/login-terminal'

async function ownerCookie(harness: CapabilityTestHarness): Promise<string> {
  return harness.setupOwner()
}

function buildLoginRequest(cookie: string, ip: string | null): Request {
  const req = new Request(`http://localhost${PATH}`, { method: 'POST' })
  // `Cookie` is a Fetch-spec "forbidden header name" — happy-dom (this test
  // env) silently strips it when set via the constructor's `headers` init,
  // so it's set directly on the Headers object afterward instead (mirrors
  // `security.test.ts`'s own `makeReq` helper and its doc comment).
  if (cookie) req.headers.set('cookie', cookie)
  if (ip) stampSocketIp(req, ip)
  return req
}

describe('POST /admin/api/ai/providers/claude-cli/login-terminal', () => {
  it('404s (returns null) for a non-matching path', async () => {
    const harness = await createCapabilityTestHarness()
    const req = new Request('http://localhost/admin/api/ai/providers/claude-cli/status')
    expect(tryHandleAiClaudeCliLoginTerminal(req, harness.db, '/admin/api/ai/providers/claude-cli/status')).toBeNull()
    await harness.cleanup()
  })

  it('405s on GET', async () => {
    const harness = await createCapabilityTestHarness()
    const cookie = await ownerCookie(harness)
    const req = new Request(`http://localhost${PATH}`, { method: 'GET', headers: { cookie } })
    const res = await tryHandleAiClaudeCliLoginTerminal(req, harness.db, PATH)!
    expect(res.status).toBe(405)
    await harness.cleanup()
  })

  it('401s with no session', async () => {
    const harness = await createCapabilityTestHarness()
    const req = buildLoginRequest('', '127.0.0.1')
    const res = await tryHandleAiClaudeCliLoginTerminal(req, harness.db, PATH)!
    expect(res.status).toBe(401)
    await harness.cleanup()
  })

  it('403s for a user without ai.providers.manage', async () => {
    const harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const { cookie } = await harness.createRoleUser({
      name: 'No AI access',
      slug: 'no-ai-access',
      capabilities: [],
    })
    const req = buildLoginRequest(cookie, '127.0.0.1')
    const res = await tryHandleAiClaudeCliLoginTerminal(req, harness.db, PATH)!
    expect(res.status).toBe(403)
    await harness.cleanup()
  })

  it('returns 200 { ok: false, reason } for a non-loopback caller — never attempts a launch', async () => {
    const harness = await createCapabilityTestHarness()
    const cookie = await ownerCookie(harness)
    const req = buildLoginRequest(cookie, '203.0.113.7')
    const res = await tryHandleAiClaudeCliLoginTerminal(req, harness.db, PATH)!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('remote')
    await harness.cleanup()
  })

  it('returns 200 { ok: false, reason } when no socket peer was ever stamped (treated as non-loopback)', async () => {
    const harness = await createCapabilityTestHarness()
    const cookie = await ownerCookie(harness)
    const req = buildLoginRequest(cookie, null)
    const res = await tryHandleAiClaudeCliLoginTerminal(req, harness.db, PATH)!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    await harness.cleanup()
  })
})

// A `terminalLogin`-merge test for `GET .../status` deliberately does NOT
// live here: `handleStatus` (`claudeCliStatus.ts`) has no injectable spawn
// seam, so exercising it end-to-end would call the REAL `probeClaudeCliAuth`
// — a genuine `Bun.spawn(['claude', 'auth', 'status', ...])` — which is
// exactly the "never spawn the real `claude` binary" constraint tests here
// must not violate, regardless of whether the binary happens to be
// installed (and logged in) on the machine running the suite. The merge
// itself (`{ ...classification, terminalLogin }` on all three return paths
// in `handleStatus`) is a direct code-review concern, not something worth
// risking a real subprocess call to cover.
