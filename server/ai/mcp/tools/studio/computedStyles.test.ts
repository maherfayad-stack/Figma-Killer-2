/**
 * `studio_computed_styles` — the ROUTING decision W9-6 introduced: headless
 * first, the user's open tab only as the fallback, and a both-paths failure
 * that names BOTH reasons instead of blaming a missing board.
 *
 * The read itself is covered twice already — against a real document in
 * `src/core/studio-capture/frameInspector.test.ts`, and across the wire in
 * `server/ai/mcp/capture/headlessFrameInspect.test.ts`. What is under test
 * here is only what this file decides: which path answers, what the result
 * says about that, and what happens when neither can.
 *
 * The old behaviour this pins against: the tool used to be
 * `execution: 'bridge'` with no handler at all, so a project with no tab open
 * spent ~8s in the bridge and then refused.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiBrowserBridge } from '../../../runtime/types'
import type { AiToolOutput } from '@core/ai'
import type { AgentComputedStylesResult } from '@core/studio-capture'

const HEADLESS_RESULT: AgentComputedStylesResult = {
  kind: 'computedStyles',
  pageId: 'checkout',
  nodeCount: 1,
  truncated: false,
  fontFamiliesInUse: ['Open Sans'],
  nodes: [{
    nodeId: 'title',
    tag: 'h1',
    text: 'Checkout',
    fontFamily: 'Open Sans',
    fontSizePx: 26,
    lineHeightPx: 36,
    fontWeight: '600',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    rect: { width: 320, height: 34 },
  }],
}

let headlessImpl: () => Promise<unknown> = async () => ({ ok: true, result: HEADLESS_RESULT })
let bridgeImpl: ((toolName: string, input: unknown) => Promise<AiToolOutput>) | null = null
let bridgeCalls: Array<{ toolName: string; input: unknown }> = []

// Snapshotted as plain objects BEFORE mocking (a live namespace object is
// itself rewritten by `mock.module`), and handed back in `afterAll` below.
// `mock.module` is process-wide and PERMANENT — `mock.restore()` does not undo
// it, and `bun test --parallel=4` gives each worker a process, not a file, so
// without this every later file in the worker gets this file's stubs (or, for
// an export the replacement omits, a link-time `SyntaxError` that takes the
// whole file down). Gated by `mock-module-must-restore.test.ts`.
const realHeadlessFrameInspect = { ...(await import('../../capture/headlessFrameInspect')) }
const realEditorBridge = { ...(await import('../../editorBridge')) }

afterAll(() => {
  mock.module('../../capture/headlessFrameInspect', () => realHeadlessFrameInspect)
  mock.module('../../editorBridge', () => realEditorBridge)
})

// Spread over the REAL namespace, never a bare object literal: `mock.module`
// replaces the whole module, so an export the factory omits simply stops
// existing — and a static `import { editorBridgeScope }` elsewhere in the
// graph then fails to LINK, taking the importing file down with
// `SyntaxError: Export named 'editorBridgeScope' not found`. That is exactly
// what this file did before: it reported `0 pass / 1 error` in isolation.
// Spreading the snapshot keeps every other export real and overrides only
// what the test actually doubles.
mock.module('../../capture/headlessFrameInspect', () => ({
  ...realHeadlessFrameInspect,
  inspectFrameHeadless: async () => headlessImpl(),
}))

mock.module('../../editorBridge', () => ({
  ...realEditorBridge,
  awaitEditorBridgeForUser: async (): Promise<AiBrowserBridge | null> => {
    if (!bridgeImpl) return null
    return {
      callBrowser: async (toolName: string, input: unknown) => {
        bridgeCalls.push({ toolName, input })
        return bridgeImpl!(toolName, input)
      },
    } as AiBrowserBridge
  },
}))

const { studioComputedStylesMcpTools } = await import('./computedStyles')
const tool = studioComputedStylesMcpTools.find((t) => t.name === 'studio_computed_styles')!

/**
 * A project dir INSIDE the suite's workspace root, not the literal
 * `'/tmp/project'` this used to pass. `resolveProjectDir` containment-checks
 * every `dir` against `projectsRootDir()`, which `src/__tests__/setup.ts`
 * pins to `os.tmpdir()` for the whole suite — and on win32 `resolve('/tmp/project')`
 * is `C:\tmp\project`, which is NOT under `%TEMP%`. Every routing test below
 * therefore threw `ProjectDirOutsideWorkspaceError` on Windows and passed on
 * Linux, where `/tmp/project` happens to sit under `/tmp`.
 */
const WORKSPACE_DIR = join(tmpdir(), 'studio-computed-styles-project')

function ctx() {
  return {
    userId: 'u1',
    capabilities: [],
    conversationId: 'c1',
    workspaceDir: WORKSPACE_DIR,
    snapshot: null,
    signal: new AbortController().signal,
    db: undefined,
  } as never
}

const HEADLESS_DOWN = async () => ({
  ok: false,
  code: 'headless-browser-unavailable',
  error: 'No Chromium available in this test environment.',
})

afterEach(() => {
  headlessImpl = async () => ({ ok: true, result: HEADLESS_RESULT })
  bridgeImpl = null
  bridgeCalls = []
})

describe('studio_computed_styles routing', () => {
  it('runs in-process with the tab as a FALLBACK — a relayed tool has no handler to call at all', () => {
    // A11: the value says "headless first, open tab only if that cannot run",
    // which is also what the system prompt's live-tab sentence is generated
    // from. Reverting it to `bridge` would put this tool back on the prompt's
    // "needs the open board" list, which is the exact claim `mcp-20` made false.
    expect(tool.execution).toBe('server-with-bridge-fallback')
    expect(tool.handler).toBeDefined()
  })

  it('answers headlessly, with no bridge touched, and says so', async () => {
    const out = (await tool.handler!({ pageId: 'checkout' }, ctx())) as {
      ok: boolean
      data: { readVia: string; nodeCount: number; dir: string }
    }
    expect(out.ok).toBe(true)
    expect(out.data.readVia).toBe('headless')
    expect(out.data.nodeCount).toBe(1)
    expect(bridgeCalls).toEqual([])
  })

  it('falls back to the open tab when the headless browser cannot run, and names why', async () => {
    headlessImpl = HEADLESS_DOWN
    bridgeImpl = async () => ({ ok: true, data: HEADLESS_RESULT })

    const out = (await tool.handler!({ pageId: 'checkout', textOnly: false, limit: 5 }, ctx())) as {
      ok: boolean
      data: { readVia: string; headlessFallbackReason: string }
    }
    expect(out.ok).toBe(true)
    expect(out.data.readVia).toBe('live')
    expect(out.data.headlessFallbackReason).toContain('No Chromium')
    expect(bridgeCalls).toHaveLength(1)
    expect(bridgeCalls[0]!.toolName).toBe('studio_computed_styles')
    // `dir` is a SERVER-side concern; relaying it to a tab that already knows
    // which project it has open would be meaningless there.
    expect(bridgeCalls[0]!.input).toEqual({ pageId: 'checkout', textOnly: false, limit: 5 })
  })

  it('names BOTH failures when neither path can answer', async () => {
    headlessImpl = HEADLESS_DOWN
    bridgeImpl = null

    const out = (await tool.handler!({ pageId: 'checkout' }, ctx())) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('No Chromium')
    expect(out.error).toContain('no Studio board is connected')
    // The actionable half a single "open a tab" message used to hide.
    expect(out.error).toContain('playwright install chromium')
  })

  it('refuses a tab result it cannot validate rather than passing it through', async () => {
    headlessImpl = HEADLESS_DOWN
    bridgeImpl = async () => ({ ok: true, data: { nodes: 'not an array' } })

    const out = (await tool.handler!({ pageId: 'checkout' }, ctx())) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('could not validate')
  })

  it('passes a failed tab result through untouched — its message is already the honest one', async () => {
    headlessImpl = HEADLESS_DOWN
    bridgeImpl = async () => ({ ok: false, error: 'No live frame for page "checkout".' })

    const out = (await tool.handler!({ pageId: 'checkout' }, ctx())) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toBe('No live frame for page "checkout".')
  })
})
