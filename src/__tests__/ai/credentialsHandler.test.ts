import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

describe('AI credential handler', () => {
  let harness: CapabilityTestHarness
  let originalFetch: typeof globalThis.fetch
  let originalWarn: typeof console.warn
  let originalError: typeof console.error
  let originalNodeEnv: string | undefined
  let originalSecretKey: string | undefined

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    originalWarn = console.warn
    originalError = console.error
    originalNodeEnv = process.env.NODE_ENV
    originalSecretKey = process.env.STUDIO_SECRET_KEY
    __resetMasterKeyCacheForTesting()
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

      if (url === 'https://api.openai.com/v1/models') {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4.1' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return originalFetch(input, init)
    }

    harness = await createCapabilityTestHarness()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    console.error = originalError
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalSecretKey === undefined) {
      delete process.env.STUDIO_SECRET_KEY
    } else {
      process.env.STUDIO_SECRET_KEY = originalSecretKey
    }
    __resetMasterKeyCacheForTesting()
    await harness.cleanup()
  })

  it('creates the credential when auto-default seeding fails', async () => {
    const cookie = await harness.setupOwner()
    await harness.db.unsafe(`
      create trigger fail_ai_default_insert
      before insert on ai_defaults
      begin
        select raise(abort, 'default write failed');
      end;
    `)

    console.warn = () => {}
    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey: 'sk-proj-test',
      },
    })
    console.warn = originalWarn

    expect(res.status).toBe(201)
    const body = await readJson<{ credential: { providerId: string; displayLabel: string } }>(res)
    expect(body.credential).toMatchObject({
      providerId: 'openai',
      displayLabel: 'OpenAI',
    })

    const { rows } = await harness.db<{ count: number }>`
      select count(*) as count
      from ai_provider_credentials
      where provider_id = 'openai'
    `
    expect(rows[0]?.count).toBe(1)
  })

  it('does not auto-default an offline Ollama credential from fallback models', async () => {
    const cookie = await harness.setupOwner()
    const warnings: string[] = []
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '))
    }
    console.error = () => {}
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'http://127.0.0.1:1/api/tags') {
        throw new Error('ollama offline')
      }
      return originalFetch(input)
    }

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'ollama',
        authMode: 'baseUrl',
        displayLabel: 'Local Ollama',
        baseUrl: 'http://127.0.0.1:1',
      },
    })

    expect(res.status).toBe(201)
    const { rows } = await harness.db<{ count: number }>`
      select count(*) as count
      from ai_defaults
    `
    expect(rows[0]?.count).toBe(0)
    expect(warnings.join('\n')).toContain('auto-default skipped')
  })

  it('redacts API keys from auto-default model lookup warnings', async () => {
    const cookie = await harness.setupOwner()
    const apiKey = 'sk-proj-redaction-test'
    const warnings: string[] = []
    console.warn = (...args) => {
      warnings.push(args.map(String).join(' '))
    }
    globalThis.fetch = async () => {
      throw new Error(`model lookup failed with ${apiKey}`)
    }

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey,
      },
    })

    expect(res.status).toBe(201)
    expect(warnings.join('\n')).not.toContain(apiKey)
    expect(warnings.join('\n')).toContain('[redacted]')
  })

  it('surfaces a clear production error when the credential encryption key is missing', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.STUDIO_SECRET_KEY
    __resetMasterKeyCacheForTesting()

    const cookie = await harness.setupOwner()

    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey: 'sk-proj-test',
      },
    })

    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('STUDIO_SECRET_KEY')
    expect(body.error).not.toContain('sk-proj-test')
  })

  it('redacts API keys from credential test failures', async () => {
    const cookie = await harness.setupOwner()
    const apiKey = 'sk-proj-test-endpoint-redaction'
    const createRes = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai',
        authMode: 'apiKey',
        displayLabel: 'OpenAI',
        apiKey,
      },
    })
    const createBody = await readJson<{ credential: { id: string } }>(createRes)
    globalThis.fetch = async () => {
      throw new Error(`provider echoed ${apiKey}`)
    }

    const testRes = await harness.ai(`/admin/api/ai/credentials/${createBody.credential.id}/test`, {
      method: 'POST',
      cookie,
    })

    expect(testRes.status).toBe(200)
    const body = await readJson<{ ok: boolean; error: string }>(testRes)
    expect(body.ok).toBe(false)
    expect(body.error).not.toContain(apiKey)
    expect(body.error).toContain('[redacted]')
  })

  it('reports a failed credential test when the provider returns no live models', async () => {
    const cookie = await harness.setupOwner()
    console.warn = () => {}
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (url === 'https://bad.example/v1/models') {
        return new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })
      }
      return originalFetch(input)
    }

    const createRes = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'openai-compatible',
        authMode: 'baseUrl',
        displayLabel: 'Custom',
        baseUrl: 'https://bad.example/v1',
        apiKey: 'sk-custom-test',
      },
    })
    expect(createRes.status).toBe(201)
    const createBody = await readJson<{ credential: { id: string } }>(createRes)

    const testRes = await harness.ai(`/admin/api/ai/credentials/${createBody.credential.id}/test`, {
      method: 'POST',
      cookie,
    })

    expect(testRes.status).toBe(200)
    const body = await readJson<{ ok: boolean; error: string; modelCount?: number }>(testRes)
    expect(body.ok).toBe(false)
    expect(body.modelCount).toBeUndefined()
    expect(body.error).toContain('No live models were returned')
  })

  it('accepts a claudeCli credential (the L2 setup-token path, WS-11 §3 P1) with no schema change', async () => {
    const cookie = await harness.setupOwner()
    console.warn = () => {}
    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'claudeCli',
        authMode: 'apiKey',
        displayLabel: 'My Claude subscription',
        apiKey: 'sk-ant-oat01-test-setup-token',
      },
    })
    console.warn = originalWarn

    expect(res.status).toBe(201)
    const body = await readJson<{ credential: { providerId: string; authMode: string; expiresAt: string | null; createdAt: string } }>(res)
    expect(body.credential.providerId).toBe('claudeCli')
    expect(body.credential.authMode).toBe('apiKey')

    // WS-11 §2.1: a `claude setup-token` value is inference-only and does not
    // refresh — Studio must surface its one-year expiry rather than discover
    // it later. Computed from createdAt, no new DB column.
    expect(body.credential.expiresAt).not.toBeNull()
    const created = new Date(body.credential.createdAt)
    const expires = new Date(body.credential.expiresAt!)
    const oneYearLater = new Date(created)
    oneYearLater.setUTCFullYear(oneYearLater.getUTCFullYear() + 1)
    expect(expires.toISOString()).toBe(oneYearLater.toISOString())
  })

  it('rejects an empty apiKey for every apiKey-mode provider, claudeCli included — L1 stores no row at all (WS-11 §3 P2)', async () => {
    const cookie = await harness.setupOwner()
    for (const providerId of ['anthropic', 'claudeCli'] as const) {
      const res = await harness.ai('/admin/api/ai/credentials', {
        method: 'POST',
        cookie,
        json: {
          providerId,
          authMode: 'apiKey',
          displayLabel: `${providerId} empty key`,
          apiKey: '',
        },
      })

      // Rejected at the TypeBox boundary (`apiKey: Type.String({ minLength: 1
      // })`) before ever reaching `createCredentialForUser` — `claudeCli` gets
      // no schema exception, unlike a stored credential row for it.
      expect(res.status).toBe(400)
    }
  })

  it('reports expiresAt: null for every non-claudeCli credential', async () => {
    const cookie = await harness.setupOwner()
    console.warn = () => {}
    const res = await harness.ai('/admin/api/ai/credentials', {
      method: 'POST',
      cookie,
      json: {
        providerId: 'anthropic',
        authMode: 'apiKey',
        displayLabel: 'Anthropic',
        apiKey: 'sk-ant-test',
      },
    })
    console.warn = originalWarn

    expect(res.status).toBe(201)
    const body = await readJson<{ credential: { expiresAt: string | null } }>(res)
    expect(body.credential.expiresAt).toBeNull()
  })
})
