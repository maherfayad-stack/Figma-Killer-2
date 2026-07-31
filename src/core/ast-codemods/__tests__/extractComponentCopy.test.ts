/**
 * extractComponentCopy — WS-4.4's detach-refusal escape hatch. Focused
 * coverage (the broader detach-refusal → escape-hatch flow is exercised end
 * to end in `server/ai/mcp/tools/studio/editTools.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { extractComponentCopy } from '../extractComponentCopy'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-component-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(tmpDir, ...relPath.split('/')), 'utf8')
}

describe('extractComponentCopy', () => {
  it('duplicates the component, renames the export, and repoints only this call site', () => {
    write('components/Counter.tsx', [
      "import { useState } from 'react'",
      'export function Counter() {',
      '  const [n] = useState(0)',
      '  return <span>{n}</span>',
      '}',
      '',
    ].join('\n'))
    const pageFile = write('pages/Home.tsx', [
      "import { Counter } from '../components/Counter'",
      'export default function Home() {',
      '  return <Counter />',
      '}',
      '',
    ].join('\n'))

    const result = extractComponentCopy({ file: pageFile, line: 3, col: 11, workspaceRoot: tmpDir })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newComponentName).toBe('Counter2')
      expect(result.newFile).toBe('components/Counter2.tsx')
    }
    expect(fs.existsSync(path.join(tmpDir, 'components', 'Counter2.tsx'))).toBe(true)
    expect(read('components/Counter2.tsx')).toContain('export function Counter2()')
    // The ORIGINAL file is untouched.
    expect(read('components/Counter.tsx')).toContain('export function Counter()')
    expect(read('pages/Home.tsx')).toContain('<Counter2 />')
  })

  it('picks the next free numeric suffix when Card2 already exists', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    write('components/Card2.tsx', 'export function Card2() {\n  return <div>Card2</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return <Card />',
      '}',
      '',
    ].join('\n'))

    const result = extractComponentCopy({ file: pageFile, line: 3, col: 11, workspaceRoot: tmpDir })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.newComponentName).toBe('Card3')
  })

  it('repoints only the TARGETED nested self-closing instance, leaving a sibling untouched', () => {
    write('components/Card.tsx', 'export function Card() {\n  return <div>Card</div>\n}\n')
    const pageFile = write('pages/Home.tsx', [
      "import { Card } from '../components/Card'",
      'export default function Home() {',
      '  return (',
      '    <section>',
      '      <Card />',
      '      <span>sibling</span>',
      '    </section>',
      '  )',
      '}',
      '',
    ].join('\n'))

    const result = extractComponentCopy({ file: pageFile, line: 5, col: 8, workspaceRoot: tmpDir })
    expect(result.ok).toBe(true)
    const text = read('pages/Home.tsx')
    expect(text).toContain('<Card2 />')
    expect(text).toContain('</section>')
    expect(text).toContain('<span>sibling</span>')
  })

  it('refuses a plain HTML element', () => {
    const pageFile = write('pages/Home.tsx', 'export default function Home() {\n  return <div>Hi</div>\n}\n')
    const result = extractComponentCopy({ file: pageFile, line: 2, col: 11, workspaceRoot: tmpDir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toBe('not-a-component')
  })
})
