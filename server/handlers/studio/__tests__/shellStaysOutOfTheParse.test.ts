/**
 * The preview shell stays out of the parse program.
 *
 * `ensurePrototypeShell` writes a `vite.config.js` at the project root. It used
 * to be a workspace source file, so it became a root of every workspace
 * ts-morph `Project`, and TypeScript followed its imports: `vite` (and through
 * its declarations `rolldown`, `postcss`, `@types/node`, `undici-types`, …)
 * plus the shell's own 2 MB `prototype/studioRuntime.generated.js`. On the
 * canonical fixture the program grew from 86 to 288 files and every program
 * build (the load's, and every edit's) paid for it.
 *
 * What is pinned here, as a COUNT: the files of the program that are not
 * TypeScript's own `lib.*.d.ts` are exactly the user's source files, before
 * and after the shell is scaffolded. And the program never takes a package's
 * JS implementation, whatever the project's tsconfig asks for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceProject, listWorkspaceSourceFiles } from '@core/page-parser'
import { ensurePrototypeShell } from '../prototypeShell'

let tmpDir: string

function write(rel: string, contents: string): void {
  const abs = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

/** The program's files that are not TypeScript's own default libraries, as sorted workspace-relative POSIX paths. */
function programFiles(): string[] {
  const program = createWorkspaceProject(tmpDir).getProgram().compilerObject
  const root = fs.realpathSync(tmpDir).split(path.sep).join('/')
  return program
    .getSourceFiles()
    .filter((sourceFile) => !program.isSourceFileDefaultLibrary(sourceFile))
    .map((sourceFile) => {
      const file = sourceFile.fileName.split(path.sep).join('/')
      return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    })
    .sort()
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-parse-')))
  write('pages/Home.tsx', "import { Card } from '../components/Card'\nexport default function Home() { return <Card /> }\n")
  write('components/Card.tsx', 'export function Card() { return <div /> }\n')
  // A stand-in for the real `vite` package: declarations that pull in more
  // declarations, the way vite's pull in rolldown, postcss and @types/node.
  write('node_modules/vite/package.json', JSON.stringify({ name: 'vite', types: 'index.d.ts' }))
  write('node_modules/vite/index.d.ts', "import type { Heavy } from './heavy'\nexport declare function defineConfig(config: Heavy): Heavy\n")
  write('node_modules/vite/heavy.d.ts', 'export interface Heavy { plugins?: unknown[] }\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('the workspace parse program', () => {
  it('holds exactly the user source files, and scaffolding the preview shell adds none', () => {
    const userSource = ['components/Card.tsx', 'pages/Home.tsx']
    expect(programFiles()).toEqual(userSource)

    ensurePrototypeShell(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, 'vite.config.js'))).toBe(true)

    expect(listWorkspaceSourceFiles(tmpDir)).toEqual(userSource)
    const after = programFiles()
    expect(after).toEqual(userSource)
    expect(after.length).toBe(2)
  })

  it('keeps any build-tool config out, the user\'s own included — it runs in Node, it is never the app', () => {
    write('vite.config.ts', "import { defineConfig } from 'vite'\nexport default defineConfig({})\n")
    write('tailwind.config.js', 'export default {}\n')
    write('.eslintrc.cjs', 'module.exports = {}\n')
    expect(programFiles()).toEqual(['components/Card.tsx', 'pages/Home.tsx'])
  })

  it('still follows the declarations a user file imports', () => {
    write('pages/Settings.tsx', "import type { Heavy } from 'vite'\nexport default function Settings(_: { h?: Heavy }) { return <div /> }\n")
    expect(programFiles()).toEqual([
      'components/Card.tsx',
      'node_modules/vite/heavy.d.ts',
      'node_modules/vite/index.d.ts',
      'pages/Home.tsx',
      'pages/Settings.tsx',
    ])
  })

  it('never takes a package\'s JS implementation, even when the project\'s tsconfig asks for it', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true, maxNodeModuleJsDepth: 2 } }))
    write('node_modules/untyped/package.json', JSON.stringify({ name: 'untyped', main: 'index.js' }))
    write('node_modules/untyped/index.js', "export const value = 1\nexport { other } from './other.js'\n")
    write('node_modules/untyped/other.js', 'export const other = 2\n')
    write('pages/Uses.tsx', "import { value } from 'untyped'\nexport default function Uses() { return <div>{value}</div> }\n")
    expect(programFiles()).toEqual(['components/Card.tsx', 'pages/Home.tsx', 'pages/Uses.tsx'])
  })
})
