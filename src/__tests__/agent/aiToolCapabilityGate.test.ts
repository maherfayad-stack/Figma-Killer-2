/**
 * AI tool capability gating — the fix for security finding #1
 * (docs/plans/2026-06-12-security-hardening.md): granting `ai.chat` must not
 * hand the model a blanket read of users, documents, drafts, and media.
 *
 * Three layers under test:
 *   1. `toolAllowedForCapabilities` — the single gate helper (both axes:
 *      `mutates` ⇒ `ai.tools.write`, plus ANY-OF `requiredCapabilities`).
 *   2. `selectStudioTools` — selection-time filtering (load-bearing gate:
 *      the tool loop only executes offered tools).
 *   3. `executeAiTool` — pre-dispatch re-check (defence in depth).
 */

import { describe, expect, it } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { toolAllowedForCapabilities } from '../../../server/ai/tools/capabilityGate'
import { selectStudioTools } from '../../../server/ai/tools'
import { executeAiTool } from '../../../server/ai/drivers/http/execTool'
import type { AiBrowserBridge, AiTool } from '../../../server/ai/runtime/types'
import type { CoreCapability } from '@core/capabilities'

function tool(partial: Partial<AiTool>): AiTool {
  return {
    name: 'x',
    description: 'x',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object({}),
    ...partial,
  }
}

const NONE: readonly CoreCapability[] = []

describe('toolAllowedForCapabilities', () => {
  it('allows a read tool with no requiredCapabilities for any caller', () => {
    expect(toolAllowedForCapabilities(tool({}), NONE)).toBe(true)
  })

  it('blocks a tool whose requiredCapabilities the caller lacks', () => {
    const t = tool({ requiredCapabilities: ['users.manage'] })
    expect(toolAllowedForCapabilities(t, ['media.read'])).toBe(false)
  })

  it('allows when the caller has ANY of the requiredCapabilities', () => {
    const t = tool({ requiredCapabilities: ['data.custom.tables.read', 'data.custom.tables.manage'] })
    expect(toolAllowedForCapabilities(t, ['data.custom.tables.manage'])).toBe(true)
  })

  it('blocks a mutating tool when the caller lacks ai.tools.write', () => {
    const t = tool({ mutates: true })
    expect(toolAllowedForCapabilities(t, NONE)).toBe(false)
  })

  it('allows a mutating tool when the caller has ai.tools.write and any requiredCapabilities', () => {
    const t = tool({ mutates: true, requiredCapabilities: ['content.manage'] })
    expect(toolAllowedForCapabilities(t, ['ai.tools.write', 'content.manage'])).toBe(true)
  })

  it('blocks a mutating tool with ai.tools.write but missing requiredCapabilities', () => {
    const t = tool({ mutates: true, requiredCapabilities: ['content.manage'] })
    expect(toolAllowedForCapabilities(t, ['ai.tools.write'])).toBe(false)
  })
})

describe('selectStudioTools capability filtering', () => {
  it('drops site_list_documents for a caller without site.read', () => {
    const names = selectStudioTools(['ai.chat']).map((t) => t.name)
    expect(names).not.toContain('site_list_documents')
  })

  it('keeps site_list_documents for a caller with site.read', () => {
    const names = selectStudioTools(['ai.chat', 'site.read']).map((t) => t.name)
    expect(names).toContain('site_list_documents')
  })

  it('drops structure-editing tools for a caller with only site.read', () => {
    const names = selectStudioTools(['ai.chat', 'ai.tools.write', 'site.read']).map((t) => t.name)
    expect(names).not.toContain('site_insert_html')
    expect(names).not.toContain('site_delete_node')
    // read tools stay — they only need site.read
    expect(names).toContain('site_read_document')
  })

  it('keeps structure-editing tools once site.structure.edit is granted', () => {
    const names = selectStudioTools([
      'ai.chat', 'ai.tools.write', 'site.read', 'site.structure.edit',
    ]).map((t) => t.name)
    expect(names).toContain('site_insert_html')
    expect(names).toContain('site_delete_node')
  })

  it('still filters write tools by ai.tools.write (existing behaviour preserved)', () => {
    const withoutWrite = selectStudioTools(['ai.chat', 'site.read', 'site.structure.edit'])
    expect(withoutWrite.every((t) => !t.mutates)).toBe(true)
    const withWrite = selectStudioTools([
      'ai.chat', 'ai.tools.write', 'site.read', 'site.structure.edit',
    ])
    expect(withWrite.some((t) => t.mutates)).toBe(true)
  })

  // WS-12 §3 — a turn against an open Studio project gets the real Studio
  // tools instead of the CMS site tools, chosen per-request from live
  // context (never a stored discriminator — WS-12 §8.1 D3).
  it('defaults to the CMS site toolset when no context is passed (existing single-arg callers unaffected)', () => {
    const names = selectStudioTools(['ai.chat'])
    expect(names.some((t) => t.name.startsWith('site_'))).toBe(true)
    expect(names.some((t) => t.name.startsWith('studio_'))).toBe(false)
  })

  it('returns the real Studio tools when studioProjectOpen is true', () => {
    const names = selectStudioTools(['ai.chat'], { studioProjectOpen: true }).map((t) => t.name)
    expect(names).toContain('studio_list_pages')
    expect(names).toContain('studio_project_profile')
    expect(names.some((n) => n.startsWith('site_'))).toBe(false)
  })

  it('offers only what the filesystem cannot do — the file-shaped tools are not part of the agent surface', () => {
    // The agent authors files with native Read/Write/Edit/Glob/Grep inside the
    // project cwd (`claudeCliToolSurface.ts`), so every tool that existed only
    // to work around not having a filesystem is strictly slower than the
    // native equivalent. They stay in the MCP registry for external clients
    // that genuinely cannot reach the project's files.
    const names = selectStudioTools(
      ['ai.chat', 'ai.tools.write', 'studio.write'],
      { studioProjectOpen: true },
    ).map((t) => t.name)
    for (const superseded of [
      'studio_read_file',
      'studio_list_files',
      'studio_create_page',
      'studio_apply_edits',
      'studio_codemod',
      'studio_find_nodes',
      'studio_get_node_source',
    ]) {
      expect(names).not.toContain(superseded)
    }
  })

  it('gates studio_screenshot behind ai.tools.write + studio.write, same posture as every other Studio write tool', () => {
    const withoutWrite = selectStudioTools(['ai.chat'], { studioProjectOpen: true })
    expect(withoutWrite.some((t) => t.name === 'studio_screenshot')).toBe(false)

    // ai.tools.write alone is not enough — every Studio write tool also
    // declares requiredCapabilities: ['studio.write'] (ANY-OF), a SEPARATE
    // axis from the mutates flag.
    const withOnlyToolsWrite = selectStudioTools(['ai.chat', 'ai.tools.write'], { studioProjectOpen: true })
    expect(withOnlyToolsWrite.some((t) => t.name === 'studio_screenshot')).toBe(false)

    const withBoth = selectStudioTools(['ai.chat', 'ai.tools.write', 'studio.write'], { studioProjectOpen: true })
    expect(withBoth.some((t) => t.name === 'studio_screenshot')).toBe(true)
  })

  it('offers the read-only orientation tools to a read-only caller (no requiredCapabilities)', () => {
    const names = selectStudioTools(['ai.chat'], { studioProjectOpen: true }).map((t) => t.name)
    expect(names).toContain('studio_list_pages')
    expect(names).toContain('studio_list_components')
  })
})

const noopBridge: AiBrowserBridge = {
  callBrowser: async () => ({ ok: false, error: 'no bridge' }),
}

describe('executeAiTool re-check', () => {
  it('refuses a server tool the caller lacks capabilities for, without running the handler', async () => {
    let handlerRan = false
    const gated = tool({
      name: 'content_list_users',
      requiredCapabilities: ['users.manage'],
      handler: async () => {
        handlerRan = true
        return { users: [] }
      },
    })
    const base = {
      db: {} as never,
      userId: 'u1',
      capabilities: ['ai.chat'] as readonly CoreCapability[],
      conversationId: 'c1',
      snapshot: undefined,
    }
    const out = await executeAiTool(gated, {}, noopBridge, new AbortController().signal, base)
    expect(out.ok).toBe(false)
    expect(handlerRan).toBe(false)
  })

  it('runs the handler when the caller holds a required capability', async () => {
    let handlerRan = false
    const gated = tool({
      name: 'content_list_users',
      requiredCapabilities: ['users.manage'],
      handler: async () => {
        handlerRan = true
        return { users: [] }
      },
    })
    const base = {
      db: {} as never,
      userId: 'u1',
      capabilities: ['ai.chat', 'users.manage'] as readonly CoreCapability[],
      conversationId: 'c1',
      snapshot: undefined,
    }
    const out = await executeAiTool(gated, {}, noopBridge, new AbortController().signal, base)
    expect(out.ok).toBe(true)
    expect(handlerRan).toBe(true)
  })
})
