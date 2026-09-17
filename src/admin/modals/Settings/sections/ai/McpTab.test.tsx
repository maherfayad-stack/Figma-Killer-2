import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

// `mock.module` is process-wide and PERMANENT — `mock.restore()` does not undo
// it, and `bun test --parallel=4` gives each worker a process, not a file. The
// replacement below publishes three of `@admin/ai/api`'s exports; without the
// `afterAll` restore every later file in the worker sees only those three.
// Snapshot the real namespace as a plain object BEFORE mocking (the namespace
// object itself is live and gets rewritten). Gated by
// `mock-module-must-restore.test.ts`.
const realAiApi = { ...(await import('../../../../ai/api')) }

afterAll(() => {
  mock.module('../../../../ai/api', () => realAiApi)
})

mock.module('../../../../ai/api', () => ({
  ...realAiApi,
  listMcpConnectors: async () => [],
  createMcpConnector: async () => ({
    connector: {
      id: 'c1', label: 'L', type: 'local', authMode: 'bearer',
      capabilities: ['ai.chat'], createdAt: '', lastUsedAt: null, revoked: false,
      expiresAt: null,
    },
    token: 'imcp_test',
  }),
  revokeMcpConnector: async () => {},
}))

const { McpTab } = await import('./McpTab')

afterEach(() => cleanup())

describe('McpTab', () => {
  it('renders the empty state and an add action', async () => {
    render(<McpTab />)
    expect(await screen.findByRole('button', { name: /add connector/i })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/No connectors yet/i)).toBeTruthy()
    })
  })
})
