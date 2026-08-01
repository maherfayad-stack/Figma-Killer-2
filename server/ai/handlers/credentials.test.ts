/**
 * `verifyCredentialOrCountModels` — the "how do we prove this credential
 * works" dispatch `dispatchTest` (POST /admin/api/ai/credentials/:id/test)
 * uses. Exercised against a fake `AiProvider`, never a real driver or a real
 * `claude` subprocess — see `docs/features/agent.md`'s note on why a
 * `claudeCli`-through-the-real-driver test isn't the way to cover this.
 *
 * Regression: a provider whose ENTIRE catalogue is `'fallback'` (exactly
 * `claudeCli`'s shape — WS-11 §4 has no API key to call `/v1/models` with)
 * must still test OK when its own `verifyCredential` succeeds. Before this
 * dispatch existed, the handler counted live catalogue entries
 * unconditionally, so a fallback-only provider failed the test for every
 * credential, valid or not, and blamed a "provider endpoint" it doesn't have.
 */
import { describe, expect, it } from 'bun:test'
import { secretShapeError, verifyCredentialOrCountModels } from './credentials'
import { CredentialError } from '../credentials/store'
import type { AiProvider, AiProviderModel, AiResolvedCredential } from '../drivers/types'

const RESOLVED: AiResolvedCredential = {
  id: 'cred-1',
  providerId: 'claudeCli',
  authMode: 'apiKey',
  apiKey: 'sk-ant-oat01-test',
  baseUrl: null,
}

const FALLBACK_ONLY_MODELS: AiProviderModel[] = [
  {
    id: 'sonnet',
    label: 'Claude Sonnet',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: true, toolResultImages: false, promptCache: false, streaming: true },
  },
]

const LIVE_MODELS: AiProviderModel[] = [
  {
    id: 'gpt-x',
    label: 'GPT-X',
    catalogueSource: 'live',
    capabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
  },
]

function fakeProvider(overrides: Partial<AiProvider>): AiProvider {
  return {
    id: 'claudeCli',
    label: 'Fake Provider',
    supportedAuthModes: ['apiKey'],
    capabilities: () => ({ toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true }),
    listModels: async () => [],
    stream: async function* () {},
    ...overrides,
  }
}

describe('verifyCredentialOrCountModels', () => {
  it('regression: a fallback-only catalogue still tests OK when the driver\'s own verifyCredential succeeds', async () => {
    const driver = fakeProvider({
      listModels: async () => FALLBACK_ONLY_MODELS,
      verifyCredential: async () => {
        /* resolves — the credential is good */
      },
    })
    const modelCount = await verifyCredentialOrCountModels(driver, RESOLVED, undefined)
    // No catalogue count to report — the driver's own check is what proved it.
    expect(modelCount).toBeUndefined()
  })

  it('propagates a rejected verifyCredential as the failure, never falling back to counting models', async () => {
    const driver = fakeProvider({
      listModels: async () => FALLBACK_ONLY_MODELS,
      verifyCredential: async () => {
        throw new Error('This token did not authenticate.')
      },
    })
    await expect(verifyCredentialOrCountModels(driver, RESOLVED, undefined)).rejects.toThrow(
      'This token did not authenticate.',
    )
  })

  it('falls back to counting live models when the driver has no verifyCredential', async () => {
    const driver = fakeProvider({ listModels: async () => LIVE_MODELS })
    const modelCount = await verifyCredentialOrCountModels(driver, RESOLVED, undefined)
    expect(modelCount).toBe(1)
  })

  it('fails with a CredentialError when the driver has no verifyCredential AND the catalogue is fallback-only', async () => {
    const driver = fakeProvider({ listModels: async () => FALLBACK_ONLY_MODELS })
    await expect(verifyCredentialOrCountModels(driver, RESOLVED, undefined)).rejects.toBeInstanceOf(CredentialError)
  })
})

// `secretShapeError` runs against the REAL driver registry (unlike the
// dispatch tests above), because the whole point is that the handler asks the
// provider rather than carrying a `providerId === 'claudeCli'` branch of its
// own. It is the free, save-time counterpart to the paid `/test` round trip:
// it stops a wrong-kind paste from ever being encrypted and stored, which is
// how a browser authorization code once sat in the credentials table looking
// healthy until it surfaced as a bare 401 mid-chat.
describe('secretShapeError', () => {
  it('rejects a browser authorization code pasted as a claudeCli credential', () => {
    expect(secretShapeError('claudeCli', 'S5HyAbCdEf-gHiJkLmNoP#QrStUvWxYz')).toContain(
      'not a Claude setup-token',
    )
  })

  // A console API key is a VALID credential in the wrong place, not a typo —
  // the message has to name where it belongs rather than only what it isn't.
  it('points an Anthropic API key at the provider it actually works under', () => {
    const message = secretShapeError('claudeCli', 'sk-ant-api03-abcdef123456')
    expect(message).toContain('Anthropic API key')
    expect(message).toContain('"Anthropic" provider')
  })

  it('accepts a real setup-token shape', () => {
    expect(secretShapeError('claudeCli', 'sk-ant-oat01-abc123')).toBeNull()
  })

  it('has no opinion on providers that declare no shape', () => {
    expect(secretShapeError('anthropic', 'sk-ant-api03-whatever')).toBeNull()
  })

  it('accepts an absent secret — "no key supplied" is not a shape failure', () => {
    expect(secretShapeError('claudeCli', undefined)).toBeNull()
  })
})
