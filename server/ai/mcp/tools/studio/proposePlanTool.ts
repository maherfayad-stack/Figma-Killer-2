/**
 * `studio_propose_plan` — plan mode on the HTTP drivers (AI-22).
 *
 * The `claude` CLI has a plan permission mode of its own: it plans, calls its
 * `ExitPlanMode` tool, and the panel shows that as an approvable checklist
 * (`AgentPermissionCard`). The HTTP drivers had nothing — the composer's
 * "Plan" mode was silently ignored and the agent wrote files straight away.
 *
 * This is that step for them. Offered ONLY on an HTTP turn in plan mode
 * (`selectStudioTools`' `planMode`), it shows the steps to the user as the
 * same checklist and waits for the answer: approved, or revise (with the
 * steps the user struck, or a request to keep planning). Until a plan is
 * approved in the turn, the tool loop refuses every `sideEffects: 'write'`
 * call and every Tier-2 tool (`heldUntilPlanApproved`) with
 * `plan-not-approved` (`toolDispatch.ts`) — the mode is enforced,
 * not merely described.
 *
 * Server execution with a browser round trip, like the CLI's permission
 * prompt (`permissionGate.ts`): the question travels as a `toolRequest` the
 * panel intercepts. No answer in time (a closed tab, a user away) is NOT a
 * transport failure that ends the turn — it comes back as "not approved", so
 * the agent stops and says it is waiting, and writes nothing.
 *
 * Not in the external MCP catalog: an external client has no panel to ask.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../../runtime/types'

export const PROPOSE_PLAN_TOOL_NAME = 'studio_propose_plan'

const ProposePlanInputSchema = Type.Object(
  {
    steps: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), {
      minItems: 1,
      maxItems: 20,
      description: 'The plan, one concrete step per entry, in order — "Create pages/Checkout.tsx with the order summary band", not "build it". The user sees these as a checklist and may strike steps.',
    }),
  },
  { additionalProperties: false },
)

export const proposePlanTool: AiTool = {
  name: PROPOSE_PLAN_TOOL_NAME,
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Plan mode: show the user your plan as a checklist and wait for approval BEFORE writing anything. Call it once you know what you will change, with one concrete step per entry. Returns { approved: true } — carry out exactly the approved plan — or { approved: false, feedback } — revise the plan as the feedback says and call this again. Every file write, and every tool that runs the project\'s own code (studio_lint, studio_render_reference), is refused with plan-not-approved until a plan is approved.',
  inputSchema: ProposePlanInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { steps } = input as { steps: string[] }
    if (!ctx.bridge) {
      return { ok: true, approved: false, feedback: 'No Studio panel is connected to ask the user. Stop, and tell the user your plan in your reply.' }
    }
    try {
      const output = await ctx.bridge.callBrowser(PROPOSE_PLAN_TOOL_NAME, { steps })
      const data = output.ok ? output.data : undefined
      if (output.ok && data && typeof data === 'object' && typeof (data as { approved?: unknown }).approved === 'boolean') {
        const answer = data as { approved: boolean; feedback?: unknown }
        return {
          ok: true,
          approved: answer.approved,
          ...(typeof answer.feedback === 'string' && answer.feedback.length > 0 ? { feedback: answer.feedback.slice(0, 2000) } : {}),
        }
      }
      return { ok: true, approved: false, feedback: 'The plan could not be shown to the user. Stop, and put the plan in your reply instead.' }
    } catch (err) {
      console.error('[studio:mcp] studio_propose_plan got no answer:', err)
      return {
        ok: true,
        approved: false,
        feedback: 'The user did not answer in time. Stop here: say the plan is waiting for their approval, and write nothing.',
      }
    }
  },
}
