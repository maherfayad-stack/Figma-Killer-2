/**
 * `studio_apply_edits` goes through the same agent write steps as the file
 * tools (`agentWriteSupport.ts`'s `runAgentSourceEdits`), for every edit kind.
 *
 * It used to call the edit engine straight: no agent write gate, no content
 * check, no turn log, no checkpoint. So a batch could land a Tailwind
 * `@plugin` directive — which makes the next build load a module in Node on
 * the user's machine — without the user, and the turn left no record of the
 * files it changed (review of #269).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import { readTurnWriteLog } from '../../../../handlers/studio/turnWriteLog'
import type { ToolContext } from '../../../runtime/types'
import { studioEditMcpTools } from './editTools'

type Refusal = { nodeId: string; reason: string; message: string }
type Result = { ok: boolean; written?: number; refusals?: Refusal[] }

const USER_ID = 'u_apply_edits_gate'
const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-apply-edits-gate-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''

const STYLES = '.hero {\n  color: red;\n}\n'

function ctx(): ToolContext {
  return {
    db: {} as never,
    userId: USER_ID,
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: 'c-apply-edits',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
  }
}

async function applyEdits(edits: unknown[]): Promise<Result> {
  const tool = studioEditMcpTools.find((t) => t.name === 'studio_apply_edits')
  if (!tool?.handler) throw new Error('studio_apply_edits not found')
  return (await tool.handler({ dir, edits }, ctx())) as Result
}

const readStyles = (): string => fs.readFileSync(path.join(dir, 'src', 'app.css'), 'utf8')

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
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.css'), STYLES)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('studio_apply_edits runs every write through the agent write steps', () => {
  it('refuses an edit that adds a Tailwind @plugin with needs-user, and writes none of it', async () => {
    // A declaration value is written verbatim, so this lands as a real
    // top-level `@plugin` the next time the stylesheet is parsed.
    const result = await applyEdits([
      {
        kind: 'css',
        op: 'set',
        nodeId: 'css:src/app.css#.hero#color',
        file: 'src/app.css',
        selector: '.hero',
        property: 'color',
        value: 'red; } @plugin "./evil.js"; .x { color: red',
      },
    ])

    expect(result.refusals?.map((refusal) => refusal.reason)).toEqual(['needs-user'])
    expect(readStyles()).toBe(STYLES)
    expect(readStyles()).not.toContain('@plugin')
  })

  describe('every kind, not just css', () => {
    const PAGE = 'pages/Home.tsx'
    const SOURCE = [
      'const BOOKS = [',
      "  { isbn: '111', title: 'Dune' },",
      "  { isbn: '222', title: 'Solaris' },",
      ']',
      'export default function Home() {',
      '  return (',
      '    <main>',
      '      <p>hi</p>',
      '      <svg viewBox="0 0 24 24">',
      '        <path d="M4 4h16" />',
      '      </svg>',
      '      {BOOKS.map((b) => <span key={b.isbn}>{b.title}</span>)}',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n')
    const EVIL = '@plugin "./evil.js";'
    const readPage = (): string => fs.readFileSync(path.join(dir, ...PAGE.split('/')), 'utf8')

    beforeEach(() => {
      fs.mkdirSync(path.join(dir, 'pages'), { recursive: true })
      fs.writeFileSync(path.join(dir, ...PAGE.split('/')), SOURCE)
    })

    const adding: Array<[string, Record<string, unknown>]> = [
      ['text', { kind: 'text', nodeId: `${PAGE}:8:8`, text: EVIL }],
      ['prop', { kind: 'prop', nodeId: `${PAGE}:8:8`, prop: 'title', value: EVIL }],
      ['svg-attr', { kind: 'svg-attr', nodeId: `${PAGE}:9:8`, part: '10:10', partTag: 'path', set: { d: EVIL } }],
    ]
    for (const [kind, edit] of adding) {
      it(`${kind}: an edit that adds @plugin is needs-user and never lands`, async () => {
        const result = await applyEdits([edit])
        expect(result.refusals?.map((refusal) => refusal.reason)).toEqual(['needs-user'])
        expect(readPage()).toBe(SOURCE)
      })
    }

    const clean: Array<[string, Record<string, unknown>]> = [
      ['text', { kind: 'text', nodeId: `${PAGE}:8:8`, text: 'hello' }],
      ['svg-attr', { kind: 'svg-attr', nodeId: `${PAGE}:9:8`, part: '10:10', partTag: 'path', set: { d: 'M0 0' } }],
      ['list-item', { kind: 'list-item', nodeId: `${PAGE}:1:15`, length: 2, op: { kind: 'reorder', order: [1, 0] } }],
    ]
    for (const [kind, edit] of clean) {
      it(`${kind}: a write that lands is in the turn log`, async () => {
        const result = await applyEdits([edit])
        expect(result.refusals).toEqual([])
        expect(result.written).toBe(1)
        expect(readTurnWriteLog(dir, studioAgentUserKey(USER_ID)).map((entry) => entry.file)).toEqual([PAGE])
      })
    }

    it('restore is the editor’s alone', async () => {
      const result = await applyEdits([{ kind: 'restore', nodeId: 'restore', token: '0'.repeat(32) }])
      expect(result.refusals?.map((refusal) => refusal.reason)).toEqual(['restore-editor-only'])
    })

    it('a canvas layer is the human’s scratch space', async () => {
      const result = await applyEdits([{ kind: 'canvas-layer-restore', nodeId: 'layer', layerId: 'clabcdefghij', text: EVIL }])
      expect(result.refusals?.map((refusal) => refusal.reason)).toEqual(['canvas-layer-agent'])
      expect(fs.existsSync(path.join(dir, '.studio', 'canvas'))).toBe(false)
    })
  })

  it('records every file the batch wrote in the turn log', async () => {
    const result = await applyEdits([
      { kind: 'css', op: 'set', nodeId: 'css:src/app.css#.hero#color', file: 'src/app.css', selector: '.hero', property: 'color', value: 'blue' },
    ])

    expect(result.written).toBe(1)
    expect(readStyles()).toBe('.hero {\n  color: blue;\n}\n')
    expect(readTurnWriteLog(dir, studioAgentUserKey(USER_ID)).map((entry) => entry.file)).toEqual(['src/app.css'])
  })
})
