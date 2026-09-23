/**
 * Tool dispatch for the HTTP tool loop: which calls of one round run together,
 * and how one call runs to a settled outcome. Split out of `toolLoop.ts` at
 * the 700-line ceiling; the loop owns talking to the provider, this owns
 * running what the provider asked for.
 */
import type { AiTool, AiToolOutput } from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import { executeAiTool } from './execTool'
import { duplicateCallOutput, priorWriteOutcome, recordWriteOutcome, type TurnWriteLedger } from './toolLoopBounds'
import type { TurnToolCall } from './toolLoop'

// ---------------------------------------------------------------------------
// Tool dispatch — concurrent observers, serialised writes
// ---------------------------------------------------------------------------

/** One executed call. `output === null` means the transport itself failed. */
export interface ExecutedCall {
  readonly call: TurnToolCall
  readonly output: AiToolOutput | null
  readonly error: string
}

/**
 * Split one turn's tool calls into ordered execution GROUPS: consecutive
 * observer calls (`sideEffects` `'none'` or `'cache'`) form a single group
 * that runs concurrently, and every `'write'` gets a group of its own.
 *
 * The system prompt asks the model to issue its looks as one batch, and
 * running that batch sequentially made the loop's wall time the SUM of every
 * observation rather than the slowest one — several seconds per round on a
 * five-screen verification, repeated every round of a fix loop. A screenshot,
 * a compare, a measurement and a typecheck are all observers: each captures or
 * checks what is on disk, and the one resource two captures could contend
 * for — the headless browser — is already serialised underneath them
 * (`capture/browserPool.ts`'s `withCapturePage`), as is the live-tab
 * fallback on the client.
 *
 * The write rule is deliberately conservative, and the conservatism is the
 * point: two writes to the same file, or an observation the model issued
 * *after* a write in order to see it, must not be reordered or interleaved.
 * A name we cannot resolve to a registered tool is treated as a write (it
 * becomes an `Unknown tool: …` result, but it never shares a group).
 */
export function groupToolCalls(
  calls: readonly TurnToolCall[],
  toolsByName: ReadonlyMap<string, AiTool>,
): TurnToolCall[][] {
  const groups: TurnToolCall[][] = []
  let observerBatch: TurnToolCall[] | null = null
  for (const call of calls) {
    const tool = toolsByName.get(call.name)
    if (tool !== undefined && tool.sideEffects !== 'write') {
      if (observerBatch === null) {
        observerBatch = []
        groups.push(observerBatch)
      }
      observerBatch.push(call)
    } else {
      observerBatch = null
      groups.push([call])
    }
  }
  return groups
}

/**
 * Run one tool call to a settled outcome. Never throws: a rejected browser
 * bridge is returned as `{ output: null, error }` so the caller can emit every
 * result of the group in the model's own call order before terminating on it.
 *
 * `writeLedger` is the turn's duplicate-write record (`TurnWriteLedger`). A
 * write whose identical twin was already recorded at the current write epoch
 * is NOT executed — it is answered from that call's own result. Only
 * `sideEffects: 'write'` tools consult or advance it: `groupToolCalls` above
 * uses the same field as its concurrency boundary, and looking twice is a
 * legitimate thing for a model to do.
 */
export async function executeOneCall(
  call: TurnToolCall,
  toolsByName: ReadonlyMap<string, AiTool>,
  req: AiStreamRequest,
  writeLedger: TurnWriteLedger,
): Promise<ExecutedCall> {
  const tool = toolsByName.get(call.name)
  const ledgered = tool?.sideEffects === 'write'
  if (ledgered) {
    const prior = priorWriteOutcome(writeLedger, call.name, call.input)
    if (prior !== undefined) return { call, output: duplicateCallOutput(call.name, prior), error: '' }
  }
  try {
    const output = tool
      ? await executeAiTool(tool, prepareToolInput(call, req), req.bridge, req.signal, req.toolContextBase)
      : { ok: false, error: `Unknown tool: ${call.name}` }
    // Recorded on EVERY outcome, including a refusal: a write that refused for
    // a reason in its own error text refuses identically the second time, and
    // re-running it is exactly the loop this bound exists to stop. The ledger
    // decides whether the outcome also advances the epoch.
    if (ledgered) recordWriteOutcome(writeLedger, call.name, call.input, output)
    return { call, output, error: '' }
  } catch (err) {
    return { call, output: null, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Per-tool input preparation
// ---------------------------------------------------------------------------

/**
 * Hook for server-controlled tool inputs the model shouldn't drive. Currently
 * just `site_render_snapshot`: the server injects `captureScreenshot` from the
 * active model's vision capability so a non-vision model never pays the
 * html-to-image cost for a screenshot it can't consume.
 */
function prepareToolInput(call: TurnToolCall, req: AiStreamRequest): unknown {
  if (call.name === 'site_render_snapshot') {
    const base = call.input && typeof call.input === 'object' ? call.input : {}
    return {
      ...base,
      captureScreenshot:
        req.modelCapabilities.visionInput && req.modelCapabilities.toolResultImages,
    }
  }
  return call.input
}

