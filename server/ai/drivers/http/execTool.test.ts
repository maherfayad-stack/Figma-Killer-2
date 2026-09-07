/**
 * `executeAiTool`'s capability guard, for the case where the caller's
 * capability set never resolved.
 *
 * The ordinary positive/negative capability cases live in
 * `src/__tests__/agent/aiToolCapabilityGate.test.ts` (all three layers of the
 * gate together). This file covers the unresolved-set case specifically,
 * because its failure mode was a LIE rather than a refusal: with no guard,
 * `toolAllowedForCapabilities` reached `undefined.includes` for a gated tool,
 * the `TypeError` escaped `executeAiTool` (the capability check sits outside
 * its try), and `toolLoop.executeOneCall` reported it as "Browser tool
 * transport failed" — a permission problem presented as a dead browser bridge,
 * which sends whoever reads it to check a tab that was never involved.
 *
 * The fix normalises the set to `[]` rather than refusing everything, which is
 * why the last test here matters as much as the first two: an UNGATED tool
 * behaved correctly before (the `.includes` was never reached for one) and must
 * keep behaving correctly.
 */
import { describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { executeAiTool } from './execTool'
import type { AiBrowserBridge, AiTool } from '../../runtime/types'
import type { ToolContextBase } from '../types'

const noopBridge: AiBrowserBridge = {
  callBrowser: async () => ({ ok: true, data: { reached: 'browser' } }),
}

function serverTool(options: { gated: boolean; onRun: () => void }): AiTool {
  return {
    name: options.gated ? 'studio_apply_edits' : 'studio_list_pages',
    scope: 'shared',
    execution: 'server',
    description: 'test',
    inputSchema: Type.Object({}),
    ...(options.gated ? { mutates: true, requiredCapabilities: ['studio.write' as const] } : {}),
    handler: async () => {
      options.onRun()
      return { pages: [] }
    },
  }
}

/** A context whose `capabilities` never materialised — what a connector row with no resolved grant produces. */
function contextWithoutCapabilities(): ToolContextBase {
  return {
    db: {} as never,
    userId: 'u1',
    capabilities: undefined as never,
    conversationId: 'c1',
    snapshot: undefined,
  }
}

describe('executeAiTool with an unresolved capability set', () => {
  it('refuses a gated tool instead of throwing, so the loop cannot misreport it as a dead bridge', async () => {
    let handlerRan = false
    const out = await executeAiTool(
      serverTool({ gated: true, onRun: () => { handlerRan = true } }),
      {},
      noopBridge,
      new AbortController().signal,
      contextWithoutCapabilities(),
    )
    expect(out.ok).toBe(false)
    expect(handlerRan).toBe(false)
  })

  it('names the actual cause — an unresolved grant, not the browser connection', async () => {
    const out = await executeAiTool(
      serverTool({ gated: true, onRun: () => {} }),
      {},
      noopBridge,
      new AbortController().signal,
      contextWithoutCapabilities(),
    )
    expect(out.error).toContain('no resolved capability set')
    expect(out.error).toContain('Re-authorise the connector')
    // The old symptom, explicitly excluded: nothing here may blame the bridge.
    expect(out.error).not.toContain('transport')
    expect(out.error).not.toContain('browser tab')
  })

  it('never reaches the browser bridge for a gated browser-executed tool', async () => {
    let reachedBridge = false
    const browserTool: AiTool = {
      name: 'studio_upload_asset',
      scope: 'site',
      execution: 'browser',
      mutates: true,
      requiredCapabilities: ['studio.write'],
      description: 'test',
      inputSchema: Type.Object({}),
    }
    const out = await executeAiTool(
      browserTool,
      {},
      { callBrowser: async () => { reachedBridge = true; return { ok: true } } },
      new AbortController().signal,
      contextWithoutCapabilities(),
    )
    expect(out.ok).toBe(false)
    expect(reachedBridge).toBe(false)
  })

  it('leaves an UNGATED tool running exactly as before — the normalisation must not widen the refusal', async () => {
    let handlerRan = false
    const out = await executeAiTool(
      serverTool({ gated: false, onRun: () => { handlerRan = true } }),
      {},
      noopBridge,
      new AbortController().signal,
      contextWithoutCapabilities(),
    )
    expect(out.ok).toBe(true)
    expect(handlerRan).toBe(true)
  })
})
