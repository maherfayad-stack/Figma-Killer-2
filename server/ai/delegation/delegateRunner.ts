/**
 * Subagents for the API-key path (AI-23): what `studio_delegate` runs.
 *
 * The `claude` CLI fans screens out with its native `Task` tool; the HTTP
 * drivers had nothing, so a three-screen ask was three screens built one after
 * another in one context. This runs one bounded child tool loop per page, on
 * the same driver and credential as the turn, concurrently, and hands the
 * parent a short report per page.
 *
 * ## The contract is the CLI's, enforced instead of described
 *
 * The CLI's Parallel-work contract (`systemPrompt.ts`) says: one agent per
 * page; that agent owns the page's component file and its `.module.css`, and
 * nothing else; every shared file stays with the orchestrator. There, the
 * prompt is the only enforcement. Here, the child's three write tools are
 * wrapped ({@link ownedWriteTool}): a write to any other path is refused
 * `not-owned` before the real tool runs. Every other rule the parent's writes
 * obey — containment, the agent write gate, the stale-hash guard, the project
 * write lock, the turn write log, the per-turn checkpoint — is the real tool's,
 * unchanged, because the child calls the same tool objects.
 *
 * ## What a child is, and is not, given
 *
 *   - **Tools:** the parent's own surface, filtered. Observers (screenshot,
 *     compare, typecheck, the catalog reads…) as they are; the three file
 *     writes, ownership-wrapped; NO other write (`studio_set_tokens`,
 *     `studio_arrange_frames`, `studio_find_image`, `studio_install_deps`…
 *     all touch shared state), no `bridge` tool, and never `studio_delegate`
 *     itself or `studio_propose_plan` — a child cannot fan out again.
 *   - **Browser:** none. A capture that needs the open board refuses rather
 *     than raising a request the panel never saw the call for.
 *   - **Model:** `MODEL_ROUTING_TABLE.subagent` under `routeModel`'s rules —
 *     `claude-sonnet-5` on a default Anthropic conversation, the
 *     conversation's own model otherwise (a user's pick is never overridden).
 *   - **Bounds:** {@link CHILD_MAX_TOOL_ROUNDS} rounds each (the loop's own
 *     wind-down and summary round apply), the turn's abort signal, at most
 *     `MAX_DELEGATE_TASKS` children per call (the tool's schema), and the
 *     turn's delegation budget below.
 *
 * ## The per-turn budget
 *
 * Each child is a full agent loop on the user's key, and the parent may call
 * `studio_delegate` in any round — so without a turn-wide bound, one turn (an
 * injected one included) could spend its round cap × 4 children × 24 rounds.
 * The runner is created once per chat turn, so it holds the turn's budget and
 * reserves from it before any child starts:
 *
 *   - at most {@link MAX_DELEGATE_CALLS_PER_TURN} `studio_delegate` calls;
 *   - at most {@link MAX_CHILDREN_PER_TURN} children across them;
 *   - at most {@link MAX_CHILD_ROUNDS_PER_TURN} child rounds across them. A
 *     child's round cap is `min(CHILD_MAX_TOOL_ROUNDS, its share of what is
 *     left − 1)`, and it reserves that cap plus the loop's one summary round —
 *     the most it can spend — so the sum can never pass the ceiling. A share
 *     under {@link MIN_CHILD_ROUNDS} is refused rather than handed a child too
 *     short to finish a page.
 *
 * A call over any of them is refused whole (`delegation-budget-exhausted`),
 * before anything runs; the parent builds the rest itself.
 *
 * ## Cost and record
 *
 * Each child's usage is priced as ITS model and added to the conversation's
 * totals (`addConversationUsageTotals`), so the turn's audit row and the
 * list view include it. Each child writes its own `kind: 'turn'` telemetry
 * line with role `subagent`. Its writes land in the parent turn's checkpoint,
 * so "Revert turn" undoes them too.
 */
import { toolRefusal } from '@core/ai'
import type { AiBrowserBridge, AiProviderId, AiStreamEvent, AiTool, AiToolOutput, DelegateRunner, DelegateTask, DelegateTaskResult, ToolContext } from '../runtime/types'
import type { AiProvider, AiResolvedCredential, AiStreamRequest, ToolContextBase } from '../drivers/types'
import { resolveModelCapabilities } from '../drivers/modelCapabilities'
import { routeModel, type ModelRoute, type ModelSource } from '../routing/modelRouting'
import { availableModelIds } from '../routing/modelAvailability'
import { createTurnTelemetry } from '../turnTelemetry'
import { resolveAgentFilePath } from '../../handlers/studio/agentFileAccess'

export const DELEGATE_TOOL_NAME = 'studio_delegate'
/** Child round ceiling — enough to write, look, fix and verify one screen. */
export const CHILD_MAX_TOOL_ROUNDS = 24
/** `studio_delegate` calls one parent turn may make. */
export const MAX_DELEGATE_CALLS_PER_TURN = 2
/** Children one parent turn may start, across all its calls (two full calls of 4). */
export const MAX_CHILDREN_PER_TURN = 8
/** Child provider rounds one parent turn may spend, summary rounds included (six full-length children). */
export const MAX_CHILD_ROUNDS_PER_TURN = 150
/** A child granted fewer rounds than this could not finish a page; the call is refused instead. */
export const MIN_CHILD_ROUNDS = 6
/** The report a child hands back is cut here; the files are the real result. */
const MAX_REPORT_CHARS = 4_000

/** The three file writes a child keeps, ownership-wrapped. */
const CHILD_WRITE_TOOLS = new Set(['studio_write_file', 'studio_edit_file', 'studio_edit_files'])
/** Never offered to a child, whatever else is. */
const NEVER_FOR_A_CHILD = new Set([DELEGATE_TOOL_NAME, 'studio_propose_plan'])

export interface DelegateUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly costUsd?: number
}

export interface CreateDelegateRunnerParams {
  readonly driver: AiProvider
  readonly credentials: AiResolvedCredential
  readonly providerId: AiProviderId
  /** The conversation's own model and why it is set — the subagent route starts from them. */
  readonly conversationModelId: string
  readonly modelSource: ModelSource
  /** The parent turn's system prompt; a child gets it plus the subagent contract. */
  readonly systemPrompt: readonly string[]
  /** The parent turn's tools (already capability-filtered); a child gets a subset. */
  readonly tools: readonly AiTool[]
  /** Called once per child with its usage and the model that spent it. Never throws into the turn. */
  readonly recordUsage: (usage: DelegateUsage, modelId: string) => Promise<void>
}

/** Case-insensitive on the filesystems that are. */
function sameFileKey(rel: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? rel.toLowerCase() : rel
}

/** The paths a write tool's input names, before the tool validates them. */
function writePaths(toolName: string, input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  if (toolName === 'studio_edit_files') {
    const edits = (input as { edits?: unknown }).edits
    return Array.isArray(edits) ? edits.flatMap((edit) => (typeof edit === 'object' && edit !== null && typeof (edit as { path?: unknown }).path === 'string' ? [(edit as { path: string }).path] : [])) : []
  }
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' ? [path] : []
}

/**
 * A write tool that refuses any path this child does not own, then runs the
 * real tool. A path the real tool would refuse anyway (outside the project, a
 * protected file) is left to it, so the refusal the child sees is the precise one.
 */
export function ownedWriteTool(tool: AiTool, owned: readonly string[], written: Set<string>): AiTool {
  const ownedKeys = new Set(owned.map(sameFileKey))
  return {
    ...tool,
    handler: async (input, ctx) => {
      const dir = ctx.workspaceDir
      const paths = writePaths(tool.name, input)
      for (const raw of paths) {
        if (!dir) break
        const target = resolveAgentFilePath(dir, raw, 'write')
        if (!target.ok) continue
        if (!ownedKeys.has(sameFileKey(target.rel))) {
          return toolRefusal('not-owned', `"${target.rel}" is not this subagent's file: it owns only ${owned.join(' and ')}.`, {
            remedy: 'Shared files stay with the agent that delegated to you. Finish your own files, then name the exact change you need in your final reply.',
          })
        }
      }
      const output = await tool.handler!(input, ctx)
      if (typeof output === 'object' && output !== null && (output as { ok?: unknown }).ok === true) {
        for (const raw of paths) written.add(raw)
      }
      return output
    },
  }
}

/** The contract appended to a child's system prompt. */
export function subagentContract(task: DelegateTask): string {
  return [
    '# You are a subagent',
    `Another agent delegated ONE page to you. You own exactly these files: ${task.owned.join(', ')}. Every write to any other file is refused (not-owned).`,
    'Shared files — translation dictionaries, shared components, design tokens, the board, package.json — belong to the agent that delegated to you. If your page needs one changed, do not work around it: say exactly what should change in your final reply.',
    'Do the whole task: write the files, look at the screen, typecheck, fix. Then reply with a short report — what you built, what you verified and how, what is left or needs the other agent. The files are the result; the report is how the other agent learns what you did.',
  ].join('\n\n')
}

/** A bridge for a child: there is no panel waiting on its calls. */
const NO_BOARD_BRIDGE: AiBrowserBridge = {
  callBrowser: async (toolName) =>
    toolRefusal('no-board-connected', `${toolName} needs the open board, and a subagent has no board connection.`, {
      remedy: 'Use the headless tools only, and say in your report what you could not check.',
    }) as AiToolOutput,
}

/** The child's tool list: observers as they are, the three file writes ownership-wrapped, nothing else. */
export function childTools(parentTools: readonly AiTool[], owned: readonly string[], written: Set<string>): AiTool[] {
  const out: AiTool[] = []
  for (const tool of parentTools) {
    if (NEVER_FOR_A_CHILD.has(tool.name) || tool.execution === 'bridge') continue
    if (CHILD_WRITE_TOOLS.has(tool.name)) out.push(ownedWriteTool(tool, owned, written))
    else if (tool.sideEffects !== 'write') out.push(tool)
  }
  return out
}

function childContext(ctx: ToolContext): ToolContextBase {
  // Everything the parent's tools read, minus what is the parent's alone.
  const { signal: _signal, bridge: _bridge, delegate: _delegate, ...base } = ctx
  return { ...base }
}

/** A turn's delegation budget: what is left of it, and one call's reservation against it. */
export interface DelegationBudget {
  /** Reserves `taskCount` children; the per-child round cap, or why the call is refused. Reserving is synchronous. */
  reserve(taskCount: number): { ok: true; childMaxRounds: number } | { ok: false; reason: string }
}

export interface DelegationLimits {
  readonly calls: number
  readonly children: number
  readonly rounds: number
}

export const DELEGATION_LIMITS: DelegationLimits = {
  calls: MAX_DELEGATE_CALLS_PER_TURN,
  children: MAX_CHILDREN_PER_TURN,
  rounds: MAX_CHILD_ROUNDS_PER_TURN,
}

export function createDelegationBudget(limits: DelegationLimits = DELEGATION_LIMITS): DelegationBudget {
  let calls = 0
  let children = 0
  let rounds = 0
  return {
    reserve(taskCount) {
      if (calls >= limits.calls) {
        return { ok: false, reason: `This turn already delegated ${calls} times, the most one turn may (${limits.calls}).` }
      }
      if (children + taskCount > limits.children) {
        return { ok: false, reason: `This turn has started ${children} subagents; ${taskCount} more would pass the ${limits.children} one turn may start.` }
      }
      const share = Math.floor((limits.rounds - rounds) / taskCount) - 1
      const childMaxRounds = Math.min(CHILD_MAX_TOOL_ROUNDS, share)
      if (childMaxRounds < MIN_CHILD_ROUNDS) {
        return { ok: false, reason: `This turn's subagents have reserved ${rounds} of the ${limits.rounds} rounds one turn may spend on them; ${taskCount} more would get under ${MIN_CHILD_ROUNDS} rounds each.` }
      }
      calls += 1
      children += taskCount
      rounds += taskCount * (childMaxRounds + 1)
      return { ok: true, childMaxRounds }
    },
  }
}

export function createDelegateRunner(params: CreateDelegateRunnerParams, limits: DelegationLimits = DELEGATION_LIMITS): DelegateRunner {
  // One runner per chat turn (`handlers/chat.ts`), so this is the turn's budget.
  const budget = createDelegationBudget(limits)
  return {
    async run(tasks, ctx) {
      const grant = budget.reserve(tasks.length)
      if (!grant.ok) return { ran: false, reason: grant.reason }
      const available = params.modelSource === 'default' && params.providerId === 'anthropic'
        ? await availableModelIds(params.driver, params.credentials, ctx.signal)
        : null
      const route = routeModel({
        providerId: params.providerId,
        modelId: params.conversationModelId,
        modelSource: params.modelSource,
        role: 'subagent',
        availableModelIds: available,
      })
      const modelCapabilities = await resolveModelCapabilities(params.driver, params.credentials, route.modelId)
      const results = await Promise.all(tasks.map((task) => runChild(params, task, ctx, route, modelCapabilities, grant.childMaxRounds)))
      return { ran: true, results }
    },
  }
}

async function runChild(
  params: CreateDelegateRunnerParams,
  task: DelegateTask,
  ctx: ToolContext,
  route: ModelRoute,
  modelCapabilities: AiStreamRequest['modelCapabilities'],
  maxToolRounds: number,
): Promise<DelegateTaskResult> {
  const written = new Set<string>()
  const prompt = [...params.systemPrompt]
  prompt[prompt.length - 1] = `${prompt[prompt.length - 1] ?? ''}\n\n${subagentContract(task)}`
  const request: AiStreamRequest = {
    systemPrompt: prompt,
    messages: [{ role: 'user', content: [{ kind: 'text', text: task.brief }] }],
    tools: childTools(params.tools, task.owned, written),
    modelId: route.modelId,
    modelCapabilities,
    credentials: params.credentials,
    signal: ctx.signal,
    bridge: NO_BOARD_BRIDGE,
    toolContextBase: childContext(ctx),
    workspaceDir: ctx.workspaceDir,
    maxToolRounds,
  }
  const telemetry = createTurnTelemetry({
    dir: ctx.workspaceDir ?? null,
    conversationId: ctx.conversationId,
    providerId: params.providerId,
    conversationModelId: params.conversationModelId,
    route,
    fidelityMode: ctx.fidelityMode,
  })

  let text = ''
  let toolCalls = 0
  let rounds = 0
  let error: string | undefined
  let usage: DelegateUsage | null = null
  try {
    for await (const event of params.driver.stream(request) as AsyncIterable<AiStreamEvent>) {
      telemetry.observe(event)
      if (event.type === 'text') text += event.text
      else if (event.type === 'toolCall') text = '' // the report is what the child said LAST
      else if (event.type === 'toolResult') toolCalls += 1
      else if (event.type === 'context') rounds += 1
      else if (event.type === 'error') error = event.message
      else if (event.type === 'usage') {
        usage = {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          cacheReadTokens: event.cacheReadTokens ?? 0,
          cacheCreationTokens: event.cacheCreationTokens ?? 0,
          ...(event.costUsd != null ? { costUsd: event.costUsd } : {}),
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const aborted = ctx.signal.aborted
  telemetry.finish({ promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0, aborted })
  if (usage) {
    await params.recordUsage(usage, route.modelId).catch((err: unknown) => {
      console.error('[ai/delegate] could not record a subagent\'s usage:', err)
    })
  }
  const report = text.trim().slice(0, MAX_REPORT_CHARS)
  return {
    page: task.page,
    ok: error === undefined && !aborted,
    model: route.modelId,
    report: report.length > 0 ? report : '(The subagent ended without a report. Check its files before relying on them.)',
    filesWritten: [...written],
    toolCalls,
    rounds,
    ...(aborted ? { stopped: 'aborted' as const } : error !== undefined ? { stopped: 'error' as const, error: error.slice(0, 500) } : {}),
  }
}
