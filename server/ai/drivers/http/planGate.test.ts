/**
 * AI-22 on the HTTP drivers: in plan mode every write — and every Tier-2 tool,
 * which runs the project's own code — is refused until the user approves a
 * plan through `studio_propose_plan`, and the approval is what opens the gate.
 */
import { describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, AiBrowserBridge } from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import { executeOneCall, heldUntilPlanApproved, type TurnPlanGate } from './toolDispatch'
import { createTurnWriteLedger } from './toolLoopBounds'
import { proposePlanTool } from '../../mcp/tools/studio/proposePlanTool'
import { selectStudioTools } from '../../tools'
import { studioLintMcpTools } from '../../mcp/tools/studio/lintTool'
import { studioAgentTools } from '../../tools/studio'

let writes = 0
const writeTool: AiTool = {
  name: 'studio_write_file',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'write',
  description: 'test write',
  inputSchema: Type.Object({ path: Type.String() }),
  handler: async () => {
    writes += 1
    return { ok: true }
  },
}

function request(answer: { approved: boolean; feedback?: string }): AiStreamRequest {
  const bridge: AiBrowserBridge = { callBrowser: async () => ({ ok: true, data: answer }) }
  return {
    systemPrompt: [],
    messages: [],
    tools: [writeTool, proposePlanTool],
    modelId: 'm',
    modelCapabilities: { toolCalling: true, visionInput: false, toolResultImages: false } as AiStreamRequest['modelCapabilities'],
    credentials: { id: 'c', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'k', baseUrl: null },
    signal: new AbortController().signal,
    bridge,
    toolContextBase: { db: {} as never, userId: 'u', capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'], conversationId: 'c', snapshot: null },
  }
}

const toolsByName = new Map([writeTool, proposePlanTool].map((t) => [t.name, t]))

describe('the plan gate', () => {
  it('refuses a write with plan-not-approved until a plan is approved, then lets it run', async () => {
    writes = 0
    const gate: TurnPlanGate = { required: true, approved: false }
    const ledger = createTurnWriteLedger()
    const req = request({ approved: true })

    const refused = await executeOneCall({ id: '1', name: 'studio_write_file', input: { path: 'a.tsx' } }, toolsByName, req, ledger, gate)
    expect(refused.output?.ok).toBe(false)
    expect(refused.output?.error).toContain('[code=plan-not-approved')
    expect(writes).toBe(0)

    const plan = await executeOneCall({ id: '2', name: 'studio_propose_plan', input: { steps: ['Write a.tsx'] } }, toolsByName, req, ledger, gate)
    expect(plan.output?.ok).toBe(true)
    expect(gate.approved).toBe(true)

    const allowed = await executeOneCall({ id: '3', name: 'studio_write_file', input: { path: 'b.tsx' } }, toolsByName, req, ledger, gate)
    expect(allowed.output?.ok).toBe(true)
    expect(writes).toBe(1)
  })

  it('a declined plan keeps the gate shut and hands the feedback back', async () => {
    const gate: TurnPlanGate = { required: true, approved: false }
    const plan = await executeOneCall({ id: '1', name: 'studio_propose_plan', input: { steps: ['x'] } }, toolsByName, request({ approved: false, feedback: 'Revise it' }), createTurnWriteLedger(), gate)
    expect(plan.output?.data).toMatchObject({ approved: false, feedback: 'Revise it' })
    expect(gate.approved).toBe(false)
  })

  it('holds studio_lint — a Tier-2 observer that runs the project\'s own ESLint config and plugins — until a plan is approved', async () => {
    // The REAL tool's declaration, with only its body swapped for a counter:
    // what the gate reads is the tool's own sideEffects and capabilities.
    let lints = 0
    const lint: AiTool = { ...studioLintMcpTools[0]!, handler: async () => { lints += 1; return { ok: true } } }
    expect(lint.sideEffects).not.toBe('write')
    const tools = new Map([lint, proposePlanTool].map((t) => [t.name, t]))
    const gate: TurnPlanGate = { required: true, approved: false }
    const ledger = createTurnWriteLedger()
    const base = request({ approved: true })
    // The capability gate still applies after the plan gate; give the caller the grant so only the plan gate is under test.
    const req: AiStreamRequest = { ...base, toolContextBase: { ...base.toolContextBase, capabilities: ['ai.chat', 'ai.tools.write', 'studio.write', 'studio.run.project'] } }

    const refused = await executeOneCall({ id: '1', name: 'studio_lint', input: {} }, tools, req, ledger, gate)
    expect(refused.output?.error).toContain('[code=plan-not-approved')
    expect(lints).toBe(0)

    await executeOneCall({ id: '2', name: 'studio_propose_plan', input: { steps: ['Lint'] } }, tools, req, ledger, gate)
    const allowed = await executeOneCall({ id: '3', name: 'studio_lint', input: {} }, tools, req, ledger, gate)
    expect(allowed.output?.ok).toBe(true)
    expect(lints).toBe(1)

    // Outside plan mode it runs straight away.
    await executeOneCall({ id: '4', name: 'studio_lint', input: {} }, tools, req, createTurnWriteLedger(), { required: false, approved: false })
    expect(lints).toBe(2)
  })

  it('holds every write and every Tier-2 tool, and no other observer', () => {
    const held = studioAgentTools.filter(heldUntilPlanApproved).map((t) => t.name)
    expect(held).toContain('studio_lint')
    expect(held).toContain('studio_render_reference')
    for (const tool of studioAgentTools) {
      const tier2 = tool.requiredCapabilities?.includes('studio.run.project') === true
      expect(heldUntilPlanApproved(tool), tool.name).toBe(tool.sideEffects === 'write' || tier2)
    }
    expect(held).not.toContain('studio_screenshot')
    expect(held).not.toContain('studio_typecheck')
  })

  it('is offered only to an HTTP turn in plan mode', () => {
    const caps = ['ai.chat', 'ai.tools.write', 'studio.write'] as const
    const names = (planMode: boolean, fileAccess: 'native' | 'studio-tools') =>
      selectStudioTools([...caps], { studioProjectOpen: true, fileAccess, planMode }).map((t) => t.name)
    expect(names(true, 'studio-tools')).toContain('studio_propose_plan')
    expect(names(false, 'studio-tools')).not.toContain('studio_propose_plan')
    expect(names(true, 'native')).not.toContain('studio_propose_plan')
  })
})
