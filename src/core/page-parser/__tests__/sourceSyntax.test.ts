/**
 * WB-23/WB-24 at the parser's altitude.
 *
 * - `fileSyntaxError` / `sourceFileSyntaxError` — the one "does this file
 *   parse?" question both the load flag and the write refusal ask. Syntactic
 *   only: a type error or an unresolved import never makes a file "broken".
 * - `createWorkspaceProject` — a tsconfig that does not parse costs its path
 *   aliases, never the project; the loss is reported, not thrown.
 *
 * Fixture: a to-do app — nothing from the eSIM corpus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject, type WorkspaceProjectWarning } from '../componentSources'
import { fileSyntaxError, sourceFileSyntaxError } from '../sourceSyntax'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-syntax-'))
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

const UNCLOSED = [
  'export default function Todo() {',
  '  return (',
  '    <ul>',
  '      <li>buy milk',
  '    </ul>',
  '  )',
  '}',
  '',
].join('\n')

describe('fileSyntaxError', () => {
  it('names the first parse error and its line', () => {
    const error = fileSyntaxError(write('pages/Todo.tsx', UNCLOSED))
    expect(error).toMatchObject({ line: 4 })
    expect(error!.message).toContain("'li'")
  })

  it('is silent for a file that parses, even with a type error and an unresolved import', () => {
    const file = write('pages/Todo.tsx', [
      "import { store } from './nowhere'",
      'const count: number = "three"',
      'export default function Todo() {',
      '  return <ul><li>{store.first}</li></ul>',
      '}',
      '',
    ].join('\n'))
    expect(fileSyntaxError(file)).toBeUndefined()
  })

  it('reads a .jsx file with the JSX grammar', () => {
    expect(fileSyntaxError(write('pages/Todo.jsx', 'export default () => <ul><li>ok</li></ul>\n'))).toBeUndefined()
  })

  it('is silent for a file that does not exist — that is the codemod\'s refusal to make', () => {
    expect(fileSyntaxError(path.join(tmpDir, 'pages', 'Gone.tsx'))).toBeUndefined()
  })
})

describe('sourceFileSyntaxError', () => {
  it('asks the workspace project the same question', () => {
    write('pages/Broken.tsx', UNCLOSED)
    write('pages/Fine.tsx', 'export default () => <ul><li>ok</li></ul>\n')
    const project = createWorkspaceProject(tmpDir)
    expect(sourceFileSyntaxError(project.getSourceFileOrThrow(path.join(tmpDir, 'pages', 'Broken.tsx')))).toMatchObject({ line: 4 })
    expect(sourceFileSyntaxError(project.getSourceFileOrThrow(path.join(tmpDir, 'pages', 'Fine.tsx')))).toBeUndefined()
  })
})

describe('createWorkspaceProject — an unreadable tsconfig', () => {
  it('builds the project without it and says so, instead of throwing', () => {
    write('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." \n')
    write('pages/Todo.tsx', 'export default () => <ul><li>ok</li></ul>\n')
    const warnings: WorkspaceProjectWarning[] = []

    const project = createWorkspaceProject(tmpDir, warnings)
    expect(project.getSourceFile(path.join(tmpDir, 'pages', 'Todo.tsx'))).toBeDefined()
    expect(warnings).toEqual([expect.objectContaining({ code: 'tsconfig-unreadable' })])
    expect(warnings[0]!.message).toContain('tsconfig.json')
  })

  it('warns about nothing when the tsconfig parses, or when there is none', () => {
    write('pages/Todo.tsx', 'export default () => <ul><li>ok</li></ul>\n')
    const none: WorkspaceProjectWarning[] = []
    createWorkspaceProject(tmpDir, none)
    expect(none).toEqual([])

    write('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }\n')
    const valid: WorkspaceProjectWarning[] = []
    createWorkspaceProject(tmpDir, valid)
    expect(valid).toEqual([])
  })
})
