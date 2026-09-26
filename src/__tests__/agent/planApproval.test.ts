/**
 * AI-22 — plan mode as an approvable checklist: the CLI's `ExitPlanMode`
 * prompt and the HTTP agent's `studio_propose_plan` both become a card whose
 * steps are parsed out of the plan, and the HTTP answer goes back as the
 * tool's result.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  PROPOSE_PLAN_TOOL,
  abandonPermissionPrompts,
  describePermissionRequest,
  planSteps,
  settlePermissionDecision,
} from '@site/agent/permissionPrompt'

afterEach(() => abandonPermissionPrompts())

describe('planSteps', () => {
  it('reads the list items of a markdown plan, numbered, bulleted or checkbox', () => {
    const plan = '# Plan\n\n1. Create pages/Checkout.tsx\n2) Add the summary band\n- [ ] Screenshot at 375\n* Typecheck'
    expect(planSteps({ plan })).toEqual(['Create pages/Checkout.tsx', 'Add the summary band', 'Screenshot at 375', 'Typecheck'])
  })

  it('takes a steps array as it is, and plain lines when the plan has no list', () => {
    expect(planSteps({ steps: [' a ', '', 'b'] })).toEqual(['a', 'b'])
    expect(planSteps({ plan: '## Heading\nDo X\nThen Y' })).toEqual(['Do X', 'Then Y'])
  })
})

describe('the plan card', () => {
  it('ExitPlanMode and studio_propose_plan are both plans, not Allow/Deny prompts', () => {
    expect(describePermissionRequest('ExitPlanMode', { plan: '1. One\n2. Two' })).toMatchObject({ title: 'Approve this plan?', plan: ['One', 'Two'] })
    expect(describePermissionRequest(PROPOSE_PLAN_TOOL, { steps: ['A'] }).plan).toEqual(['A'])
    expect(describePermissionRequest('Read', { file_path: '/x' }).plan).toBeUndefined()
  })
})

describe('studio_propose_plan over the stream', () => {
  it('shows the card, and posts the approval back as the tool result', async () => {
    // The answer leaves through the real tool-result POST; the network is the seam.
    const posted: unknown[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      posted.push(JSON.parse(String(init?.body)).result)
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const { processStreamEvent } = await import('@site/agent/streamEvents')
    let state: { agentPermissionRequest: { id: string; plan?: readonly string[] } | null; agentMessages: [] } = { agentPermissionRequest: null, agentMessages: [] }
    const set = ((recipe: (draft: typeof state) => void) => {
      const draft = structuredClone(state)
      recipe(draft)
      state = draft
    }) as never
    const pending = processStreamEvent(
      { type: 'toolRequest', requestId: 'r1', toolName: PROPOSE_PLAN_TOOL, input: { steps: ['Build it', 'Check it'] } },
      'a1',
      { append() {}, flush() {} },
      set,
      { bridgeId: 'b1' },
      null,
      async () => ({ ok: false, error: 'the plan must never reach the tool dispatcher' }),
    )
    await Promise.resolve()
    expect(state.agentPermissionRequest?.plan).toEqual(['Build it', 'Check it'])
    settlePermissionDecision(state.agentPermissionRequest!.id, { behavior: 'allow' })
    await pending
    globalThis.fetch = realFetch
    expect(posted).toEqual([{ ok: true, data: { approved: true } }])
    expect(state.agentPermissionRequest).toBeNull()
  })
})
