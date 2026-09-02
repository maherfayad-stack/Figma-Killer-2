/**
 * styleCompileWorker.ts — direct unit coverage of `runWorkerTask`, the pure
 * logic the subprocess entry point runs (`sec-01`). No subprocess is spawned
 * here — real end-to-end subprocess execution is exercised by
 * `styleCompile.test.ts`'s non-overridden tests, which genuinely spawn `bun
 * styleCompileWorker.ts`. This file targets what that path doesn't
 * conveniently reach: the named-plugin-map form of `postcss.config.js`'s
 * `plugins` (`{ tailwindcss: {}, autoprefixer: {} }`), which resolves each
 * package independently INSIDE the worker via
 * `resolveWorkspacePackageEntry` — including the symlink-escape case.
 *
 * `runWorkerTask` takes `cwd` as an explicit second argument (defaulting to
 * `process.cwd()` for the real subprocess path) precisely so these tests can
 * point it at a fixture dir without a global, test-isolation-risking
 * `process.chdir()`.
 */
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runWorkerTask, type PostcssTask, type SassTask } from '../studio/styleCompileWorker'

function write(dir: string, relPath: string, contents: string): string {
  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

describe('runWorkerTask — sass', () => {
  it('compiles every file and concatenates the output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-sass-'))
    try {
      const sassEntry = write(tmpDir, 'node_modules/sass/index.js', 'module.exports.compileString = (s) => ({ css: s.toUpperCase() })\n')
      write(tmpDir, 'a.scss', '.a{}')
      write(tmpDir, 'b.scss', '.b{}')

      const task: SassTask = { kind: 'sass', sassEntryAbsPath: sassEntry, files: ['a.scss', 'b.scss'] }
      const result = await runWorkerTask(task, tmpDir)
      expect(result.errors).toEqual([])
      expect(result.css).toContain('.A{}')
      expect(result.css).toContain('.B{}')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports a per-file error without failing the whole task', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-sass-err-'))
    try {
      const sassEntry = write(
        tmpDir,
        'node_modules/sass/index.js',
        "module.exports.compileString = (s) => { if (s.includes('BAD')) throw new Error('syntax error'); return { css: s } }\n",
      )
      write(tmpDir, 'good.scss', '.good{}')
      write(tmpDir, 'bad.scss', 'BAD')

      const task: SassTask = { kind: 'sass', sassEntryAbsPath: sassEntry, files: ['good.scss', 'bad.scss'] }
      const result = await runWorkerTask(task, tmpDir)
      expect(result.css).toContain('.good{}')
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.relPath).toBe('bad.scss')
      expect(result.errors[0]!.message).toContain('syntax error')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns an error, never throws, when the sass module has no compileString export', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-sass-bad-mod-'))
    try {
      const sassEntry = write(tmpDir, 'node_modules/sass/index.js', 'module.exports = {}\n')
      const task: SassTask = { kind: 'sass', sassEntryAbsPath: sassEntry, files: [] }
      const result = await runWorkerTask(task, tmpDir)
      expect(result.css).toBeUndefined()
      expect(result.errors[0]!.message).toContain('compileString')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('runWorkerTask — postcss, named-plugin-map config form', () => {
  function writeFakePostcss(tmpDir: string): string {
    return write(
      tmpDir,
      'node_modules/postcss/index.js',
      [
        'module.exports = function postcss(plugins) {',
        '  return { process(css) {',
        '    let out = css',
        '    for (const p of plugins) out = p(out)',
        '    return { css: out }',
        '  } }',
        '}',
        '',
      ].join('\n'),
    )
  }

  it('resolves each named plugin through resolveWorkspacePackageEntry and invokes it with its options', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-postcss-map-'))
    try {
      const postcssEntry = writeFakePostcss(tmpDir)
      write(tmpDir, 'node_modules/my-plugin/package.json', JSON.stringify({ name: 'my-plugin', main: 'index.js' }))
      write(tmpDir, 'node_modules/my-plugin/index.js', "module.exports = (opts) => (css) => css + '/* ' + (opts && opts.tag) + ' */'\n")
      write(tmpDir, 'postcss.config.js', "module.exports = { plugins: { 'my-plugin': { tag: 'from-config' } } }\n")
      write(tmpDir, 'entry.css', '.x{}')

      const task: PostcssTask = {
        kind: 'postcss',
        postcssEntryAbsPath: postcssEntry,
        entryRelPath: 'entry.css',
        pluginEntryAbsPaths: [],
        postcssConfigAbsPath: path.join(tmpDir, 'postcss.config.js'),
      }
      const result = await runWorkerTask(task, tmpDir)
      expect(result.errors).toEqual([])
      expect(result.css).toContain('.x{}')
      expect(result.css).toContain('/* from-config */')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('silently skips a named plugin whose node_modules entry is a symlink escaping the project, when the host permits creating one', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-postcss-escape-'))
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-postcss-escape-outside-'))
    try {
      const postcssEntry = writeFakePostcss(tmpDir)
      const maliciousEntry = write(outsideDir, 'index.js', "module.exports = () => (css) => css + '/* PWNED */'\n")
      write(tmpDir, 'node_modules/evil-plugin/package.json', JSON.stringify({ name: 'evil-plugin', main: 'index.js' }))
      const linkPath = path.join(tmpDir, 'node_modules', 'evil-plugin', 'index.js')

      try {
        fs.symlinkSync(maliciousEntry, linkPath, 'file')
      } catch {
        // Some hosts (notably Windows without Developer Mode / elevation)
        // refuse to create symlinks — nothing to test there.
        return
      }

      write(tmpDir, 'postcss.config.js', "module.exports = { plugins: { 'evil-plugin': {} } }\n")
      write(tmpDir, 'entry.css', '.x{}')

      const task: PostcssTask = {
        kind: 'postcss',
        postcssEntryAbsPath: postcssEntry,
        entryRelPath: 'entry.css',
        pluginEntryAbsPaths: [],
        postcssConfigAbsPath: path.join(tmpDir, 'postcss.config.js'),
      }
      const result = await runWorkerTask(task, tmpDir)
      // The plugin was refused (not resolved via the symlink), so it never
      // ran — the marker it would have injected must not appear anywhere,
      // and the task reports "no plugins resolved" rather than silently
      // producing unstyled output.
      expect(result.css ?? '').not.toContain('PWNED')
      expect(result.css).toBeUndefined()
      expect(result.errors.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
