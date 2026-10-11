/**
 * A client can hold a credential id that has since been deleted: removing an
 * AI connection and adding it again mints a new id, and the open editor tab
 * still sends the old one. Creating or switching a conversation onto that id
 * used to fail `ai_conversations.credential_id`'s foreign key as a raw 500
 * ("Internal server error" in the chat). It now falls back to Studio's
 * default model, or answers a 409 saying what to do when there is none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { createConversationForUser } from '../../../server/ai/conversations/store'
import { setDefault } from '../../../server/ai/defaults/store'

describe('conversations never 500 on a removed AI connection', () => {
  let harness: CapabilityTestHarness
  let ownerCookie: string
  let ownerId: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    ownerCookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0]!.id
    await harness.db`
      insert into ai_provider_credentials (id, user_id, provider_id, auth_mode, display_label, base_url)
      values ('cred-live', ${ownerId}, 'ollama', 'baseUrl', 'Live', 'http://local')
    `
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('creates on the default model when the requested connection was removed', async () => {
    await setDefault(harness.db, 'cred-live', 'default-model', ownerId)
    const res = await harness.ai('/admin/api/ai/conversations', {
      method: 'POST',
      cookie: ownerCookie,
      json: { credentialId: 'cred-removed', modelId: 'opus' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { conversation: { credentialId: string; modelId: string } }
    expect(body.conversation.credentialId).toBe('cred-live')
    expect(body.conversation.modelId).toBe('default-model')
  })

  it('answers 409 with a way forward when there is no default to fall back to', async () => {
    const res = await harness.ai('/admin/api/ai/conversations', {
      method: 'POST',
      cookie: ownerCookie,
      json: { credentialId: 'cred-removed', modelId: 'opus' },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Settings → AI')
  })

  it('keeps a live connection exactly as requested', async () => {
    const res = await harness.ai('/admin/api/ai/conversations', {
      method: 'POST',
      cookie: ownerCookie,
      json: { credentialId: 'cred-live', modelId: 'model-1' },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { conversation: { credentialId: string; modelId: string } }
    expect(body.conversation).toMatchObject({ credentialId: 'cred-live', modelId: 'model-1' })
  })

  it('switches an existing conversation onto the default instead of 500ing', async () => {
    await setDefault(harness.db, 'cred-live', 'default-model', ownerId)
    const conversation = await createConversationForUser(harness.db, ownerId, { credentialId: 'cred-live', modelId: 'model-1' })
    const res = await harness.ai(`/admin/api/ai/conversations/${conversation.id}`, {
      method: 'PUT',
      cookie: ownerCookie,
      json: { credentialId: 'cred-removed', modelId: 'opus' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversation: { credentialId: string; modelId: string } }
    expect(body.conversation).toMatchObject({ credentialId: 'cred-live', modelId: 'default-model' })
  })
})
