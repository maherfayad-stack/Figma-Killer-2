/**
 * `studio_upload_asset` — dispatched through `executeAgentTool`, the SAME entry
 * point production uses for both the in-process chat loop and the MCP browser
 * bridge.
 *
 * This suite used to cover three tools. W9-6 moved `studio_set_frame_axes` and
 * `studio_duplicate_frame_as_variant` server-side, where they write
 * `.studio/boards.json` directly — `server/ai/mcp/tools/studio/frameAxesTools.test.ts`
 * covers them against a real fixture project now, which is a stronger test than
 * this one was: it asserts on the FILE, not on a store copy of it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { executeAgentTool } from '@site/agent'
import { useAdminUi } from '@admin/state/adminUi'
import type { AiToolOutput } from '@core/ai'
import '@modules/base'

function expectError(result: AiToolOutput): string {
  expect(result.ok).toBe(false)
  expect(result.error).toBeTruthy()
  return result.error!
}

describe('studio_upload_asset', () => {
  afterEach(() => {
    useAdminUi.setState({ studioProject: null })
  })

  it('refuses when no Studio project is open — never guesses a target dir', async () => {
    useAdminUi.setState({ studioProject: null })
    const result = await executeAgentTool('studio_upload_asset', {
      imageBase64: 'AAAA',
      mimeType: 'image/png',
    })
    expect(expectError(result)).toContain('No Studio project is open')
  })

  it('refuses malformed base64 before ever attempting a network call', async () => {
    useAdminUi.setState({ studioProject: { dir: '/tmp/fake-project', name: 'fixture' } })
    const result = await executeAgentTool('studio_upload_asset', {
      // Not valid base64 (odd-length run of characters atob rejects).
      imageBase64: '!!!not-base64!!!',
      mimeType: 'image/png',
    })
    expect(expectError(result)).toContain('not valid base64')
  })
})
