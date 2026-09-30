/**
 * `studio_set_tokens` (AI-15): a token change is a minimal edit to the ONE
 * declaration that is the token, through the agent write gate — or a refusal
 * that names why there is no such declaration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { studioSetTokensMcpTools } from './setTokensTool'
import { agentWriteRefusal } from '../../../../handlers/studio/agentWriteScope'

const tool = studioSetTokensMcpTools[0]!

let dir: string

function write(relPath: string, contents: string): void {
  const full = join(dir, ...relPath.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents, 'utf8')
}

function read(relPath: string): string {
  return readFileSync(join(dir, ...relPath.split('/')), 'utf8')
}

type Result = Record<string, unknown> & { ok: boolean; code?: string; message?: string }

async function call(set: unknown[]): Promise<Result> {
  return (await tool.handler!({ dir, set } as never, { userId: 'u1' } as never)) as Result
}

const INDEX_CSS = [
  '/* The palette. Keep in sync with Figma. */',
  ':root {',
  '  --color-brand: #0c9ab0;   /* teal */',
  '  --radius-card: 12px;',
  '  --space-md: 16px;',
  '}',
  '',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --color-brand: #5fd3e4;',
  '  }',
  '}',
  '',
].join('\n')

function viteProject(indexCss = INDEX_CSS): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0', vite: '^6.0.0' } }))
  write('src/main.tsx', "import './index.css'\nimport { App } from './App'\nexport default App\n")
  write('src/App.tsx', 'export function App() { return <main /> }\n')
  write('src/index.css', indexCss)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-set-tokens-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('studio_set_tokens', () => {
  it('changes the light and the dark declaration in one call, and nothing else in the file', async () => {
    viteProject()
    const result = await call([
      { name: '--color-brand', value: '#ef4550' },
      { name: '--color-brand', value: '#ff8a93', scheme: 'dark' },
      { name: '--radius-card', value: '16px' },
    ])
    expect(result.ok).toBe(true)
    expect(read('src/index.css')).toBe(
      INDEX_CSS
        .replace('--color-brand: #0c9ab0;   /* teal */', '--color-brand: #ef4550;   /* teal */')
        .replace('--color-brand: #5fd3e4;', '--color-brand: #ff8a93;')
        .replace('--radius-card: 12px;', '--radius-card: 16px;'),
    )
    expect(result.changed).toEqual([
      { name: '--color-brand', scheme: 'dark', file: 'src/index.css', line: 10, from: '#5fd3e4', to: '#ff8a93' },
      { name: '--radius-card', scheme: 'light', file: 'src/index.css', line: 4, from: '12px', to: '16px' },
      { name: '--color-brand', scheme: 'light', file: 'src/index.css', line: 3, from: '#0c9ab0', to: '#ef4550' },
    ])
  })

  it('keeps a CRLF stylesheet CRLF', async () => {
    viteProject(INDEX_CSS.replace(/\n/g, '\r\n'))
    const result = await call([{ name: '--space-md', value: '20px' }])
    expect(result.ok).toBe(true)
    expect(read('src/index.css')).toBe(INDEX_CSS.replace('--space-md: 16px;', '--space-md: 20px;').replace(/\n/g, '\r\n'))
  })

  it('is all-or-nothing: one unknown token and nothing is written', async () => {
    viteProject()
    const result = await call([{ name: '--radius-card', value: '4px' }, { name: '--nope', value: '1px' }])
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-such-token')
    expect(result.entryIndex).toBe(1)
    expect(read('src/index.css')).toBe(INDEX_CSS)
  })

  it('says a dark value is missing rather than editing the light one', async () => {
    viteProject()
    const result = await call([{ name: '--space-md', value: '8px', scheme: 'dark' }])
    expect(result.code).toBe('no-such-token')
    expect(String(result.message)).toContain('has a light value but no dark declaration')
  })

  it('refuses a token with a responsive override in the same file, naming both lines', async () => {
    viteProject(`${INDEX_CSS}@media (min-width: 768px) {\n  :root {\n    --space-md: 24px;\n  }\n}\n`)
    const result = await call([{ name: '--space-md', value: '20px' }])
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ambiguous-declaration')
    expect(String(result.message)).toContain('src/index.css:5')
    expect(String(result.message)).toContain('src/index.css:15 (@media (min-width: 768px))')
    expect(read('src/index.css')).toContain('--space-md: 16px;')
  })

  it('refuses a token two project stylesheets both declare', async () => {
    viteProject()
    write('src/main.tsx', "import './index.css'\nimport './theme.css'\nimport { App } from './App'\nexport default App\n")
    write('src/theme.css', ':root {\n  --radius-card: 20px;\n}\n')
    const result = await call([{ name: '--radius-card', value: '8px' }])
    expect(result.code).toBe('ambiguous-declaration')
    expect(String(result.message)).toContain('src/index.css:4')
    expect(String(result.message)).toContain('src/theme.css:2')
  })

  it('refuses a value that would break out of the declaration', async () => {
    viteProject()
    const result = await call([{ name: '--space-md', value: '1px; color: red' }])
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
    expect(read('src/index.css')).toBe(INDEX_CSS)
  })
})

describe('the agent write gate lets a stylesheet through and keeps host config out', () => {
  it('a .css file is not a host-executed file; a build config is', () => {
    viteProject()
    expect(agentWriteRefusal('src/index.css', dir)).toBeNull()
    expect(agentWriteRefusal('src/theme/tokens.module.css', dir)).toBeNull()
    expect(agentWriteRefusal('postcss.config.js', dir)?.code).toBe('needs-user')
    expect(agentWriteRefusal('.studio/tokens.css', dir)).not.toBeNull()
  })
})
