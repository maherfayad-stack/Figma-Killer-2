import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { studioPackageDocMcpTools } from './packageDocTools'

const tool = studioPackageDocMcpTools[0]!

let root: string
let projectDir: string

const DOC = [
  '# Design System',
  'Intro prose.',
  '## Button',
  'Button takes `variant` and `label`.',
  '## ButtonGroup',
  'Groups buttons.',
  '## Tag',
  'Tag takes `label`.',
].join('\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pkg-doc-test-'))
  // The real shape being reproduced: the package is HOISTED to a root above
  // the project, not installed inside it.
  projectDir = join(root, 'studio-workspace', 'my-project')
  mkdirSync(projectDir, { recursive: true })
  const pkgDir = join(root, 'node_modules', '@scope', 'ds')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'CLAUDE.md'), DOC)
  writeFileSync(join(root, 'SECRET.md'), '# secrets\ntop secret')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function call(input: Record<string, unknown>) {
  return tool.handler!({ dir: projectDir, package: '@scope/ds', ...input } as never, {} as never)
}

describe('studio_read_package_doc', () => {
  it('resolves a package hoisted above the project', async () => {
    const result = await call({ outline: true }) as { ok: boolean; sectionCount: number }

    expect(result.ok).toBe(true)
    expect(result.sectionCount).toBe(4)
  })

  it('returns an outline with no bodies — the cheap first call', async () => {
    const result = await call({ outline: true }) as {
      headings: Array<{ heading: string; level: number; bytes: number }>
      content?: string
    }

    // The leading `# Design System` is a heading in its own right, so it owns
    // the intro prose — "(intro)" appears only for text BEFORE any heading.
    expect(result.headings.map((h) => h.heading)).toEqual(['Design System', 'Button', 'ButtonGroup', 'Tag'])
    expect(result.content).toBeUndefined()
  })

  it('returns one section body by heading', async () => {
    const result = await call({ section: 'Button' }) as { ok: boolean; heading: string; content: string }

    expect(result.ok).toBe(true)
    expect(result.heading).toBe('Button')
    expect(result.content).toBe('Button takes `variant` and `label`.')
  })

  // "Button" must not resolve to "ButtonGroup" just because it sorts first.
  it('prefers an exact heading over a prefix match', async () => {
    const result = await call({ section: 'button' }) as { heading: string }

    expect(result.heading).toBe('Button')
  })

  it('falls back to a prefix match when no heading is exact', async () => {
    const result = await call({ section: 'ButtonGr' }) as { heading: string }

    expect(result.heading).toBe('ButtonGroup')
  })

  it('lists the available headings when a section is not found, instead of a bare failure', async () => {
    const result = await call({ section: 'Carousel' }) as { ok: boolean; headings: string[] }

    expect(result.ok).toBe(false)
    expect(result.headings).toContain('Button')
  })

  it('returns outline plus a preview when neither outline nor section is given', async () => {
    const result = await call({}) as { ok: boolean; preview: string; headings: unknown[] }

    expect(result.ok).toBe(true)
    expect(result.preview).toContain('# Design System')
    expect(result.headings.length).toBe(4)
  })

  // The whole point: a call that could return the entire file would reproduce
  // the oversized-read failure this tool exists to fix.
  it('never returns the whole document in one call', async () => {
    const outline = await call({ outline: true }) as { content?: string; preview?: string }
    expect(outline.content).toBeUndefined()
    expect(outline.preview).toBeUndefined()
  })

  describe('containment', () => {
    it('refuses a doc path that escapes the package directory', async () => {
      const result = await call({ doc: '../../../SECRET.md' }) as { ok: boolean }

      expect(result.ok).toBe(false)
    })

    it('refuses a non-markdown file', async () => {
      const result = await call({ doc: 'index.js' }) as { ok: boolean }

      expect(result.ok).toBe(false)
    })

    it('refuses a package name carrying path separators', async () => {
      const result = await tool.handler!(
        { dir: projectDir, package: '../../etc', doc: 'passwd.md' } as never,
        {} as never,
      ) as { ok: boolean }

      expect(result.ok).toBe(false)
    })

    it('reports a package that is not installed rather than throwing', async () => {
      const result = await tool.handler!(
        { dir: projectDir, package: '@scope/not-installed' } as never,
        {} as never,
      ) as { ok: boolean; error: string }

      expect(result.ok).toBe(false)
      expect(result.error).toContain('not an installed markdown doc')
    })
  })
})
