/**
 * Agent model bench (AI-25) — the measurement model routing is supposed to
 * rest on. Runs REAL agent turns on the API-key path, one per candidate model
 * per brief, and grades what each one built.
 *
 * ## It spends money, so it never runs by accident
 *
 * Every turn is a real Anthropic request on the operator's key. The bench is
 * not in the default suite, and even when named (`bun run bench:agent-models`)
 * it reports `skipped` unless BOTH `ANTHROPIC_API_KEY` and
 * `STUDIO_BENCH_SPEND=1` are set. Nothing in CI sets either.
 *
 * ## What runs
 *
 * For each model in `MODEL_BENCH_CANDIDATES` (`server/ai/routing/modelRouting.ts`
 * — `claude-fable-5-1` included, which is the point: it has no role until this
 * has run) and each brief:
 *
 *   - **creative** — a from-scratch screen, no reference. Graded by
 *     `studio_quality_check`'s finding count on the page, and by a crude,
 *     labelled scan of its stylesheet for grey fills — the placeholder boxes
 *     the ROADMAP exit gate forbids. The scan is a heuristic and says so.
 *   - **match** — rebuild the screen in `STUDIO_BENCH_MATCH_REFERENCE` (a PNG
 *     the operator supplies; skipped without one). The image is attached to the
 *     turn exactly as the chat handler attaches a pasted design, registered as
 *     the page's reference, and the turn is graded by `studio_compare`.
 *
 * Each turn is the production path end to end: the real system prompt
 * (`buildStudioProjectSystemPrompt`), the real HTTP tool surface
 * (`selectStudioTools`, `studio_delegate` included, children billed and
 * recorded), the real Anthropic driver and tool loop, against a fresh copy of
 * `studio-workspace/__canonical-fixture` under `.tmp/benchmarks/`. Every turn
 * also writes its `kind: 'turn'` telemetry line, and the per-(role, model)
 * table at the end is `summarizeTurnsByModel` over exactly those lines — the
 * same numbers `bench:agent-turn` reads from real use.
 *
 * Results are written to `<outputDir>/agent-models.json` as well as the
 * report. Nothing here changes `MODEL_ROUTING_TABLE`: a person reads the
 * numbers and makes that edit.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BenchContext, BenchModule, BenchResult, BenchRow, BenchSection } from '../lib/types'
import { fmtMs } from '../lib/stats'
import { log } from '../lib/log'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const FIXTURE_REL = 'studio-workspace/__canonical-fixture'

interface Brief {
  readonly id: 'creative' | 'match'
  readonly page: string
  readonly role: 'creative' | 'build'
  readonly fidelityMode: 'creative' | 'balanced'
  readonly text: string
}

const CREATIVE_BRIEF: Brief = {
  id: 'creative',
  page: 'BenchCreative',
  role: 'creative',
  fidelityMode: 'creative',
  text: 'Design a subscription checkout screen for a specialty coffee roaster, mobile width. Write it as a new page named BenchCreative (its .tsx and its .module.css) in this project\'s pages directory. Use real content, the project\'s own tokens and components, and finish it: look at it and typecheck it.',
}

const MATCH_BRIEF: Brief = {
  id: 'match',
  page: 'BenchMatch',
  role: 'build',
  fidelityMode: 'balanced',
  text: 'Rebuild the attached screen as a new page named BenchMatch (its .tsx and its .module.css) in this project\'s pages directory. Match it: measure it against the design with studio_compare until it passes, and typecheck it.',
}

interface RunOutcome {
  readonly model: string
  readonly brief: Brief['id']
  readonly ok: boolean
  readonly error?: string
  readonly durationMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly toolCalls: number
  readonly grade: Record<string, string | number | boolean>
}

function skipped(reason: string): BenchResult {
  return {
    name: 'agent-models',
    title: agentModelsBench.title,
    headline: { 'agent models': `skipped — ${reason}` },
    sections: [{ title: 'Skipped', rows: [{ label: 'agent-models', metrics: { reason } }] }],
  }
}

function freshCopy(source: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(source, dest, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) })
}

/** A grey fill in a stylesheet — the "grey placeholder box" the exit gate forbids. Crude on purpose, and reported as a heuristic. */
function greyFillCount(dir: string): number {
  const GREY = /background(?:-color)?\s*:\s*(#(?:c{3}|d{3}|e{3}|b{3}|9{3}|a{3})\b|#(?:cccccc|dddddd|eeeeee|bbbbbb|e5e5e5|e0e0e0|d9d9d9)\b|(?:light)?gr[ae]y\b)/gi
  let count = 0
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/Bench\w*\.module\.css$/.test(entry.name)) count += (readFileSync(full, 'utf8').match(GREY) ?? []).length
    }
  }
  walk(dir)
  return count
}

async function runOne(model: string, brief: Brief, projectsRoot: string, apiKey: string, reference: Uint8Array | null): Promise<RunOutcome> {
  const { resolveDriver } = await import('../../../server/ai/drivers')
  const { resolveModelCapabilities } = await import('../../../server/ai/drivers/modelCapabilities')
  const { selectStudioTools } = await import('../../../server/ai/tools')
  const { buildStudioProjectSystemPrompt } = await import('../../../server/ai/chatSystemPrompt')
  const { prepareStudioHttpTurn } = await import('../../../server/ai/studioHttpTurn')
  const { createTurnTelemetry } = await import('../../../server/ai/turnTelemetry')
  const { createDelegateRunner } = await import('../../../server/ai/delegation/delegateRunner')
  const { registerTurnDesignReferences } = await import('../../../server/handlers/studio/turnDesignReferences')
  const { CORE_CAPABILITIES } = await import('../../../src/core/capabilities')

  const dir = join(projectsRoot, `${model}-${brief.id}`)
  freshCopy(resolve(REPO_ROOT, FIXTURE_REL), dir)
  const conversationId = `bench-${model}-${brief.id}`
  const turnId = `${conversationId}-turn`
  const userId = 'bench'
  const capabilities = [...CORE_CAPABILITIES]
  const credentials = { id: 'bench', providerId: 'anthropic' as const, authMode: 'apiKey' as const, apiKey, baseUrl: null }
  const driver = resolveDriver('anthropic')
  const tools = selectStudioTools(capabilities, { studioProjectOpen: true, fileAccess: 'studio-tools' })
  if (reference) await registerTurnDesignReferences(dir, [reference])
  const systemPrompt = await buildStudioProjectSystemPrompt(dir, null, conversationId, tools, undefined, brief.text, brief.fidelityMode)
  prepareStudioHttpTurn(dir, { userId, conversationId, turnId })

  let childPrompt = 0
  let childCompletion = 0
  const noDb = new Proxy({}, { get: () => { throw new Error('The model bench has no database.') } })
  const toolContextBase = {
    db: noDb as never,
    userId,
    capabilities,
    conversationId,
    workspaceDir: dir,
    fidelityMode: brief.fidelityMode,
    turnId,
    snapshot: null,
    delegate: createDelegateRunner({
      driver, credentials, providerId: 'anthropic', conversationModelId: model, modelSource: 'chosen', systemPrompt, tools,
      recordUsage: async (usage) => { childPrompt += usage.promptTokens; childCompletion += usage.completionTokens },
    }),
  }
  const controller = new AbortController()
  const telemetry = createTurnTelemetry({
    dir, conversationId, providerId: 'anthropic', conversationModelId: model,
    route: { modelId: model, mode: 'pinned', role: brief.role, reason: 'bench:agent-models' },
    fidelityMode: brief.fidelityMode,
  })
  const content = [
    ...(reference ? [{ kind: 'image' as const, mimeType: 'image/png', data: Buffer.from(reference).toString('base64') }] : []),
    { kind: 'text' as const, text: brief.text },
  ]
  const startedAt = performance.now()
  let promptTokens = 0
  let completionTokens = 0
  let toolCalls = 0
  let error: string | undefined
  try {
    for await (const event of driver.stream({
      systemPrompt,
      messages: [{ role: 'user', content }],
      tools,
      modelId: model,
      modelCapabilities: await resolveModelCapabilities(driver, credentials, model),
      credentials,
      signal: controller.signal,
      bridge: { callBrowser: async (name) => ({ ok: false, error: `${name}: the model bench has no board.` }) },
      toolContextBase,
      workspaceDir: dir,
      fidelityMode: brief.fidelityMode,
    })) {
      telemetry.observe(event)
      if (event.type === 'usage') {
        promptTokens += event.promptTokens
        completionTokens += event.completionTokens
      } else if (event.type === 'toolResult') toolCalls += 1
      else if (event.type === 'error') error = event.message
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const durationMs = performance.now() - startedAt
  telemetry.finish({ promptTokens: promptTokens + childPrompt, completionTokens: completionTokens + childCompletion, aborted: false })

  const grade: Record<string, string | number | boolean> = {}
  const ctx = { ...toolContextBase, signal: controller.signal }
  if (brief.id === 'creative') {
    const quality = tools.find((tool) => tool.name === 'studio_quality_check')
    const out = quality?.handler ? await quality.handler({ pages: [brief.page] }, ctx).catch((err: unknown) => ({ ok: false, error: String(err) })) : null
    const first = (out as { results?: Array<{ ok?: boolean; findingCount?: number }> } | null)?.results?.[0]
    grade.qualityFindings = first?.ok ? first.findingCount ?? 0 : 'page not found'
    grade.greyFillsHeuristic = greyFillCount(dir)
  } else {
    const compare = tools.find((tool) => tool.name === 'studio_compare')
    const out = compare?.handler ? await compare.handler({ pages: [brief.page], includeImages: false }, ctx).catch((err: unknown) => ({ ok: false, error: String(err) })) : null
    const result = out as { pass?: boolean; results?: Array<{ similarityScore?: number }>; error?: string } | null
    grade.comparePass = result?.pass ?? false
    grade.similarity = result?.results?.[0]?.similarityScore ?? (result?.error ? 'compare failed' : 'n/a')
  }
  return { model, brief: brief.id, ok: error === undefined, ...(error ? { error: error.slice(0, 300) } : {}), durationMs, promptTokens: promptTokens + childPrompt, completionTokens: completionTokens + childCompletion, toolCalls, grade }
}

export const agentModelsBench: BenchModule = {
  name: 'agent-models',
  title: 'Agent models — real turns per candidate model (spends API credit)',
  description:
    'Runs the creative and match briefs as real API-key agent turns on every model in MODEL_BENCH_CANDIDATES and grades each (quality findings, grey-fill heuristic, studio_compare). Needs ANTHROPIC_API_KEY and STUDIO_BENCH_SPEND=1; skipped otherwise. STUDIO_BENCH_MATCH_REFERENCE=<png> enables the match brief.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return skipped('ANTHROPIC_API_KEY is not set')
    if (process.env.STUDIO_BENCH_SPEND !== '1') return skipped('set STUDIO_BENCH_SPEND=1 to run real, billed agent turns')
    if (!existsSync(resolve(REPO_ROOT, FIXTURE_REL))) return skipped(`${FIXTURE_REL} does not exist`)

    const referencePath = process.env.STUDIO_BENCH_MATCH_REFERENCE
    const reference = referencePath && existsSync(referencePath) ? new Uint8Array(readFileSync(referencePath)) : null
    const briefs = reference ? [CREATIVE_BRIEF, MATCH_BRIEF] : [CREATIVE_BRIEF]

    const { MODEL_BENCH_CANDIDATES } = await import('../../../server/ai/routing/modelRouting')
    const { readAgentTurnSummaries, summarizeTurnsByModel } = await import('../../../server/handlers/studio/agentTurnLog')

    // The tools resolve every project against the workspace root, so the
    // copies must live inside the root this run hands them.
    const projectsRoot = join(ctx.outputDir, 'agent-models-projects')
    mkdirSync(projectsRoot, { recursive: true })
    const priorRoot = process.env.STUDIO_WORKSPACE_DIR
    process.env.STUDIO_WORKSPACE_DIR = projectsRoot
    const outcomes: RunOutcome[] = []
    try {
      for (const model of MODEL_BENCH_CANDIDATES) {
        for (const brief of briefs) {
          log.step(`agent-models: ${model} × ${brief.id}`)
          outcomes.push(await runOne(model, brief, projectsRoot, apiKey, brief.id === 'match' ? reference : null))
        }
      }
    } finally {
      if (priorRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
      else process.env.STUDIO_WORKSPACE_DIR = priorRoot
    }

    writeFileSync(join(ctx.outputDir, 'agent-models.json'), JSON.stringify(outcomes, null, 2))
    const rows: BenchRow[] = outcomes.map((o) => ({
      label: `${o.model} · ${o.brief}`,
      inputs: { tools: o.toolCalls },
      metrics: {
        wall: fmtMs(o.durationMs),
        tokensIn: String(o.promptTokens),
        tokensOut: String(o.completionTokens),
        ...Object.fromEntries(Object.entries(o.grade).map(([k, v]) => [k, String(v)])),
        status: o.ok ? 'ok' : `error: ${o.error ?? ''}`,
      },
    }))
    const summaries = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readAgentTurnSummaries(join(projectsRoot, entry.name)))
    const byModel: BenchRow[] = summarizeTurnsByModel(summaries).map((s) => ({
      label: `${s.role} · ${s.model}`,
      inputs: { turns: s.turns },
      metrics: { p50: fmtMs(s.p50Ms), p95: fmtMs(s.p95Ms), tokensIn: String(s.p50PromptTokens), tokensOut: String(s.p50CompletionTokens), tools: String(s.p50ToolCalls), errorRate: `${Math.round(s.errorRate * 100)}%` },
    }))
    const sections: BenchSection[] = [
      {
        title: 'Real turns per model and brief',
        intro: 'One real API-key turn each. Grades: qualityFindings (studio_quality_check on the page; fewer is better), greyFillsHeuristic (grey backgrounds in the page stylesheet — a HEURISTIC for placeholder boxes, read the files before trusting it), comparePass/similarity (studio_compare against the supplied reference). Raw results: agent-models.json.',
        rows,
      },
      {
        title: 'Per (role, model), from the turn telemetry these runs wrote',
        intro: 'summarizeTurnsByModel over the kind:"turn" lines — the same table bench:agent-turn prints from real use. Subagent rows are studio_delegate children.',
        rows: byModel,
      },
    ]
    return {
      name: this.name,
      title: this.title,
      headline: { 'agent models': `${outcomes.length} real turns · ${outcomes.filter((o) => !o.ok).length} errored` },
      sections,
    }
  },
}
