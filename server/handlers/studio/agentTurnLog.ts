/**
 * agentTurnLog — one append-only line per tool call, in the project's own
 * `.studio/agent-turns.jsonl`.
 *
 * ## Why a file, and why this file
 *
 * "The agent is slow" was, for the whole life of this feature, an opinion. The
 * server knew every number needed to settle it — which tool, how long, how
 * many bytes in and out, whether the verdict came from a cache — and threw all
 * of them away the moment the round finished. `bench:agent-turn` could measure
 * the pieces it could fake (a project guide, a spawn, a capture) and could
 * never measure the thing that actually overruns: a real turn's own tool
 * sequence.
 *
 * So every tool call writes one line here, and the bench reads them back and
 * reports p50/p95 per tool against the plan's two budgets (one screen,
 * balanced, with a reference: <= 3 min; one screen, creative, no reference:
 * <= 90 s). A turn that overruns now says WHICH tool it spent the time in.
 *
 * `.studio/agent-turns.jsonl` and not `.studio/cache/`: the cache tier is
 * regenerable by re-running a tool, and this is not — a measurement of a turn
 * that already happened cannot be recomputed. It is still gitignored (it is
 * per-machine timing data, not project state) and still disposable in the
 * sense that deleting it costs only history.
 *
 * ## Bounded, always
 *
 * JSONL with no ceiling is a disk-filling bug waiting for a long-lived
 * project. {@link MAX_LOG_BYTES} caps it: once the file passes the cap the
 * writer keeps the most recent {@link TRIM_TO_BYTES} worth of WHOLE lines and
 * drops the rest. Old timing data is exactly the data worth losing — the
 * budgets are about how the agent behaves now.
 *
 * ## Never on the critical path's error budget
 *
 * Every function here swallows its own failures (logged, never thrown). A
 * telemetry write that failed must never turn into a failed tool call: the
 * user asked for a screen, not for a log line.
 *
 * ## What is never written here
 *
 * Tool INPUTS and OUTPUTS are measured (`bytesIn`/`bytesOut`) and never
 * recorded. A tool argument can carry a file path, a design brief or a pasted
 * credential; a byte count carries none of those and answers the only question
 * this log exists to answer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { FIDELITY_MODES } from './fidelityMode'
import { DESIGN_POLICIES } from './designPolicy'

/** Past this, the file is trimmed on the next append. ~2 MB is tens of thousands of rounds — far more history than any budget question needs. */
const MAX_LOG_BYTES = 2_000_000
/** What survives a trim. Half the cap, so trimming is rare rather than continuous. */
const TRIM_TO_BYTES = 1_000_000

export const AGENT_TURN_LOG_FILE = 'agent-turns.jsonl'

export const AgentTurnLogEntrySchema = Type.Object({
  /** Epoch ms the call FINISHED. */
  at: Type.Number(),
  /** The conversation this round belongs to — lets the bench group rounds into turns without a second store. */
  conversationId: Type.String(),
  tool: Type.String(),
  /** Wall-clock milliseconds inside `executeAiTool`, including a browser round trip when the tool is bridged. */
  ms: Type.Number(),
  /** Serialized size of the validated tool input. Bytes, never content. */
  bytesIn: Type.Number(),
  /** Serialized size of the tool's result envelope. Bytes, never content. */
  bytesOut: Type.Number(),
  ok: Type.Boolean(),
  /** `true` when the result says it was served from a Studio-side cache (`fromCache`) rather than recomputed. The single biggest determinant of a round's cost. */
  cacheHit: Type.Boolean(),
  /** Which execution class answered — the server in-process, or the browser over the bridge. */
  execution: Type.Union([Type.Literal('server'), Type.Literal('browser')]),
  /** This turn's resolved fidelity mode, when the call came from a chat turn. Absent for an external MCP client, which has no turn. */
  fidelityMode: Type.Optional(Type.Union(FIDELITY_MODES.map((m) => Type.Literal(m)))),
  /** This turn's resolved design policy (A12), same availability rule as `fidelityMode`. */
  designPolicy: Type.Optional(Type.Union(DESIGN_POLICIES.map((p) => Type.Literal(p)))),
})
export type AgentTurnLogEntry = Static<typeof AgentTurnLogEntrySchema>

function logFile(dir: string): string {
  return join(dir, '.studio', AGENT_TURN_LOG_FILE)
}

/**
 * Keep the tail of an oversized log, cut at a line boundary.
 *
 * Cutting mid-line would leave a fragment that no reader can parse and that
 * every reader has to defend against; finding the first `\n` in the retained
 * slice costs one scan and removes the whole class of problem.
 */
function trimIfOversized(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size <= MAX_LOG_BYTES) return
    const text = readFileSync(file, 'utf8')
    const tail = text.slice(-TRIM_TO_BYTES)
    const firstBreak = tail.indexOf('\n')
    writeFileSync(file, firstBreak >= 0 ? tail.slice(firstBreak + 1) : '')
  } catch (err) {
    console.error('[studio/agentTurnLog] could not trim the log — continuing:', err)
  }
}

/** Append one round. Never throws: see the module doc. */
export function appendAgentTurnLogEntry(dir: string, entry: AgentTurnLogEntry): void {
  try {
    const file = logFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    trimIfOversized(file)
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.error('[studio/agentTurnLog] could not record a turn round — continuing:', err)
  }
}

/**
 * Every well-formed entry in the log, oldest first.
 *
 * A line that does not validate is SKIPPED, not fatal: this file is appended
 * to by a live server and read by a bench that may run while a turn is in
 * flight, so a half-written trailing line is an ordinary state rather than
 * corruption. Returns `[]` for a project that has never run a turn.
 */
export function readAgentTurnLog(dir: string): AgentTurnLogEntry[] {
  try {
    const file = logFile(dir)
    if (!existsSync(file)) return []
    const entries: AgentTurnLogEntry[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const parsed = safeParseValue(AgentTurnLogEntrySchema, raw)
      if (parsed.ok) entries.push(parsed.value)
    }
    return entries
  } catch (err) {
    console.error('[studio/agentTurnLog] could not read the log — treating as empty:', err)
    return []
  }
}

export interface ToolLatencySummary {
  readonly tool: string
  readonly count: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly cacheHitRate: number
  readonly totalMs: number
}

/** Nearest-rank percentile over an already-sorted ascending array. No interpolation — with a handful of samples an interpolated p95 is a number nothing ever measured. */
function percentile(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(fraction * sortedAsc.length) - 1))
  return sortedAsc[rank]!
}

/**
 * Per-tool latency summary over `entries`, slowest total first — the order
 * that answers "where did the turn go", which is the question the budget
 * makes people ask.
 */
export function summarizeToolLatency(entries: readonly AgentTurnLogEntry[]): ToolLatencySummary[] {
  const byTool = new Map<string, { ms: number[]; cacheHits: number }>()
  for (const entry of entries) {
    const bucket = byTool.get(entry.tool) ?? { ms: [], cacheHits: 0 }
    bucket.ms.push(entry.ms)
    if (entry.cacheHit) bucket.cacheHits += 1
    byTool.set(entry.tool, bucket)
  }

  const summaries: ToolLatencySummary[] = []
  for (const [tool, bucket] of byTool) {
    const sorted = [...bucket.ms].sort((a, b) => a - b)
    summaries.push({
      tool,
      count: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted.at(-1) ?? 0,
      cacheHitRate: sorted.length > 0 ? bucket.cacheHits / sorted.length : 0,
      totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
    })
  }
  return summaries.sort((a, b) => b.totalMs - a.totalMs)
}

/**
 * The two budgets STUDIO-FIGMA-FEEL-PLAN.md A9 names, in one place so the
 * bench and the docs cannot state different numbers.
 *
 * They are asserted as WARNINGS, not failures, and that is deliberate for as
 * long as no real turn has been measured on this machine: a budget that fails
 * a suite on a number nobody has ever observed trains people to ignore the
 * suite. Promote to a hard assert once `.studio/agent-turns.jsonl` from a real
 * build exists to calibrate against.
 */
export const AGENT_TURN_BUDGETS = {
  /** One screen, balanced fidelity, with a design reference registered: write, capture, compare, one fix pass. */
  balancedWithReferenceMs: 3 * 60_000,
  /** One screen, creative fidelity, nothing to measure against: write, screenshot, quality check. */
  creativeNoReferenceMs: 90_000,
} as const

export interface TurnBudgetVerdict {
  readonly budgetMs: number
  readonly observedMs: number
  readonly withinBudget: boolean
  /** The tool that cost the most total time across `entries` — the first place to look when the budget is blown. */
  readonly worstTool: string | null
}

/**
 * Grade one turn's rounds against a budget.
 *
 * `observedMs` is the SUM of the turn's tool time, not wall clock: the log
 * records what Studio spent, and the model's own thinking time is neither
 * Studio's to measure nor Studio's to fix. Stated here rather than implied,
 * because a reader who thinks this is wall clock will read every verdict as
 * optimistic.
 */
export function gradeTurnAgainstBudget(entries: readonly AgentTurnLogEntry[], budgetMs: number): TurnBudgetVerdict {
  const observedMs = entries.reduce((sum, e) => sum + e.ms, 0)
  const worst = summarizeToolLatency(entries)[0]
  return {
    budgetMs,
    observedMs,
    withinBudget: observedMs <= budgetMs,
    worstTool: worst?.tool ?? null,
  }
}
