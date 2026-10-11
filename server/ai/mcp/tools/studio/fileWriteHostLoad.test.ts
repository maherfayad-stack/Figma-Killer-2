/**
 * The HTTP file tools ask the CONTENT half of the one agent write gate
 * (`agentContentRefusal`): a stylesheet change that adds a Tailwind
 * `@plugin`/`@config` directive — which makes the next build load a module in
 * Node — needs the user, on every write tool (security re-review of #233, R1
 * residual). The gate itself is covered in `agentWriteScope.test.ts`; this is
 * the wiring.
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

const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-file-hostload-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''

const STYLES = '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n.hero { color: red; }\n'

function ctx(): ToolContext {
  return {
    db: {} as never,
    userId: 'u_hostload',
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
  }
}

async function call(name: string, input: unknown): Promise<Result> {
  const found = studioAgentFileWriteTools.find((t) => t.name === name)
  if (!found?.handler) throw new Error(`tool not found: ${name}`)
  return (await found.handler(input, ctx())) as Result
}

const read = (): string => fs.readFileSync(path.join(dir, 'src', 'app.css'), 'utf8')

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

describe('the HTTP file tools refuse a stylesheet change that adds @plugin/@config', () => {
  it('studio_edit_file', async () => {
    const result = await call('studio_edit_file', { path: 'src/app.css', oldString: '.hero', newString: '@plugin "./evil.js";\n.hero', expectedHash: contentHash(STYLES) })
    expect(result.code).toBe('needs-user')
    expect(read()).toBe(STYLES)
  })

  it('studio_edit_files', async () => {
    const result = await call('studio_edit_files', { edits: [{ path: 'src/app.css', oldString: '.hero', newString: '@config "./evil.config.js";\n.hero', expectedHash: contentHash(STYLES) }] })
    expect(result.code).toBe('needs-user')
    expect(read()).toBe(STYLES)
  })

  it('studio_write_file, for a new stylesheet and for a rewrite', async () => {
    expect((await call('studio_write_file', { path: 'src/new.css', content: '@plugin "./evil.js";\n' })).code).toBe('needs-user')
    expect(fs.existsSync(path.join(dir, 'src', 'new.css'))).toBe(false)
    const rewrite = await call('studio_write_file', { path: 'src/app.css', content: `${STYLES}@plugin "evil-package";\n`, expectedHash: contentHash(STYLES) })
    expect(rewrite.code).toBe('needs-user')
    expect(read()).toBe(STYLES)
  })

  it('an edit that keeps the existing directive and changes the rest lands', async () => {
    const result = await call('studio_edit_file', { path: 'src/app.css', oldString: 'color: red', newString: 'color: coral', expectedHash: contentHash(STYLES) })
    expect(result.ok).toBe(true)
    expect(read()).toContain('color: coral')
  })
})
