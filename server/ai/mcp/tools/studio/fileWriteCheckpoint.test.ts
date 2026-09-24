/**
 * AI-7 on the HTTP-driver path: Studio's own file tools bracket every write
 * with the turn's pre- and post-image, so the user can revert what an API-key
 * turn wrote exactly as they can a CLI turn's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import {
  beginAgentCheckpointTurn,
  listAgentCheckpointTurns,
  revertAgentCheckpoint,
} from '../../../../handlers/studio/agentCheckpoints'
import type { ToolContext } from '../../../runtime/types'
import { studioAgentFileWriteTools } from './fileWriteTools'
import { contentHash } from '../../../../handlers/studio/agentFileAccess'

const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-file-checkpoint-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
const USER_ID = 'u_checkpoint'
const CONVERSATION = 'conv-http'
let dir = ''

function ctx(): ToolContext {
  return {
    db: {} as never,
    userId: USER_ID,
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: CONVERSATION,
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
  }
}

async function call(name: string, input: unknown): Promise<{ ok: boolean; [key: string]: unknown }> {
  const found = studioAgentFileWriteTools.find((t) => t.name === name)!
  return (await found.handler!(input, ctx())) as { ok: boolean }
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
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages', 'Home.tsx'), 'export default function Home() {\n  return <p>Hi</p>\n}\n')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('HTTP file tools take a checkpoint', () => {
  it('studio_edit_file + studio_write_file: listed, and Revert turn restores both byte-identically', async () => {
    const userKey = studioAgentUserKey(USER_ID)
    const before = fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'))
    beginAgentCheckpointTurn(dir, userKey, { conversationId: CONVERSATION, turnId: 'turnHttp' })

    expect((await call('studio_edit_file', { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' })).ok).toBe(true)
    expect((await call('studio_write_file', { path: 'pages/Home.module.css', content: '.hero { color: red; }\n' })).ok).toBe(true)

    const files = listAgentCheckpointTurns(dir, userKey, CONVERSATION)[0]!.files
    expect(files.map((f) => [f.path, f.change, f.revertable])).toEqual([
      ['pages/Home.module.css', 'created', true],
      ['pages/Home.tsx', 'modified', true],
    ])

    expect((await revertAgentCheckpoint(dir, userKey, 'turnHttp')).ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx')).equals(before)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pages', 'Home.module.css'))).toBe(false)
  })

  it('studio_edit_files (atomic batch) is one checkpoint entry per file', async () => {
    const userKey = studioAgentUserKey(USER_ID)
    fs.writeFileSync(path.join(dir, 'pages', 'A.css'), '.a{}\n')
    beginAgentCheckpointTurn(dir, userKey, { conversationId: CONVERSATION, turnId: 'turnBatch' })
    const result = await call('studio_edit_files', {
      edits: [
        { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hey', expectedHash: contentHash(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'))) },
        { path: 'pages/A.css', oldString: '.a{}', newString: '.a{color:red}' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(listAgentCheckpointTurns(dir, userKey, CONVERSATION)[0]!.files.map((f) => f.path)).toEqual(['pages/A.css', 'pages/Home.tsx'])
  })
})
