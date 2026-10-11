/**
 * The agent's file tools (P4-C, AI-2): one containment rule for every read and
 * write, the stale-hash guard, the project write lock, the turn write log, the
 * live-reload push, and the atomic batch.
 *
 * The containment cases are the security-guard threat list for this bundle:
 * path traversal, absolute paths, symlinks and junctions out of the project,
 * case-insensitive spellings of protected directories, writes into `.studio`,
 * `.git`, `node_modules` and `.claude`, credential files, huge files, binary
 * files, and hard links.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../../../../handlers/studioProjects'
import { readTurnWriteLog } from '../../../../handlers/studio/turnWriteLog'
import { studioAgentUserKey } from '../../../../handlers/studio/agentUserScope'
import { studioWriteSessionCovers } from '../../../../handlers/studio/projectWriteLock'
import { createEditorBridgeStream, editorBridgeScope } from '../../editorBridge'
import { resolveBridgeToolResult } from '../../../runtime'
import type { ToolContext } from '../../../runtime/types'
import { studioFileReadMcpTools } from './fileReadTools'
import { studioAgentFileWriteTools } from './fileWriteTools'
import { STUDIO_LIVE_RELOAD_TOOL_NAME } from './liveReloadPush'
import { resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import { unwritableWorkspaceSegment } from '@core/page-parser'

const tools = [...studioFileReadMcpTools, ...studioAgentFileWriteTools]
function tool(name: string) {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool not found: ${name}`)
  return found
}

type Result = { ok: boolean; code?: string; error?: string; [key: string]: unknown }

const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-file-tools-')))
const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-file-tools-outside-')))
const priorWorkspaceDir = process.env.STUDIO_WORKSPACE_DIR
let dir = ''
let userId = ''

function write(rel: string, contents: string | Buffer): string {
  const full = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as never,
    userId,
    capabilities: ['ai.chat', 'ai.tools.write', 'studio.write'],
    conversationId: 'c1',
    workspaceDir: dir,
    snapshot: null,
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function call(name: string, input: unknown, context: ToolContext = ctx()): Promise<Result> {
  return (await tool(name).handler!(input, context)) as Result
}

beforeAll(() => {
  process.env.STUDIO_WORKSPACE_DIR = workspaceRoot
})
afterAll(() => {
  if (priorWorkspaceDir === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = priorWorkspaceDir
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
  fs.rmSync(outsideRoot, { recursive: true, force: true })
})
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(projectsRootDir(), 'proj-'))
  userId = `u_${Math.random().toString(36).slice(2)}`
  write('pages/Home.tsx', 'export default function Home() {\n  return <div className="hero">Hi</div>\n}\n')
  write('.studio/meta.json', '{"trust":"static"}')
  write('.git/config', '[remote "origin"]\n  url = https://token@example.com/repo.git\n')
  write('.claude/settings.local.json', '{}')
  write('.env', 'SECRET=hunter2')
  write('node_modules/pkg/index.js', 'module.exports = 1')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Containment — reads
// ---------------------------------------------------------------------------

describe('reads go through the one containment rule', () => {
  it('a node id\'s file part cannot climb out of the project (studio_get_node_source)', async () => {
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'TOP SECRET LINE\n')
    const rel = path.relative(dir, path.join(outsideRoot, 'secret.txt')).split(path.sep).join('/')
    const result = await call('studio_get_node_source', { nodeId: `${rel}:1:1` })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('path-outside-project')
    expect(JSON.stringify(result)).not.toContain('TOP SECRET')
  })

  it('a protected directory spelled in another case is still protected (studio_read_file)', async () => {
    for (const spelling of ['.GIT/config', '.Git/config', '.git./config', '.STUDIO/meta.json']) {
      const result = await call('studio_read_file', { path: spelling })
      expect(result.ok, spelling).toBe(false)
      expect(JSON.stringify(result), spelling).not.toContain('token@example.com')
    }
  })

  it('credential files are never read, and never show up in a grep', async () => {
    expect((await call('studio_read_file', { path: '.env' })).code).toBe('protected-path')
    const grep = await call('studio_grep', { query: 'hunter2' })
    expect(grep.ok).toBe(true)
    expect(grep.total).toBe(0)
  })

  it('refuses traversal, absolute paths outside, and links that escape', async () => {
    expect((await call('studio_read_file', { path: '../../etc/passwd' })).code).toBe('path-outside-project')
    const outsideFile = path.join(outsideRoot, 'out.txt')
    fs.writeFileSync(outsideFile, 'outside')
    expect((await call('studio_read_file', { path: outsideFile })).code).toBe('path-outside-project')
    fs.symlinkSync(outsideRoot, path.join(dir, 'escape'), 'junction')
    const viaLink = await call('studio_read_file', { path: 'escape/out.txt' })
    expect(viaLink.code).toBe('path-outside-project')
  })

  it('refuses an NTFS data stream and a Windows device name', async () => {
    expect((await call('studio_read_file', { path: 'pages/Home.tsx:hidden' })).code).toBe('path-outside-project')
    expect((await call('studio_write_file', { path: 'pages/Home.tsx:hidden', content: 'x' })).code).toBe('path-outside-project')
    if (process.platform === 'win32') {
      for (const device of ['CON', 'nul.tsx', 'pages/com1.css', 'LPT9']) {
        expect((await call('studio_read_file', { path: device })).code, device).toBe('path-outside-project')
      }
    }
  })

  it('accepts an absolute path that IS inside the project, and hands back the on-disk casing', async () => {
    const abs = path.join(dir, 'pages', 'Home.tsx')
    const result = await call('studio_read_file', { path: abs })
    expect(result.ok).toBe(true)
    expect(result.path).toBe('pages/Home.tsx')
    expect(typeof result.hash).toBe('string')
  })

  it('refuses a binary file and an oversized one', async () => {
    write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]))
    expect((await call('studio_read_file', { path: 'assets/logo.png' })).code).toBe('not-text')
    write('pages/Huge.tsx', 'a'.repeat(200_001))
    expect((await call('studio_read_file', { path: 'pages/Huge.tsx' })).code).toBe('file-too-large')
  })

  it('studio_grep finds a literal across files, with line numbers, and skips protected ones', async () => {
    write('pages/Other.tsx', 'const x = 1\nconst y = "hero"\n')
    const result = await call('studio_grep', { query: 'HERO' })
    expect(result.ok).toBe(true)
    const matches = result.matches as Array<{ path: string; line: number }>
    expect(matches).toEqual([
      { path: 'pages/Home.tsx', line: 2, text: expect.any(String) },
      { path: 'pages/Other.tsx', line: 2, text: expect.any(String) },
    ] as unknown as typeof matches)
    // A regex metacharacter is matched literally.
    expect((await call('studio_grep', { query: 'className=".*"' })).total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Containment — writes
// ---------------------------------------------------------------------------

describe('writes go through the same rule plus the agentWriteScope deny list', () => {
  it('never writes into .studio, .git, .claude or node_modules, in any spelling', async () => {
    const targets = [
      '.studio/meta.json',
      '.STUDIO/meta.json',
      '.git/hooks/pre-commit',
      '.Git/config',
      '.claude/settings.local.json',
      '.CLAUDE/settings.local.json',
      'node_modules/pkg/index.js',
      'src/.git/config',
    ]
    for (const target of targets) {
      const result = await call('studio_write_file', { path: target, content: 'owned' })
      expect(result.ok, target).toBe(false)
      expect(result.code, target).toBe('protected-path')
    }
    expect(fs.readFileSync(path.join(dir, '.studio', 'meta.json'), 'utf8')).toBe('{"trust":"static"}')
    expect(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('never writes a credential file: env and npm config need the user, key material is protected', async () => {
    expect((await call('studio_write_file', { path: '.env.local', content: 'X=1' })).code).toBe('needs-user')
    expect((await call('studio_write_file', { path: '.npmrc', content: 'registry=x' })).code).toBe('needs-user')
    expect((await call('studio_write_file', { path: 'certs/server.pem', content: 'x' })).code).toBe('protected-path')
    expect(fs.existsSync(path.join(dir, '.env.local'))).toBe(false)
  })

  it('never writes through a link that leaves the project, or into a directory linked to the control plane', async () => {
    fs.symlinkSync(outsideRoot, path.join(dir, 'out'), 'junction')
    expect((await call('studio_write_file', { path: 'out/pwned.txt', content: 'x' })).code).toBe('path-outside-project')
    expect(fs.existsSync(path.join(outsideRoot, 'pwned.txt'))).toBe(false)

    fs.symlinkSync(path.join(dir, '.studio'), path.join(dir, 'theme'), 'junction')
    expect((await call('studio_write_file', { path: 'theme/meta.json', content: '{"trust":"run-project"}' })).ok).toBe(false)
    expect(fs.readFileSync(path.join(dir, '.studio', 'meta.json'), 'utf8')).toBe('{"trust":"static"}')
  })

  it('never writes through a hard link', async () => {
    const outside = path.join(outsideRoot, 'victim.txt')
    fs.writeFileSync(outside, 'original')
    fs.linkSync(outside, path.join(dir, 'pages', 'linked.txt'))
    const read = await call('studio_read_file', { path: 'pages/linked.txt' })
    const result = await call('studio_write_file', { path: 'pages/linked.txt', content: 'changed', expectedHash: read.hash })
    expect(result.code).toBe('protected-path')
    expect(fs.readFileSync(outside, 'utf8')).toBe('original')
  })

  it('refuses binary and oversized content', async () => {
    expect((await call('studio_write_file', { path: 'pages/Bin.tsx', content: 'a\u0000b' })).code).toBe('not-text')
    expect((await call('studio_write_file', { path: 'pages/Big.tsx', content: 'a'.repeat(200_001) })).code).toBe('file-too-large')
  })

  it('refuses without an open project, and never takes a directory argument', async () => {
    const result = await call('studio_write_file', { path: 'pages/X.tsx', content: 'x' }, ctx({ workspaceDir: undefined }))
    expect(result.code).toBe('no-open-project')
    for (const name of ['studio_write_file', 'studio_edit_file', 'studio_edit_files']) {
      expect(JSON.stringify(tool(name).inputSchema)).not.toContain('"dir"')
    }
  })
})

// ---------------------------------------------------------------------------
// The stale-hash guard, and what every write does
// ---------------------------------------------------------------------------

describe('studio_write_file', () => {
  it('creates a new file (and its folders), logs it for the turn, and holds the project write lock', async () => {
    const result = await call('studio_write_file', { path: 'pages/Checkout.tsx', content: 'export default function Checkout() { return null }\n' })
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    const abs = path.join(dir, 'pages', 'Checkout.tsx')
    expect(fs.readFileSync(abs, 'utf8')).toContain('Checkout')
    expect(readTurnWriteLog(dir, studioAgentUserKey(userId)).map((e) => e.file)).toEqual(['pages/Checkout.tsx'])
    // The project watcher reads this to tell Studio's own writes from
    // everyone else's (P1-D): a write outside the lock costs a second reload.
    expect(studioWriteSessionCovers(dir, fs.statSync(abs).mtimeMs, 5)).toBe(true)
  })

  it('refuses to overwrite an existing file without the hash of a read, and with a stale one', async () => {
    const blind = await call('studio_write_file', { path: 'pages/Home.tsx', content: 'blind' })
    expect(blind.code).toBe('stale-source')
    const read = await call('studio_read_file', { path: 'pages/Home.tsx' })
    write('pages/Home.tsx', 'someone else changed it')
    const stale = await call('studio_write_file', { path: 'pages/Home.tsx', content: 'mine', expectedHash: read.hash })
    expect(stale.code).toBe('stale-source')
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toBe('someone else changed it')
    const fresh = await call('studio_read_file', { path: 'pages/Home.tsx' })
    const ok = await call('studio_write_file', { path: 'pages/Home.tsx', content: 'mine', expectedHash: fresh.hash })
    expect(ok.ok).toBe(true)
    expect(ok.created).toBe(false)
  })

  it('pushes one live reload naming the written file to every tab on the project', async () => {
    const abort = new AbortController()
    const reader = createEditorBridgeStream(userId, editorBridgeScope(dir), abort.signal).getReader()
    const dec = new TextDecoder()
    let buffer = ''
    const next = async (match: (e: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      for (;;) {
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as Record<string, unknown>
          if (match(event)) return event
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += dec.decode(value, { stream: true })
      }
    }
    const ready = await next((e) => e.type === 'bridgeReady')
    await call('studio_write_file', { path: 'pages/New.tsx', content: 'export default function New() { return null }\n' })
    const request = await next((e) => e.type === 'toolRequest')
    expect(request.toolName).toBe(STUDIO_LIVE_RELOAD_TOOL_NAME)
    expect(request.input).toMatchObject({ dir, diskChanged: { files: ['pages/New.tsx'] } })
    resolveBridgeToolResult(ready.bridgeId as string, request.requestId as string, { ok: true, data: { applied: true, failed: [] } })
    abort.abort()
  })
})

describe('studio_edit_file', () => {
  it('replaces exactly one occurrence, and refuses a missing or ambiguous oldString', async () => {
    const ok = await call('studio_edit_file', { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' })
    expect(ok.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('>Hello<')

    expect((await call('studio_edit_file', { path: 'pages/Home.tsx', oldString: 'nowhere', newString: 'x' })).code).toBe('edit-no-match')
    write('pages/Twice.tsx', 'a\nb\na\n')
    const ambiguous = await call('studio_edit_file', { path: 'pages/Twice.tsx', oldString: 'a', newString: 'c' })
    expect(ambiguous.code).toBe('edit-ambiguous')
    expect(ambiguous.lines).toEqual([1, 3])
    const all = await call('studio_edit_file', { path: 'pages/Twice.tsx', oldString: 'a', newString: 'c', replaceAll: true })
    expect(all.replacements).toBe(2)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Twice.tsx'), 'utf8')).toBe('c\nb\nc\n')
  })

  it('matches a CRLF file with an LF oldString, and keeps its line endings', async () => {
    write('pages/Crlf.tsx', 'line one\r\nline two\r\n')
    const result = await call('studio_edit_file', { path: 'pages/Crlf.tsx', oldString: 'line one\nline two', newString: 'first\nsecond' })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Crlf.tsx'), 'utf8')).toBe('first\r\nsecond\r\n')
  })

  it('honours expectedHash', async () => {
    expect((await call('studio_edit_file', { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Yo', expectedHash: 'deadbeefdeadbeef' })).code).toBe('stale-source')
  })
})

describe('studio_edit_files is all-or-nothing', () => {
  it('one refusing edit means nothing is written, and the refusal names it', async () => {
    write('pages/Home.module.css', '.hero { color: red; }\n')
    const before = fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')
    const result = await call('studio_edit_files', {
      edits: [
        { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' },
        { path: 'pages/Home.module.css', oldString: 'blue', newString: 'green' },
      ],
    })
    expect(result.code).toBe('edit-no-match')
    expect(result.editIndex).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toBe(before)
    expect(readTurnWriteLog(dir, studioAgentUserKey(userId))).toEqual([])
  })

  it('lands every edit together, several per file in order', async () => {
    write('pages/Home.module.css', '.hero { color: red; }\n')
    const result = await call('studio_edit_files', {
      edits: [
        { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' },
        { path: 'pages/Home.tsx', oldString: 'Hello', newString: 'Hello there' },
        { path: 'pages/Home.module.css', oldString: 'red', newString: 'green' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('Hello there')
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.module.css'), 'utf8')).toContain('green')
    expect(readTurnWriteLog(dir, studioAgentUserKey(userId)).map((e) => e.file).sort()).toEqual(['pages/Home.module.css', 'pages/Home.tsx'])
  })

  it('a batch naming a protected path writes nothing', async () => {
    const result = await call('studio_edit_files', {
      edits: [
        { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' },
        { path: '.studio/meta.json', oldString: 'static', newString: 'run-project' },
      ],
    })
    expect(result.code).toBe('protected-path')
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('>Hi<')
    expect(fs.readFileSync(path.join(dir, '.studio', 'meta.json'), 'utf8')).toBe('{"trust":"static"}')
  })
})

// ---------------------------------------------------------------------------
// Security review of #233
// ---------------------------------------------------------------------------

describe('F1 — no path costs more than linear time', () => {
  it('a 40,000-character run of spaces before one character is folded in linear time', () => {
    const started = performance.now()
    unwritableWorkspaceSegment(`${' '.repeat(40_000)}x`)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('a 40,000-character path segment is refused at once, by every agent file tool', async () => {
    const huge = `${'.'.repeat(40_000)}x`
    const started = performance.now()
    const direct = resolveAgentFilePath(dir, huge, 'read')
    expect(performance.now() - started).toBeLessThan(50)
    expect(direct.ok).toBe(false)
    expect((await call('studio_read_file', { path: huge })).code).toBe('path-outside-project')
    expect((await call('studio_get_node_source', { nodeId: `${huge}:1:1` })).code).toBe('path-outside-project')
  })

  it('a segment over 255 characters is refused, and every path field carries a maxLength', async () => {
    expect((await call('studio_read_file', { path: `pages/${'a'.repeat(256)}.tsx` })).code).toBe('path-outside-project')
    for (const name of ['studio_read_file', 'studio_list_files', 'studio_grep', 'studio_write_file', 'studio_edit_file']) {
      const schema = tool(name).inputSchema as unknown as { properties: { path: { maxLength?: number } } }
      expect(schema.properties.path.maxLength, name).toBe(1024)
    }
  })
})

describe('F2 — replaceAll refuses an oversized result before building it', () => {
  it('the refusal comes from the projected size, not from a string already built', async () => {
    write('pages/Grow.css', 'a'.repeat(150_000))
    const result = await call('studio_edit_file', { path: 'pages/Grow.css', oldString: 'a', newString: 'b'.repeat(20), replaceAll: true })
    expect(result.code).toBe('file-too-large')
    expect(result.projectedBytes).toBe(150_000 * 20)
  })

  it('a one-character oldString times a 10 KB newString is refused from its projected size', async () => {
    write('pages/Big.css', 'a'.repeat(150_000))
    const result = await call('studio_edit_file', { path: 'pages/Big.css', oldString: 'a', newString: 'b'.repeat(10_000), replaceAll: true })
    expect(result.code).toBe('file-too-large')
    expect(result.projectedBytes).toBe(150_000 * 10_000)
    expect(fs.readFileSync(path.join(dir, 'pages', 'Big.css'), 'utf8')).toBe('a'.repeat(150_000))
  })
})

describe('F3 — files that run on the host need the user (needs-user), on the HTTP path', () => {
  const HOST_FILES = [
    'vite.config.ts',
    'Vite.Config.JS',
    'postcss.config.cjs',
    'tailwind.config.js',
    '.babelrc',
    'package.json',
    '.env.production',
    '.npmrc',
    '.husky/pre-commit',
    '.vscode/tasks.json',
    '.github/workflows/ci.yml',
    'bunfig.toml',
    'CLAUDE.md',
    'pages/CLAUDE.md',
    '.lintstagedrc.json',
    'lefthook.yml',
    '.gitlab-ci.yml',
    '.circleci/config.yml',
  ]

  it('studio_write_file refuses each class with needs-user and writes nothing', async () => {
    for (const rel of HOST_FILES) {
      const result = await call('studio_write_file', { path: rel, content: 'export default {}' })
      expect(result.code, rel).toBe('needs-user')
      expect(result.error, rel).toContain('ask them to make or approve it')
      expect(fs.existsSync(path.join(dir, ...rel.split('/'))), rel).toBe(false)
    }
  })

  it('studio_edit_file and a studio_edit_files batch refuse too, and the batch writes nothing', async () => {
    write('vite.config.js', 'export default {}\n')
    const read = await call('studio_read_file', { path: 'vite.config.js' })
    expect(read.ok).toBe(true)
    const single = await call('studio_edit_file', { path: 'vite.config.js', oldString: 'export default', newString: 'import("node:child_process");\nexport default', expectedHash: read.hash })
    expect(single.code).toBe('needs-user')
    const batch = await call('studio_edit_files', {
      edits: [
        { path: 'pages/Home.tsx', oldString: 'Hi', newString: 'Hello' },
        { path: 'vite.config.js', oldString: 'export default', newString: 'x; export default' },
      ],
    })
    expect(batch.code).toBe('needs-user')
    expect(batch.editIndex).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'vite.config.js'), 'utf8')).toBe('export default {}\n')
    expect(fs.readFileSync(path.join(dir, 'pages', 'Home.tsx'), 'utf8')).toContain('>Hi<')
  })

  it('screen files stay writable: .tsx, .ts, .css and assets', async () => {
    for (const rel of ['pages/Settings.tsx', 'src/lib/format.ts', 'pages/Settings.module.css', 'public/logo.svg']) {
      expect((await call('studio_write_file', { path: rel, content: 'x' })).ok, rel).toBe(true)
    }
  })
})

describe('F4 and F8', () => {
  it('a write never creates a name ending in a dot or a space, or made only of dots', async () => {
    for (const rel of ['.../x.tsx', 'pages./x.tsx', 'pages/x.tsx ', 'pages/x.tsx.']) {
      expect((await call('studio_write_file', { path: rel, content: 'x' })).code, rel).toBe('path-outside-project')
    }
  })

  it('.envrc, .dev.vars, *.tfvars and secrets.* are never read', async () => {
    for (const rel of ['.envrc', '.dev.vars', 'infra/prod.tfvars', 'config/secrets.json']) {
      write(rel, 'SECRET=hunter2')
      expect((await call('studio_read_file', { path: rel })).code, rel).toBe('protected-path')
    }
  })
})

describe('R1 — what a host config loads is refused on the HTTP path too', () => {
  it('Studio\'s preview shell is protected-path, and the module a project config imports needs the user', async () => {
    write('prototype/studioRuntime.generated.js', 'export const studioRuntimeIdPlugin = () => ({})\n')
    const shell = await call('studio_read_file', { path: 'prototype/studioRuntime.generated.js' })
    const shellEdit = await call('studio_edit_file', { path: 'prototype/studioRuntime.generated.js', oldString: 'export', newString: 'import("node:child_process"); export', expectedHash: shell.hash })
    expect(shellEdit.code).toBe('protected-path')
    expect((await call('studio_write_file', { path: 'prototype/new.js', content: 'x' })).code).toBe('protected-path')

    write('vite.config.ts', "import { plugins } from './vite/plugins'\nexport default {}\n")
    write('vite/plugins.ts', 'export const plugins = () => []\n')
    const plugin = await call('studio_read_file', { path: 'vite/plugins.ts' })
    const pluginEdit = await call('studio_edit_file', { path: 'vite/plugins.ts', oldString: 'export', newString: 'x; export', expectedHash: plugin.hash })
    expect(pluginEdit.code).toBe('needs-user')
    expect(pluginEdit.error).toContain('imported by vite.config.ts')
    expect(fs.readFileSync(path.join(dir, 'vite', 'plugins.ts'), 'utf8')).toBe('export const plugins = () => []\n')
  })
})
