/**
 * `ensurePrototypeShell` runs once per project per process, and again only
 * when one of its inputs changes (`prototypeShell/shellInputStamp.ts`).
 *
 * Every `/load` calls it. Before the stamp, each call re-read and compared
 * every shell file (the 2 MB runtime bundle among them), re-read `.studio/`
 * and walked the pages dir — about 8 ms of a 25 ms warm load, spent finding
 * that nothing had changed.
 *
 * `settle()` backdates the whole workspace: a stamp is only trusted when every
 * input is older than the run that read it (the racy rule), and a test writes
 * its files milliseconds before it calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensurePrototypeShell } from '../prototypeShell'
import { autoPlaceBoardFrame } from '../boardFrames'

let tmpDir: string

function write(rel: string, contents: string): void {
  const abs = path.join(tmpDir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

function read(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf8')
}

/** Every file and directory in the workspace, ten seconds in the past. */
function settle(): void {
  const past = new Date(Date.now() - 10_000)
  const visit = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name)
      if (entry.isDirectory()) visit(child)
      fs.utimesSync(child, past, past)
    }
  }
  visit(tmpDir)
}

/** Scaffold, settle, and run once more so the stamp is taken on a quiet tree. */
function scaffoldAndStamp(): void {
  ensurePrototypeShell(tmpDir)
  settle()
  expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-shell-once-'))
  write('pages/Home.tsx', 'export default function Home() { return <div /> }\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ensurePrototypeShell — once per project, again only when an input changes', () => {
  it('answers every later call from the stamp, without a real run', () => {
    scaffoldAndStamp()
    for (let call = 0; call < 3; call += 1) {
      expect(ensurePrototypeShell(tmpDir)).toEqual({
        created: [],
        regenerated: [],
        viteConfigEditedByUser: false,
        inputsUnchanged: true,
      })
    }
  })

  it('never trusts a stamp whose inputs moved during or just before the run', () => {
    ensurePrototypeShell(tmpDir)
    // Everything was written a moment ago: a same-size rewrite in the same
    // timestamp tick would be invisible, so the next call runs for real.
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
  })

  it('repeats a hand-edited vite.config.js verdict from the stamp', () => {
    ensurePrototypeShell(tmpDir)
    write('vite.config.js', 'export default {}\n')
    settle()
    expect(ensurePrototypeShell(tmpDir).viteConfigEditedByUser).toBe(true)
    expect(ensurePrototypeShell(tmpDir)).toMatchObject({ viteConfigEditedByUser: true, inputsUnchanged: true })
  })

  it('runs again when a board changes', () => {
    scaffoldAndStamp()
    autoPlaceBoardFrame(tmpDir, 'home')
    const result = ensurePrototypeShell(tmpDir)
    expect(result.inputsUnchanged).toBe(false)
    expect(result.regenerated).toContain('prototype/registry.generated.jsx')
    expect(read('prototype/registry.generated.jsx')).toContain('"pageId":"home"')
  })

  it('runs again when a page is added, at the top of the pages dir or in a folder under it', () => {
    write('pages/auth/Login.tsx', 'export default function Login() { return <div /> }\n')
    scaffoldAndStamp()

    write('pages/SignUp.tsx', 'export default function SignUp() { return <div /> }\n')
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
    expect(read('prototype/registry.generated.jsx')).toContain("import SignUp from '../pages/SignUp'")

    settle()
    ensurePrototypeShell(tmpDir)
    write('pages/auth/Reset.tsx', 'export default function Reset() { return <div /> }\n')
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
    expect(read('prototype/registry.generated.jsx')).toContain("from '../pages/auth/Reset'")
  })

  it('runs again when a page is deleted', () => {
    write('pages/SignUp.tsx', 'export default function SignUp() { return <div /> }\n')
    scaffoldAndStamp()
    fs.rmSync(path.join(tmpDir, 'pages', 'SignUp.tsx'))
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
    expect(read('prototype/registry.generated.jsx')).not.toContain('SignUp')
  })

  it('runs again when .studio/meta.json changes', () => {
    scaffoldAndStamp()
    write('.studio/meta.json', JSON.stringify({ frameDefaults: { width: 1234, height: 800 } }))
    expect(ensurePrototypeShell(tmpDir).inputsUnchanged).toBe(false)
    expect(read('prototype/registry.generated.jsx')).toContain('1234')
  })

  it('runs again when the project gains a LanguageContext', () => {
    scaffoldAndStamp()
    write('i18n/LanguageContext.tsx', 'export const x = 1\n')
    expect(ensurePrototypeShell(tmpDir).regenerated).toContain('prototype/providers.generated.jsx')
  })

  it('brings back a shell file that was deleted, and a generated one that was edited', () => {
    scaffoldAndStamp()
    fs.rmSync(path.join(tmpDir, 'prototype', 'App.jsx'))
    expect(ensurePrototypeShell(tmpDir).created).toEqual(['prototype/App.jsx'])

    settle()
    ensurePrototypeShell(tmpDir)
    write('prototype/registry.generated.jsx', 'garbage\n')
    expect(ensurePrototypeShell(tmpDir).regenerated).toEqual(['prototype/registry.generated.jsx'])
  })

  it('merges package.json again when the user rewrites it', () => {
    scaffoldAndStamp()
    write('package.json', JSON.stringify({ name: 'mine' }))
    ensurePrototypeShell(tmpDir)
    expect(JSON.parse(read('package.json'))).toMatchObject({ name: 'mine', devDependencies: { vite: expect.any(String) } })
  })
})
