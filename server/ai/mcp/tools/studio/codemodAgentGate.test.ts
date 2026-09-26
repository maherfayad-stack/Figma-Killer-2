/**
 * `studio_codemod` goes through the same agent write steps as the file tools
 * and `studio_apply_edits` (`agentWriteSupport.ts`'s `runAgentSourceEdits`).
 *
 * It used to call the AST codemods straight, outside the project write lock:
 * no agent write gate (a host-executed file, a hard-linked file), no content
 * check, no turn checkpoint, no turn log. So an agent could rewrite a file the
 * user must approve, change the bytes behind a hard link to a file outside the
 * project, and leave no record the user could revert (#277's review).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import { beginAgentCheckpointTurn, listAgentCheckpointTurns } from '../../../../handlers/studio/agentCheckpoints'
import { readTurnWriteLog } from '../../../../handlers/studio/turnWriteLog'
import type { ToolContext } from '../../../runtime/types'
import { studioEditMcpTools } from './editTools'

type Result = { ok: boolean; code?: string }

const USER_ID = 'u_codemod_gate'
const CONVERSATION = 'c-codemod'
const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-codemod-gate-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''

const PAGE = ['export default function Home() {', '  return <div>Hi</div>', '}', ''].join('\n')
const CARD = ['export function Card({ title }: { title: string }) {', '  return <div className="card">{title}</div>', '}', ''].join('\n')
const PAGE_WITH_CARD = [
  "import { Card } from '../components/Card'",
  'export default function Home() {',
  '  return <Card title="Hi" />',
  '}',
  '',
].join('\n')

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

async function codemod(input: Record<string, unknown>): Promise<Result> {
  const tool = studioEditMcpTools.find((t) => t.name === 'studio_codemod')
  if (!tool?.handler) throw new Error('studio_codemod not found')
  return (await tool.handler({ dir, ...input }, ctx())) as Result
}

function write(rel: string, contents: string): string {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
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
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('studio_codemod runs every write through the agent write steps', () => {
  it('refuses a host-executed file (.vscode/) with needs-user and leaves it byte-identical', async () => {
    const file = write('.vscode/Panel.tsx', PAGE)
    const result = await codemod({ verb: 'rename-tag', nodeId: '.vscode/Panel.tsx:2:11', tag: 'section' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('needs-user')
    expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
  })

  it('refuses a file with another hard link (possibly outside the project) and changes neither name', async () => {
    const file = write('pages/Home.tsx', PAGE)
    const outside = path.join(workspaceRoot, `outside-${path.basename(dir)}.tsx`)
    fs.linkSync(file, outside)
    try {
      const result = await codemod({ verb: 'rename-tag', nodeId: 'pages/Home.tsx:2:11', tag: 'section' })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('protected-path')
      expect(fs.readFileSync(file, 'utf8')).toBe(PAGE)
      expect(fs.readFileSync(outside, 'utf8')).toBe(PAGE)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('extract-component on a refused call site creates no new file', async () => {
    write('components/Card.tsx', CARD)
    write('.vscode/Panel.tsx', PAGE_WITH_CARD)
    const before = fs.readdirSync(path.join(dir, 'components')).sort()
    const result = await codemod({ verb: 'extract-component', nodeId: '.vscode/Panel.tsx:3:11' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('needs-user')
    expect(fs.readdirSync(path.join(dir, 'components')).sort()).toEqual(before)
  })

  it('records the written file in the turn log and the turn checkpoint', async () => {
    write('pages/Home.tsx', PAGE)
    const userKey = studioAgentUserKey(USER_ID)
    beginAgentCheckpointTurn(dir, userKey, { conversationId: CONVERSATION, turnId: 'turnCodemod' })

    const result = await codemod({ verb: 'rename-tag', nodeId: 'pages/Home.tsx:2:11', tag: 'section' })

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('<section>Hi</section>')
    expect(readTurnWriteLog(dir, userKey).map((entry) => entry.file)).toEqual(['pages/Home.tsx'])
    const files = listAgentCheckpointTurns(dir, userKey, CONVERSATION)[0]?.files ?? []
    expect(files.map((f) => [f.path, f.change, f.revertable])).toEqual([['pages/Home.tsx', 'modified', true]])
  })
})
