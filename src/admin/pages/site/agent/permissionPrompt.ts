/**
 * The browser half of the in-chat permission prompt.
 *
 * When the `claude` CLI wants to use a tool that needs approval, it calls
 * Studio's `permission_request` MCP tool, which relays the question down the
 * open chat stream as an ordinary `toolRequest`. This module parks that request
 * until the user clicks Allow or Deny, then hands the answer back so
 * `streamEvents.ts` can POST it like any other tool result.
 *
 * The waiter lives in a module-level map rather than in the store because a
 * `resolve` function is not serialisable state — the store holds only what the
 * panel needs to RENDER, and the promise is settled by id. Full rationale for
 * the round trip: `server/ai/mcp/permissionGate.ts`.
 */
import { nanoid } from 'nanoid'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'

/** Server-side name for the relayed request; see `PERMISSION_REQUEST_TOOL_NAME`. */
export const PERMISSION_REQUEST_TOOL = 'permission_request'

export const PermissionRequestInputSchema = Type.Object({
  toolName: Type.String(),
  input: Type.Optional(Type.Unknown()),
  toolUseId: Type.Optional(Type.String()),
})

export type PermissionBehavior = 'allow' | 'deny'

/** What the panel renders. `detail` is the specific thing being asked for — a path, a command — or null when the tool carries no single meaningful subject. */
export interface AgentPermissionRequest {
  readonly id: string
  readonly toolName: string
  readonly title: string
  readonly detail: string | null
  /**
   * AI-22 — set when the question is "approve this plan?": the CLI's
   * `ExitPlanMode` in plan permission mode, or the HTTP agent's
   * `studio_propose_plan`. The steps render as a checklist the user can trim
   * before approving.
   */
  readonly plan?: readonly string[]
}

/** The HTTP agent's plan-mode tool (`server/ai/mcp/tools/studio/proposePlanTool.ts`) — relayed to the browser like a permission prompt. */
export const PROPOSE_PLAN_TOOL = 'studio_propose_plan'

/** A plan's steps: an array given as such, or the list items of a markdown plan (numbered, bulleted or checkbox), else its non-empty lines. */
export function planSteps(input: unknown): string[] {
  const params = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (Array.isArray(params.steps)) {
    return params.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0).map((step) => step.trim()).slice(0, 30)
  }
  const plan = typeof params.plan === 'string' ? params.plan : ''
  const lines = plan.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const items = lines
    .map((line) => /^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.+)$/.exec(line)?.[1])
    .filter((item): item is string => typeof item === 'string')
  return (items.length > 0 ? items : lines.filter((line) => !line.startsWith('#'))).slice(0, 30)
}

const DecisionSchema = Type.Object({
  behavior: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
  message: Type.Optional(Type.String()),
})
export type PermissionDecisionPayload = Static<typeof DecisionSchema>

const waiters = new Map<string, (decision: PermissionDecisionPayload) => void>()

/**
 * Park a prompt and return the promise the stream handler awaits. Never
 * rejects: a denial is a legitimate answer, and every abandonment path below
 * resolves with one, so the caller always has something to POST back.
 */
export function awaitPermissionDecision(id: string): Promise<PermissionDecisionPayload> {
  return new Promise<PermissionDecisionPayload>((resolve) => {
    waiters.set(id, resolve)
  })
}

/** Settle a parked prompt. Returns false when the id is unknown (already answered, or abandoned). */
export function settlePermissionDecision(id: string, decision: PermissionDecisionPayload): boolean {
  const resolve = waiters.get(id)
  if (!resolve) return false
  waiters.delete(id)
  resolve(decision)
  return true
}

/**
 * Deny everything still parked — called when a turn is aborted or its stream
 * ends. Without this a prompt whose turn died would hang forever and the
 * panel would keep showing a card nothing can answer.
 */
export function abandonPermissionPrompts(message = 'The turn ended before you answered.'): void {
  for (const [id, resolve] of [...waiters]) {
    waiters.delete(id)
    resolve({ behavior: 'deny', message })
  }
}

/** Test-only: how many prompts are parked. */
export function __parkedPermissionPromptCount(): number {
  return waiters.size
}

/**
 * Turn the CLI's `{ toolName, input }` into something a person can decide on.
 * The tool names here are the CLI's OWN built-ins (not Studio's MCP tools), so
 * they are matched case-insensitively against the names it actually emits.
 */
export function describePermissionRequest(toolName: string, input: unknown): AgentPermissionRequest {
  const params = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (key: string): string | null => (typeof params[key] === 'string' ? (params[key] as string) : null)

  switch (toolName.toLowerCase()) {
    case 'exitplanmode':
    case PROPOSE_PLAN_TOOL:
      return { ...build(toolName, 'Approve this plan?', null), plan: planSteps(input) }
    case 'read':
      return build(toolName, 'Read a file outside this project', str('file_path'))
    case 'write':
      return build(toolName, 'Create a file outside this project', str('file_path'))
    case 'edit':
    case 'multiedit':
      return build(toolName, 'Edit a file outside this project', str('file_path'))
    case 'bash':
      return build(toolName, 'Run a command', str('command'))
    case 'webfetch':
    case 'web_fetch':
      return build(toolName, 'Fetch a web page', str('url'))
    case 'websearch':
    case 'web_search':
      return build(toolName, 'Search the web', str('query'))
    default:
      return build(toolName, `Use ${toolName}`, firstStringValue(params))
  }
}

function build(toolName: string, title: string, detail: string | null): AgentPermissionRequest {
  return { id: nanoid(), toolName, title, detail: detail && detail.trim() ? detail : null }
}

/** Best-effort subject for a tool this module doesn't know by name. */
function firstStringValue(params: Record<string, unknown>): string | null {
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** Validates the relayed `input` payload at the stream boundary. */
export function parsePermissionRequestInput(
  input: unknown,
): Static<typeof PermissionRequestInputSchema> | null {
  return Value.Check(PermissionRequestInputSchema, input) ? input : null
}
