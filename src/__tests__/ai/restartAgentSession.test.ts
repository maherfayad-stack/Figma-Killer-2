/**
 * POST /admin/api/ai/conversations/:id/restart-session
 *
 * Bumps `ai_conversations.session_epoch` (migration 021) so the next
 * `claudeCli` turn derives a brand-new CLI session id — see
 * `server/ai/drivers/claudeCliSession.ts` and `docs/features/agent.md`'s
 * "Restarting the agent session" section for the full mechanism. This file
 * covers the HTTP surface: capability gating, ownership, 404s, and that the
 * epoch actually increments.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectForbidden,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { createConversationForUser } from '../../../server/ai/conversations/store'

async function readSessionEpoch(harness: CapabilityTestHarness, conversationId: string): Promise<number> {
  const { rows } = await harness.db<{ session_epoch: number }>`
    select session_epoch from ai_conversations where id = ${conversationId}
  `
  return Number(rows[0]!.session_epoch)
}

describe('POST /admin/api/ai/conversations/:id/restart-session', () => {
  let harness: CapabilityTestHarness
  let ownerCookie: string
  let ownerId: string

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    ownerCookie = await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0]!.id
    await harness.db`
      insert into ai_provider_credentials (
        id, user_id, provider_id, auth_mode, display_label, base_url
      ) values ('cred-restart-session', ${ownerId}, 'ollama', 'baseUrl', 'Restart session', 'http://local')
    `
  })

  afterEach(async () => {
    await harness.cleanup()
  })

  it('rejects a caller without ai.chat', async () => {
    const conversation = await createConversationForUser(harness.db, ownerId, {
      credentialId: 'cred-restart-session',
      modelId: 'model-1',
    })
    const noChatCapability = await harness.createRoleUser({
      name: 'Dashboard Only',
      slug: 'dashboard-only-restart',
      capabilities: ['dashboard.read'],
    })
    await expectForbidden(await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/restart-session`,
      { method: 'POST', cookie: noChatCapability.cookie },
    ))
    expect(await readSessionEpoch(harness, conversation.id)).toBe(0)
  })

  it('rejects a non-POST method', async () => {
    const conversation = await createConversationForUser(harness.db, ownerId, {
      credentialId: 'cred-restart-session',
      modelId: 'model-1',
    })
    const res = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/restart-session`,
      { method: 'GET', cookie: ownerCookie },
    )
    expect(res.status).toBe(405)
  })

  it('404s for a conversation that does not exist', async () => {
    const res = await harness.ai(
      '/admin/api/ai/conversations/does-not-exist/restart-session',
      { method: 'POST', cookie: ownerCookie },
    )
    expect(res.status).toBe(404)
  })

  it("404s for another user's conversation — cannot restart a session you don't own", async () => {
    const conversation = await createConversationForUser(harness.db, ownerId, {
      credentialId: 'cred-restart-session',
      modelId: 'model-1',
    })
    const otherChatUser = await harness.createRoleUser({
      name: 'Other Chat User',
      slug: 'chat-user-restart-other',
      capabilities: ['ai.chat'],
    })
    const res = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/restart-session`,
      { method: 'POST', cookie: otherChatUser.cookie },
    )
    expect(res.status).toBe(404)
    expect(await readSessionEpoch(harness, conversation.id)).toBe(0)
  })

  it('increments session_epoch by one per call, leaving the conversation row otherwise untouched', async () => {
    const conversation = await createConversationForUser(harness.db, ownerId, {
      credentialId: 'cred-restart-session',
      modelId: 'model-1',
    })
    expect(await readSessionEpoch(harness, conversation.id)).toBe(0)

    const first = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/restart-session`,
      { method: 'POST', cookie: ownerCookie },
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })
    expect(await readSessionEpoch(harness, conversation.id)).toBe(1)

    const second = await harness.ai(
      `/admin/api/ai/conversations/${conversation.id}/restart-session`,
      { method: 'POST', cookie: ownerCookie },
    )
    expect(second.status).toBe(200)
    expect(await readSessionEpoch(harness, conversation.id)).toBe(2)

    const { rows } = await harness.db<{ title: string; credential_id: string; model_id: string }>`
      select title, credential_id, model_id from ai_conversations where id = ${conversation.id}
    `
    expect(rows[0]!.credential_id).toBe('cred-restart-session')
    expect(rows[0]!.model_id).toBe('model-1')
  })
})
