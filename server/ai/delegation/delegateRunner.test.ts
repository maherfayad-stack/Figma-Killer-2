/**
 * `studio_delegate` and its runner (AI-23): the ownership rule is enforced on
 * the REAL write tools, a child is given only what it may use, children run
 * at the same time, and each one's model, usage and report come back.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../handlers/studioProjects'
import { readAgentTurnSummaries } from '../../handlers/studio/agentTurnLog'
import type { AiProvider, AiResolvedCredential, AiStreamRequest } from '../drivers/types'
import type { AiStreamEvent, AiTool, DelegateRunner, ToolContext } from '../runtime/types'
import { studioAgentFileWriteTools } from '../mcp/tools/studio/fileWriteTools'
import { studioDelegateTool } from '../mcp/tools/studio/delegateTool'
import { studioHttpAgentTools } from '../tools/studio'
import { childTools, createDelegateRunner, ownedWriteTool, type DelegateUsage } from './delegateRunner'

type Result = { ok: boolean; code?: string; [key: string]: unknown }

const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-delegate-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''

function write(rel: string, contents: string): void {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as never,
    userId: 'u_delegate',
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: 'c_delegate',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    ...overrides,
  }
}

beforeAll(() => {
  process.env.STUDIO_WORKSPACE_DIR = workspaceRoot
})
afterAll(() => {
  if (priorWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = priorWorkspaceDir
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
})
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(projectsRootDir(), 'proj-'))
  write('pages/Cart.tsx', 'export default function Cart() { return null }\n')
  write('i18n/en.json', '{}\n')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const writeFile = studioAgentFileWriteTools.find((tool) => tool.name === 'studio_write_file')!

describe('ownership is enforced on the real write tools', () => {
  it('a child writes its own page and stylesheet, and is refused not-owned anywhere else — the file is never touched', async () => {
    const written = new Set<string>()
    const tool = ownedWriteTool(writeFile, ['pages/Checkout.tsx', 'pages/Checkout.module.css'], written)

    const own = (await tool.handler!({ path: 'pages/Checkout.tsx', content: 'export default function Checkout() { return null }\n' }, ctx())) as Result
    expect(own.ok).toBe(true)
    const css = (await tool.handler!({ path: 'pages/Checkout.module.css', content: '.root {}\n' }, ctx())) as Result
    expect(css.ok).toBe(true)

    const shared = (await tool.handler!({ path: 'i18n/en.json', content: '{"x":1}\n' }, ctx())) as Result
    expect(shared).toMatchObject({ ok: false, code: 'not-owned' })
    expect(fs.readFileSync(path.join(dir, 'i18n', 'en.json'), 'utf8')).toBe('{}\n')

    const otherPage = (await tool.handler!({ path: 'pages/Cart.module.css', content: '.x {}\n' }, ctx())) as Result
    expect(otherPage).toMatchObject({ ok: false, code: 'not-owned' })
    expect(fs.existsSync(path.join(dir, 'pages', 'Cart.module.css'))).toBe(false)

    expect([...written].sort()).toEqual(['pages/Checkout.module.css', 'pages/Checkout.tsx'])
  })

  it('studio_edit_files is refused whole when any one edit leaves the child\'s files', async () => {
    const editFiles = studioAgentFileWriteTools.find((tool) => tool.name === 'studio_edit_files')!
    write('pages/Checkout.tsx', 'const a = 1\n')
    const tool = ownedWriteTool(editFiles, ['pages/Checkout.tsx', 'pages/Checkout.module.css'], new Set())
    const result = (await tool.handler!({ edits: [
      { path: 'pages/Checkout.tsx', oldString: 'const a = 1', newString: 'const a = 2' },
      { path: 'pages/Cart.tsx', oldString: 'return null', newString: 'return 1' },
    ] }, ctx())) as Result
    expect(result).toMatchObject({ ok: false, code: 'not-owned' })
    expect(fs.readFileSync(path.join(dir, 'pages', 'Checkout.tsx'), 'utf8')).toBe('const a = 1\n')
  })
})

describe('what a child is given', () => {
  it('observers and the three wrapped file writes — never another write, a bridge tool, or delegation', () => {
    const names = childTools(studioHttpAgentTools, ['pages/A.tsx'], new Set()).map((tool) => tool.name)
    expect(names).toContain('studio_write_file')
    expect(names).toContain('studio_edit_files')
    expect(names).toContain('studio_screenshot')
    expect(names).toContain('studio_typecheck')
    for (const withheld of ['studio_delegate', 'studio_set_tokens', 'studio_arrange_frames', 'studio_find_image', 'studio_install_deps', 'studio_page_diagnostics']) {
      expect(names).not.toContain(withheld)
    }
    const parent = new Map(studioHttpAgentTools.map((tool) => [tool.name, tool]))
    for (const tool of childTools(studioHttpAgentTools, ['pages/A.tsx'], new Set())) {
      if (tool.sideEffects === 'write') expect(['studio_write_file', 'studio_edit_file', 'studio_edit_files']).toContain(tool.name)
      expect(parent.get(tool.name)?.execution).not.toBe('bridge')
    }
  })
})

function fakeAnthropic(onStream: (req: AiStreamRequest) => AsyncIterable<AiStreamEvent>): { driver: AiProvider; credentials: AiResolvedCredential } {
  const caps = { toolCalling: true, visionInput: true, toolResultImages: true, promptCache: true, streaming: true }
  const driver = {
    id: 'anthropic',
    label: 'Anthropic',
    supportedAuthModes: ['apiKey'],
    capabilities: () => caps,
    listModels: async () => ['claude-opus-5-5', 'claude-sonnet-5'].map((id) => ({ id, label: id, catalogueSource: 'live', capabilities: caps })),
    stream: onStream,
  } as unknown as AiProvider
  return { driver, credentials: { id: `cred-${Math.random()}`, providerId: 'anthropic', authMode: 'apiKey', apiKey: 'k', baseUrl: null } }
}

describe('the runner', () => {
  it('runs every child at the same time, on the subagent model, and returns each report, usage and telemetry', async () => {
    const requests: AiStreamRequest[] = []
    let started = 0
    let releaseAll!: () => void
    const allStarted = new Promise<void>((resolve) => { releaseAll = resolve })
    const { driver, credentials } = fakeAnthropic((req) => (async function* () {
      requests.push(req)
      started += 1
      if (started === 2) releaseAll()
      // A sequential runner never starts the second child, so this never resolves.
      await Promise.race([allStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('children did not run concurrently')), 2_000))])
      yield { type: 'context', promptTokens: 50 } as AiStreamEvent
      yield { type: 'text', text: 'Thinking out loud.' } as AiStreamEvent
      yield { type: 'toolCall', toolCallId: 't1', toolName: 'studio_screenshot', input: {}, status: 'pending' } as AiStreamEvent
      yield { type: 'toolResult', toolCallId: 't1', toolName: 'studio_screenshot', ok: true } as AiStreamEvent
      yield { type: 'text', text: 'Built the page; it typechecks.' } as AiStreamEvent
      yield { type: 'usage', promptTokens: 1_000, completionTokens: 200 } as AiStreamEvent
    })())
    const usages: Array<{ usage: DelegateUsage; modelId: string }> = []
    const runner = createDelegateRunner({
      driver, credentials, providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', modelSource: 'default',
      systemPrompt: ['prefix', 'suffix'], tools: studioHttpAgentTools,
      recordUsage: async (usage, modelId) => { usages.push({ usage, modelId }) },
    })
    const results = await runner.run([
      { page: 'pages/A.tsx', owned: ['pages/A.tsx', 'pages/A.module.css'], brief: 'Build page A with a hero and a list.' },
      { page: 'pages/B.tsx', owned: ['pages/B.tsx', 'pages/B.module.css'], brief: 'Build page B with a form and a footer.' },
    ], ctx())

    expect(results.map((r) => ({ page: r.page, ok: r.ok, model: r.model, report: r.report, toolCalls: r.toolCalls }))).toEqual([
      { page: 'pages/A.tsx', ok: true, model: 'claude-sonnet-5', report: 'Built the page; it typechecks.', toolCalls: 1 },
      { page: 'pages/B.tsx', ok: true, model: 'claude-sonnet-5', report: 'Built the page; it typechecks.', toolCalls: 1 },
    ])
    expect(usages.map((u) => u.modelId)).toEqual(['claude-sonnet-5', 'claude-sonnet-5'])
    // Each child's prompt carries the contract naming only its own files; no child can delegate.
    expect(requests[0]!.systemPrompt.at(-1)).toContain('pages/A.tsx, pages/A.module.css')
    for (const req of requests) {
      expect(req.tools.map((t) => t.name)).not.toContain('studio_delegate')
      expect(req.toolContextBase.delegate).toBeUndefined()
      expect(req.maxToolRounds).toBeGreaterThan(0)
    }
    expect(readAgentTurnSummaries(dir).map((s) => ({ role: s.role, model: s.model }))).toEqual([
      { role: 'subagent', model: 'claude-sonnet-5' },
      { role: 'subagent', model: 'claude-sonnet-5' },
    ])
  })

  it('a conversation whose model the user picked keeps it for its subagents', async () => {
    const { driver, credentials } = fakeAnthropic(() => (async function* () {
      yield { type: 'text', text: 'done' } as AiStreamEvent
    })())
    const runner = createDelegateRunner({
      driver, credentials, providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', modelSource: 'chosen',
      systemPrompt: ['p'], tools: [], recordUsage: async () => {},
    })
    const [result] = await runner.run([{ page: 'pages/A.tsx', owned: ['pages/A.tsx'], brief: 'Build page A with care.' }], ctx())
    expect(result!.model).toBe('claude-opus-5-5')
  })

  it('a child that errors reports it, and the others still finish', async () => {
    const { driver, credentials } = fakeAnthropic((req) => (async function* () {
      if (String(req.messages[0]!.role === 'user' && JSON.stringify(req.messages[0])).includes('fail')) {
        yield { type: 'error', message: 'provider exploded' } as AiStreamEvent
        return
      }
      yield { type: 'text', text: 'fine' } as AiStreamEvent
    })())
    const runner = createDelegateRunner({ driver, credentials, providerId: 'anthropic', conversationModelId: 'claude-opus-5-5', modelSource: 'chosen', systemPrompt: ['p'], tools: [], recordUsage: async () => {} })
    const results = await runner.run([
      { page: 'pages/A.tsx', owned: ['pages/A.tsx'], brief: 'please fail at this one' },
      { page: 'pages/B.tsx', owned: ['pages/B.tsx'], brief: 'this one works fine' },
    ], ctx())
    expect(results[0]).toMatchObject({ ok: false, stopped: 'error', error: 'provider exploded' })
    expect(results[1]).toMatchObject({ ok: true, report: 'fine' })
  })
})

describe('studio_delegate', () => {
  function recordingRunner(): { runner: DelegateRunner; seen: unknown[] } {
    const seen: unknown[] = []
    return { seen, runner: { run: async (tasks) => { seen.push(tasks); return [] } } }
  }

  it('gives each task its page and that page\'s stylesheet, and nothing else', async () => {
    const { runner, seen } = recordingRunner()
    const result = (await studioDelegateTool.handler!({ tasks: [{ page: 'pages/Checkout.tsx', brief: 'Build the checkout page in full.' }] }, ctx({ delegate: runner }))) as Result
    expect(result.ok).toBe(true)
    expect(seen).toEqual([[{ page: 'pages/Checkout.tsx', owned: ['pages/Checkout.tsx', 'pages/Checkout.module.css'], brief: 'Build the checkout page in full.' }]])
  })

  it('refuses two tasks on one page before anything runs', async () => {
    const { runner, seen } = recordingRunner()
    const result = (await studioDelegateTool.handler!({ tasks: [
      { page: 'pages/Checkout.tsx', brief: 'Build the checkout page in full.' },
      { page: 'pages/checkout.tsx', brief: 'Build the checkout page again.' },
    ] }, ctx({ delegate: runner }))) as Result
    expect(result).toMatchObject({ ok: false, code: 'overlapping-ownership' })
    expect(seen).toEqual([])
  })

  it('refuses a non-page file, a path outside the project, and a call with no runner', async () => {
    const { runner } = recordingRunner()
    expect(await studioDelegateTool.handler!({ tasks: [{ page: 'i18n/en.json', brief: 'Translate every key please.' }] }, ctx({ delegate: runner }))).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(await studioDelegateTool.handler!({ tasks: [{ page: '../x/pages/A.tsx', brief: 'Build page A somewhere else.' }] }, ctx({ delegate: runner }))).toMatchObject({ ok: false, code: 'path-outside-project' })
    expect(await studioDelegateTool.handler!({ tasks: [{ page: 'pages/A.tsx', brief: 'Build page A with no runner.' }] }, ctx())).toMatchObject({ ok: false, code: 'delegation-unavailable' })
  })

  it('is write-gated and a write to the loop, and is offered on the HTTP surface only', () => {
    expect(studioDelegateTool).toMatchObject({ requiresWrite: true, requiredCapabilities: ['studio.write'], sideEffects: 'write', execution: 'server' })
    expect(studioHttpAgentTools.map((tool: AiTool) => tool.name)).toContain('studio_delegate')
  })
})
