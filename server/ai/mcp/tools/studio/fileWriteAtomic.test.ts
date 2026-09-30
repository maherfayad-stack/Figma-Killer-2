/**
 * The HTTP file tools replace an existing file in one step (security review of
 * #233, F5): the new text lands in a fresh file that is renamed over the old
 * one, so a reader or a crash between truncate and write never sees an empty
 * module. Observed as the file's identity: a truncate-and-write keeps the old
 * file (same inode / file index), a swap gives a new one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { contentHash } from '../../../../handlers/studio/agentFileAccess'
import type { ToolContext } from '../../../runtime/types'
import { studioAgentFileWriteTools } from './fileWriteTools'

type Result = { ok: boolean; code?: string; [key: string]: unknown }

const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-file-atomic-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''

const ORIGINAL = 'export default function Home() {\n  return <div className="hero">Hi</div>\n}\n'

async function call(name: string, input: unknown): Promise<Result> {
  const found = studioAgentFileWriteTools.find((t) => t.name === name)
  if (!found?.handler) throw new Error(`tool not found: ${name}`)
  const ctx: ToolContext = {
    db: {} as never,
    userId: 'u_atomic',
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
  }
  return (await found.handler(input, ctx)) as Result
}

const file = (): string => path.join(dir, 'pages', 'Home.tsx')

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
  fs.writeFileSync(file(), ORIGINAL)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('an existing file is swapped, never truncated in place', () => {
  for (const [name, input] of [
    ['studio_edit_file', { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello', expectedHash: contentHash(ORIGINAL) }],
    ['studio_edit_files', { edits: [{ path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello', expectedHash: contentHash(ORIGINAL) }] }],
    ['studio_write_file', { path: 'pages/Home.tsx', content: ORIGINAL.replace('Hi', 'Hello'), expectedHash: contentHash(ORIGINAL) }],
  ] as const) {
    it(name, async () => {
      const before = fs.statSync(file(), { bigint: true }).ino
      const result = await call(name, input)
      expect(result.ok).toBe(true)
      expect(fs.readFileSync(file(), 'utf8')).toContain('Hello')
      expect(fs.statSync(file(), { bigint: true }).ino).not.toBe(before)
      // No temp file left beside it.
      expect(fs.readdirSync(path.join(dir, 'pages'))).toEqual(['Home.tsx'])
    })
  }
})
