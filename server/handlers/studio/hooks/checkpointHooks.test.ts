/**
 * AI-7 on the `claude` CLI path: the `PreToolUse` hook takes the pre-image,
 * the `PostToolUse` hook the post-image, both genuinely SPAWNED the way the
 * CLI runs them (see `hooks.test.ts`'s module doc for why a spawn, not an
 * import). The turn and the conversation reach the hooks the only ways they
 * can: the conversation through the environment `claudeCli.ts` sets, the turn
 * through the checkpoint's own `current-<conversation>.json`.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { STUDIO_AGENT_USER_KEY_ENV } from '../agentUserScope'
import {
  STUDIO_AGENT_CONVERSATION_KEY_ENV,
  beginAgentCheckpointTurn,
  conversationCheckpointKey,
  listAgentCheckpointTurns,
  revertAgentCheckpoint,
} from '../agentCheckpoints'

const USER = 'a1b2c3d4e5f60718'
const CONVERSATION = 'conv-cli'
const SPAWN_TIMEOUT_MS = 30_000
const DENY_SCRIPT = path.join(import.meta.dir, 'denyControlPlaneWrite.ts')
const RECORD_SCRIPT = path.join(import.meta.dir, 'recordToolWrite.ts')

async function run(script: string, stdin: unknown, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn([process.execPath, script], {
    stdin: new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return proc.exited
}

describe('checkpoint hooks (spawned)', () => {
  it('a native Write is bracketed by a pre- and post-image, and Revert turn puts the file back', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-checkpoint-hooks-')))
    try {
      const file = path.join(dir, 'pages', 'Home.tsx')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'before\n')
      beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
      const env = {
        [STUDIO_AGENT_USER_KEY_ENV]: USER,
        [STUDIO_AGENT_CONVERSATION_KEY_ENV]: conversationCheckpointKey(CONVERSATION),
      }
      const payload = { tool_name: 'Write', tool_input: { file_path: file, content: 'after\n' }, cwd: dir }

      expect(await run(DENY_SCRIPT, { hook_event_name: 'PreToolUse', ...payload }, env)).toBe(0)
      fs.writeFileSync(file, 'after\n') // the CLI's own Write
      expect(await run(RECORD_SCRIPT, { hook_event_name: 'PostToolUse', ...payload }, env)).toBe(0)

      const turns = listAgentCheckpointTurns(dir, USER, CONVERSATION)
      expect(turns[0]!.files).toEqual([
        { path: 'pages/Home.tsx', change: 'modified', state: 'current', revertable: true, reason: null, added: 1, removed: 1 },
      ])
      expect(await revertAgentCheckpoint(dir, USER, CONVERSATION, 'turn1')).toEqual({ ok: true, reverted: ['pages/Home.tsx'] })
      expect(fs.readFileSync(file, 'utf8')).toBe('before\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT_MS * 2)

  it('a write the gate refuses takes no pre-image', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-checkpoint-hooks-')))
    try {
      beginAgentCheckpointTurn(dir, USER, { conversationId: CONVERSATION, turnId: 'turn1' })
      const env = {
        [STUDIO_AGENT_USER_KEY_ENV]: USER,
        [STUDIO_AGENT_CONVERSATION_KEY_ENV]: conversationCheckpointKey(CONVERSATION),
      }
      const target = path.join(dir, '.studio', 'meta.json')
      const exit = await run(DENY_SCRIPT, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target }, cwd: dir }, env)
      expect(exit).toBe(2)
      const filesDir = path.join(dir, '.studio', 'agent-checkpoints', USER, 'turn1', 'files')
      expect(fs.readdirSync(filesDir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT_MS)
})
