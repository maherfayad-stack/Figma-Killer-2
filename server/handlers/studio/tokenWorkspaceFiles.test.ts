/**
 * What a rename / remove may read and therefore rewrite: only real project
 * files. A link, or anything under node_modules, is never in the list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readTokenWorkspaceFiles } from './tokenWorkspaceFiles'
import { planTokenEdits } from './tokenWrite'

let dir: string
let outside: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-ws-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-ws-outside-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('readTokenWorkspaceFiles', () => {
  it('lists real project stylesheets', () => {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src/a.css'), ':root { --a: 1; }\n')
    expect(readTokenWorkspaceFiles(dir).map((f) => f.file)).toEqual(['src/a.css'])
  })

  it('skips a node_modules stylesheet', () => {
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/style.css'), ':root { --a: 1; }\n')
    fs.writeFileSync(path.join(dir, 'real.css'), ':root { --a: 1; }\n')
    expect(readTokenWorkspaceFiles(dir).map((f) => f.file)).toEqual(['real.css'])
  })

  it('skips a symlinked .css file and a symlinked directory', () => {
    fs.writeFileSync(path.join(outside, 'victim.css'), ':root { --a: 1; }\n')
    fs.mkdirSync(path.join(outside, 'dir'))
    fs.writeFileSync(path.join(outside, 'dir/inner.css'), ':root { --a: 1; }\n')
    try {
      fs.symlinkSync(path.join(outside, 'victim.css'), path.join(dir, 'link.css'), 'file')
      fs.symlinkSync(path.join(outside, 'dir'), path.join(dir, 'linked-dir'), 'junction')
    } catch {
      // Creating links needs a privilege some Windows accounts lack: nothing to prove there.
      return
    }
    fs.writeFileSync(path.join(dir, 'real.css'), ':root { --a: 1; }\n')
    expect(readTokenWorkspaceFiles(dir).map((f) => f.file)).toEqual(['real.css'])
  })
})

describe('rename / remove refuse up front when the undo journal could not name a file they would rewrite', () => {
  it('a token also named in a .scss file is a read-only-source refusal naming the file, with nothing planned', () => {
    const css = ':root {\n  --a: 1;\n}\n'
    const plan = planTokenEdits(
      [{ file: 'src/index.css', origin: 'project', css }],
      [{ op: 'rename', name: '--a', to: '--b' }],
      [
        { file: 'src/index.css', text: css },
        { file: 'src/theme.scss', text: '.x { margin: var(--a); }\n' },
      ],
    )
    expect(plan).toMatchObject({ ok: false, code: 'read-only-source', details: { declarations: ['src/theme.scss'] } })
  })
})
