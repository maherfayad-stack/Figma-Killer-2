/**
 * `ai_conversations.model_source` (migration 024, AI-25) — the record model
 * routing needs before it may touch a turn: was this conversation's model
 * Studio's default, or did the user pick it?
 *
 * Routing is only allowed on `default`, so every path that could mislabel a
 * pick as a default is pinned here: an omitted source, a legacy row, and a
 * model changed through the picker afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  createConversationForUser,
  readConversationForUser,
  updateConversationForUser,
} from '../../../server/ai/conversations/store'

describe('conversation model source', () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await createTestDb()
    await testDb.db`
      insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
      values ('user_1', 'a@a.com', 'a@a.com', 'A', 'x', 'active', 'admin')
    `
    await testDb.db`
      insert into ai_provider_credentials (id, user_id, provider_id, auth_mode, display_label, base_url)
      values ('cred_1', 'user_1', 'ollama', 'baseUrl', 'Test', 'http://localhost:11434')
    `
  })

  afterEach(async () => {
    await testDb.cleanup()
  })

  it('records a default model as default', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', { credentialId: 'cred_1', modelId: 'claude-opus-5-5', modelSource: 'default' })
    expect(conv.modelSource).toBe('default')
    expect((await readConversationForUser(testDb.db, 'user_1', conv.id))!.modelSource).toBe('default')
  })

  it('an omitted source is chosen — the side that is never routed', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', { credentialId: 'cred_1', modelId: 'claude-opus-5-5' })
    expect(conv.modelSource).toBe('chosen')
  })

  it('a row from before migration 024 (NULL) reads as chosen', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', { credentialId: 'cred_1', modelId: 'claude-opus-5-5', modelSource: 'default' })
    await testDb.db`update ai_conversations set model_source = null where id = ${conv.id}`
    expect((await readConversationForUser(testDb.db, 'user_1', conv.id))!.modelSource).toBe('chosen')
  })

  it('a model changed through the picker afterwards is chosen from then on; a title change keeps the source', async () => {
    const conv = await createConversationForUser(testDb.db, 'user_1', { credentialId: 'cred_1', modelId: 'claude-opus-5-5', modelSource: 'default' })
    const renamed = await updateConversationForUser(testDb.db, 'user_1', conv.id, { title: 'Checkout' })
    expect(renamed!.modelSource).toBe('default')
    const picked = await updateConversationForUser(testDb.db, 'user_1', conv.id, { modelId: 'claude-opus-5-5' })
    expect(picked!.modelSource).toBe('chosen')
  })
})
