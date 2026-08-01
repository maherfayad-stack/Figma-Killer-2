import { describe, expect, it, beforeEach } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { resolveBridgeToolResult } from '../runtime'
import { buildMcpServer } from './server'
import { createEditorBridgeStream } from './editorBridge'
import { registerPermissionGate } from './permissionGate'

const decoder = new TextDecoder()

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { type: string; [key: string]: unknown }) => boolean,
): Promise<{ type: string; [key: string]: unknown }> {
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) throw new Error('stream ended before predicate matched')
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const event = JSON.parse(trimmed)
      if (predicate(event)) return event
    }
  }
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

async function connectClient(
  db: DbClient,
  capabilities: Parameters<typeof buildMcpServer>[0]['capabilities'],
  userId = 'u1',
) {
  const server = buildMcpServer({ db, userId, connectorId: 'c1', capabilities })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientT)
  return client
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

describe('mcp server', () => {
  it('lists tools filtered by capability (no write tools without ai.tools.write)', async () => {
    // Read-only: site + data reads, but NO ai.tools.write.
    const client = await connectClient(db, ['ai.chat', 'site.read', 'data.system.tables.read'])
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('site_read_styles') // headless design-system read
    // Write tools are gated out (MCP Tool exposes no `mutates` flag, so assert by name).
    expect(names).not.toContain('site_insert_html')
    expect(names).not.toContain('site_delete_node')
    expect(names).not.toContain('site_apply_css')
    await client.close()
  })

  it('lists browser editing tools but errors with an open-editor hint when no editor is connected', async () => {
    const client = await connectClient(db, ['ai.chat', 'ai.tools.write', 'site.structure.edit'])
    const { tools } = await client.listTools()
    expect(tools.some((t) => t.name === 'site_insert_html')).toBe(true) // browser tool is listed
    expect(tools.some((t) => t.name === 'site_delete_node')).toBe(true)

    const result = await client.callTool({ name: 'site_insert_html', arguments: { html: '<p>hi</p>' } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toContain('Site editor')
    await client.close()
  })

  it('routes Site browser tools to the Site workspace bridge', async () => {
    const userId = 'u1-scoped-workspace'
    const siteCtrl = new AbortController()
    const siteReader = createEditorBridgeStream(userId, 'site', siteCtrl.signal).getReader()
    const siteReady = await readUntil(siteReader, (event) => event.type === 'bridgeReady')

    const client = await connectClient(
      db,
      ['ai.chat', 'ai.tools.write', 'site.structure.edit'],
      userId,
    )

    const siteCall = client.callTool({
      name: 'site_insert_html',
      arguments: { parentId: 'root', html: '<p>site</p>' },
    })
    const siteRequest = await readUntil(siteReader, (event) => event.type === 'toolRequest')
    expect(siteRequest.toolName).toBe('site_insert_html')
    resolveBridgeToolResult(siteReady.bridgeId as string, siteRequest.requestId as string, {
      ok: true,
      data: { inserted: 1 },
    })
    expect((await siteCall).isError).toBeFalsy()

    await client.close()
    siteCtrl.abort()
    await siteReader.read().catch(() => {})
  })

  it('returns an MCP tool error when the live editor bridge disconnects mid-call', async () => {
    const userId = 'u1-disconnected-workspace'
    const controller = new AbortController()
    const reader = createEditorBridgeStream(userId, 'site', controller.signal).getReader()
    await readUntil(reader, (event) => event.type === 'bridgeReady')
    const client = await connectClient(
      db,
      ['ai.chat', 'ai.tools.write', 'site.structure.edit'],
      userId,
    )

    const call = client.callTool({
      name: 'site_insert_html',
      arguments: { parentId: 'root', html: '<p>site</p>' },
    })
    await readUntil(reader, (event) => event.type === 'toolRequest')
    controller.abort()

    const result = await call
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('before tool result arrived')

    await client.close()
    await reader.read().catch(() => {})
  })

  it('does not expose the removed headless page-tree tools', async () => {
    const client = await connectClient(db, ['ai.chat', 'ai.tools.write', 'site.structure.edit'])
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('read_page_tree')
    expect(names).not.toContain('mutate_page_tree')
    await client.close()
  })
})

describe('mcp server — permission gate exposure', () => {
  it('does not advertise permission_request to a connector with no gate', async () => {
    // Every external MCP client (Claude Code, Codex, a remote agent) is this
    // case: they never register a gate, so the tool is invisible to them.
    const client = await connectClient(db, ['ai.chat'])

    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name)).not.toContain('permission_request')
  })

  it('refuses to CALL permission_request without a live gate, rather than prompting nobody', async () => {
    const client = await connectClient(db, ['ai.chat'])

    const result = await client.callTool({ name: 'permission_request', arguments: { tool_name: 'Read', input: {} } })

    expect(result.isError).toBe(true)
  })

  it('advertises it to the connector that registered a gate, and relays the answer', async () => {
    let asked: { toolName: string; input: unknown } | null = null
    const release = registerPermissionGate('c1', {
      callBrowser: async (toolName, input) => {
        asked = { toolName, input }
        return { ok: true, data: { behavior: 'allow' } }
      },
    })
    try {
      const client = await connectClient(db, ['ai.chat'])

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('permission_request')

      const result = await client.callTool({
        name: 'permission_request',
        arguments: { tool_name: 'Read', input: { file_path: '/outside/x.txt' } },
      })

      const content = result.content as Array<{ type: string; text: string }>
      expect(JSON.parse(content[0].text)).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/outside/x.txt' },
      })
      expect(asked).not.toBeNull()
    } finally {
      release()
    }
  })
})
