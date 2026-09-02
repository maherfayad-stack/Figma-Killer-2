/**
 * styleCompile — WS-2.1 coverage. "Do not reimplement the toolchains — run
 * them" is exercised here by writing tiny, self-contained stand-in packages
 * into each fixture's OWN `node_modules/` (a `sass`/`postcss`/`tailwindcss`/
 * `@tailwindcss/postcss` implementing just enough of the real public API for
 * `compileProjectStyles` to genuinely resolve, `import()`, and call them from
 * the WORKSPACE's own path — never the host admin server's `node_modules`.
 * No network install runs in this suite; every fixture is committed as
 * literal file writes, same discipline as every other handler test here.
 *
 * `probeProject` runs for real against each fixture (never a hand-typed
 * `ProjectProfile` stand-in) so the toolchain detection this module reads is
 * itself under test, matching `studio.test.ts`'s `persistNextAppProfile`
 * precedent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { probeProject } from '../studio/projectProbe'
import { compileProjectStyles, transformCssModuleText } from '../studio/styleCompile'
import { mergeStudioMeta } from '../studio/studioMeta'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../studio/subprocessRunner'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-compile-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function writePackageJson(deps: Record<string, string> = {}): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: deps }))
}

/** A minimal, real-shaped CJS `postcss` stand-in: `postcss(plugins).process(css, opts) -> Promise<{css}>`, applying each plugin as a plain string transform function — the shape every fake plugin below returns. */
function writeFakePostcss(): void {
  write(
    'node_modules/postcss/package.json',
    JSON.stringify({ name: 'postcss', version: '8.0.0-fixture', main: 'index.js' }),
  )
  write(
    'node_modules/postcss/index.js',
    [
      'module.exports = function postcss(plugins) {',
      '  return {',
      '    process(css, opts) {',
      '      let out = css',
      '      for (const p of plugins || []) {',
      "        if (typeof p === 'function') out = p(out, opts)",
      '      }',
      '      return Promise.resolve({ css: out })',
      '    },',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
}

describe('CSS Modules — Tier 0, no trust promotion needed', () => {
  it('rewrites selectors to hashed global names, and lands them in the compiled CSS', async () => {
    write('components/Card.module.css', '.card { color: red }\n.card:hover { color: blue }\n.icon { width: 10px }\n')

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.cssModules).toBe(true)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)

    const classMap = styles.moduleClassMaps['components/Card.module.css']
    expect(classMap).toBeDefined()
    expect(classMap!.card).toMatch(/^Card_card__[0-9a-f]{5}$/)
    expect(classMap!.icon).toMatch(/^Card_icon__[0-9a-f]{5}$/)
    expect(styles.css).toContain(`.${classMap!.card}`)
    expect(styles.css).toContain(`.${classMap!.card}:hover`)
    expect(styles.css).not.toContain('.card {')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(false)
  })

  it('caches the result under .studio/cache, keyed by content', async () => {
    write('components/Card.module.css', '.card { color: red }\n')
    const profile = probeProject(tmpDir)

    const first = await compileProjectStyles(tmpDir, profile)
    const cacheFiles = fs.readdirSync(path.join(tmpDir, '.studio', 'cache'))
    expect(cacheFiles.some((f) => /^styles-[0-9a-f]{16}\.css$/.test(f))).toBe(true)
    expect(cacheFiles.some((f) => /^styles-[0-9a-f]{16}\.json$/.test(f))).toBe(true)

    const second = await compileProjectStyles(tmpDir, profile)
    expect(second.styles).toEqual(first.styles)
  })

  it('leaves :global(...) contents unrenamed', () => {
    const { css, classMap } = transformCssModuleText('.card { color: red }\n:global(.legacy) { color: blue }\n', 'x.module.css')
    expect(css).toContain(':global(.legacy)')
    expect(classMap.legacy).toBeUndefined()
    expect(classMap.card).toBeDefined()
  })
})

describe('Sass — Tier 1, gated on trust', () => {
  function writeSassFixture(): void {
    writePackageJson({ sass: '^1.0.0' })
    write('styles/theme.scss', '$primary: hotpink;\n.button { color: $primary; }\n')
  }

  function writeFakeSass(): void {
    write('node_modules/sass/package.json', JSON.stringify({ name: 'sass', version: '1.0.0-fixture', main: 'index.js' }))
    write(
      'node_modules/sass/index.js',
      [
        'module.exports.compileString = function compileString(source) {',
        "  const withoutDecl = source.replace(/\\$primary\\s*:[^;]*;\\n?/, '')",
        "  return { css: withoutDecl.replace(/\\$primary/g, 'hotpink') }",
        '}',
        '',
      ].join('\n'),
    )
  }

  it('refuses to run at Tier 0 (static) — warns instead of compiling', async () => {
    writeSassFixture()
    writeFakeSass()
    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.sass).toBe(true)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(true)
  })

  it("compiles through the workspace's own sass once promoted past Tier 0", async () => {
    writeSassFixture()
    writeFakeSass()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.css).toContain('color: hotpink')
    expect(styles.css).not.toContain('$primary')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(false)
  })
})

describe('PostCSS incl. Tailwind v3 — Tier 1, gated on trust', () => {
  function writeFakeTailwindV3(): void {
    write('node_modules/tailwindcss/package.json', JSON.stringify({ name: 'tailwindcss', version: '3.0.0-fixture', main: 'index.js' }))
    write(
      'node_modules/tailwindcss/index.js',
      [
        'module.exports = function tailwindcss(config) {',
        '  return function (css) {',
        "    return css.replace(/@tailwind[^;]*;\\n?/g, '') + '\\n.tw-generated { color: hotpink }\\n'",
        '  }',
        '}',
        '',
      ].join('\n'),
    )
  }

  function writeFixture(): void {
    writePackageJson({ tailwindcss: '^3.4.0' })
    write('tailwind.config.js', "module.exports = { content: ['./**/*.{js,jsx}'] }\n")
    write('postcss.config.js', "module.exports = { plugins: [require('tailwindcss')()] }\n")
    write('src/index.css', '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n.custom { color: green }\n')
    writeFakeTailwindV3()
    writeFakePostcss()
  }

  it('detects v3 via the config file', () => {
    writeFixture()
    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind?.configPath).toBe('tailwind.config.js')
    expect(profile.styleToolchain.postcssConfigPath).toBe('postcss.config.js')
  })

  it('refuses to run at Tier 0 — warns instead of compiling', async () => {
    writeFixture()
    const profile = probeProject(tmpDir)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(true)
  })

  it("runs the workspace's own postcss + tailwindcss once promoted, emitting the JIT-generated utility", async () => {
    writeFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.css).toContain('.tw-generated { color: hotpink }')
    expect(styles.css).not.toContain('@tailwind')
    expect(warnings.some((w) => w.code.startsWith('tailwind-') || w.code.startsWith('postcss-'))).toBe(false)
  })
})

describe('Tailwind v4 — detected by @import, not config presence', () => {
  function writeFixture(): void {
    writePackageJson({ tailwindcss: '^4.0.0' })
    write('src/app.css', '@import "tailwindcss";\n.custom { color: green }\n')
    write(
      'node_modules/@tailwindcss/postcss/package.json',
      JSON.stringify({ name: '@tailwindcss/postcss', version: '4.0.0-fixture', main: 'index.js' }),
    )
    write(
      'node_modules/@tailwindcss/postcss/index.js',
      [
        'module.exports = function tailwindcssPostcss() {',
        '  return function (css) {',
        '    return css.replace(\'@import "tailwindcss";\', \'\') + \'\\n.tw4-generated { color: blue }\\n\'',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    writeFakePostcss()
  }

  it('detects v4 via the `@import "tailwindcss"` stylesheet, no config file needed', () => {
    writeFixture()
    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind?.configPath).toBe('src/app.css')
    expect(profile.styleToolchain.postcssConfigPath).toBeNull()
  })

  it("runs the workspace's own @tailwindcss/postcss once promoted past Tier 0", async () => {
    writeFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.css).toContain('.tw4-generated { color: blue }')
    expect(styles.css).not.toContain('@import "tailwindcss"')
    expect(warnings.some((w) => w.code.startsWith('tailwind-') || w.code.startsWith('postcss-'))).toBe(false)
  })
})

describe('No node_modules — degrades with a warning instead of throwing', () => {
  it('reports dependencies-not-installed rather than crashing', async () => {
    writePackageJson({ sass: '^1.0.0' })
    write('styles/theme.scss', '.button { color: red }\n')
    mergeStudioMeta(tmpDir, { trust: 'render-packages' }) // promoted, but node_modules still doesn't exist
    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.sass).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'node_modules'))).toBe(false)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)

    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'dependencies-not-installed')).toBe(true)
  })
})

describe('Plain CSS / no toolchain — a no-op fast path', () => {
  it('returns empty styles immediately for a project with no Tailwind/Sass/PostCSS/CSS-Modules', async () => {
    write('pages/Home.css', '.hero { color: red }\n')
    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.cssModules).toBe(false)
    expect(profile.styleToolchain.sass).toBe(false)
    expect(profile.styleToolchain.tailwind).toBeNull()
    expect(profile.styleToolchain.postcssConfigPath).toBeNull()

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles).toEqual({ css: '', moduleClassMaps: {}, vendorCss: '' })
    expect(warnings).toEqual([])
    // No cache written — nothing was compiled.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'cache'))).toBe(false)
  })
})

describe('Vendor package CSS (WS-2.3) — Tier 0 safe, never trust-gated', () => {
  it('reads a bare-specifier package stylesheet verbatim into vendorCss, never into css/moduleClassMaps', async () => {
    write('src/App.tsx', "import '@acme/ui/dist/style.css'\nexport default function App() { return null }\n")
    write('node_modules/@acme/ui/dist/style.css', '.btn--primary { color: hotpink }\n')
    writePackageJson({ '@acme/ui': '^1.0.0' })

    const profile = probeProject(tmpDir)
    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)

    expect(styles.vendorCss).toContain('.btn--primary { color: hotpink }')
    expect(styles.css).not.toContain('.btn--primary')
    expect(styles.moduleClassMaps).toEqual({})
    expect(warnings.some((w) => w.code.startsWith('vendor-css-'))).toBe(false)
  })

  it('requires no trust promotion — runs at the default Tier 0', async () => {
    write('src/App.tsx', "import '@acme/ui/dist/style.css'\n")
    write('node_modules/@acme/ui/dist/style.css', '.btn { color: teal }\n')
    const profile = probeProject(tmpDir)
    // No mergeStudioMeta({ trust: ... }) call — stays at the DEFAULT_TRUST_TIER.

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.vendorCss).toContain('color: teal')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(false)
  })

  it('ignores relative and package .module.css bare imports', async () => {
    write('src/App.tsx', "import './App.css'\nimport 'pkg/dist/theme.module.css'\n")
    write('src/App.css', '.local { color: red }\n')
    write('node_modules/pkg/dist/theme.module.css', '.card { color: blue }\n')
    const profile = probeProject(tmpDir)

    const { styles } = await compileProjectStyles(tmpDir, profile)
    expect(styles.vendorCss).toBe('')
  })

  it('degrades with a warning when node_modules is missing, instead of throwing', async () => {
    write('src/App.tsx', "import '@acme/ui/dist/style.css'\n")
    const profile = probeProject(tmpDir)
    expect(fs.existsSync(path.join(tmpDir, 'node_modules'))).toBe(false)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.vendorCss).toBe('')
    expect(warnings.some((w) => w.code === 'vendor-css-requires-install')).toBe(true)
  })

  it('warns, but does not throw, when the specifier resolves to a file that does not exist', async () => {
    write('src/App.tsx', "import '@acme/ui/dist/missing.css'\n")
    write('node_modules/@acme/ui/package.json', JSON.stringify({ name: '@acme/ui', main: 'index.js' }))
    write('node_modules/@acme/ui/index.js', 'module.exports = {}\n')
    const profile = probeProject(tmpDir)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile)
    expect(styles.vendorCss).toBe('')
    expect(warnings.some((w) => w.code === 'vendor-css-not-resolved')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sec-01 — Tier 1 compilation runs in a subprocess, never in this process.
// Every test below injects a fake `spawn` (and, where a timeout is under
// test, fake timers) through `compileProjectStyles`'s `StyleCompileOverrides`
// test seam — no real subprocess, no real wall-clock wait. Correctness of the
// REAL subprocess path (genuinely spawning `bun styleCompileWorker.ts` and
// running the fixture's own fake sass/postcss/tailwind packages) is already
// exercised by every other `it(...)` above, which call `compileProjectStyles`
// with no overrides at all.
// ---------------------------------------------------------------------------

describe('sec-01 — Tier 1 compilation runs in a subprocess', () => {
  function writeSassFixture(): void {
    writePackageJson({ sass: '^1.0.0' })
    write('styles/theme.scss', '.button { color: red }\n')
    write('node_modules/sass/package.json', JSON.stringify({ name: 'sass', main: 'index.js' }))
    write('node_modules/sass/index.js', 'module.exports.compileString = (s) => ({ css: s })\n')
  }

  function streamFromString(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  interface SpawnCall {
    argv: string[]
    cwd: string
    env: Record<string, string>
  }

  function makeSpawnSpy(processFactory: () => SpawnedProcessLike): { spawn: SubprocessSpawnFn; calls: SpawnCall[] } {
    const calls: SpawnCall[] = []
    const spawn: SubprocessSpawnFn = (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd, env: options.env })
      return processFactory()
    }
    return { spawn, calls }
  }

  function makeFakeProcess(opts: { stdout?: string; stderr?: string; exitCode?: number; hangUntilKilled?: boolean } = {}): {
    proc: SpawnedProcessLike
    wasKilled: () => boolean
  } {
    let killed = false
    let resolveExited!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve
    })
    if (!opts.hangUntilKilled) resolveExited(opts.exitCode ?? 0)
    const proc: SpawnedProcessLike = {
      stdout: streamFromString(opts.stdout ?? ''),
      stderr: streamFromString(opts.stderr ?? ''),
      exited,
      kill: () => {
        killed = true
        resolveExited(opts.exitCode ?? -1)
      },
    }
    return { proc, wasKilled: () => killed }
  }

  function makeImmediateTimer(): { setTimeoutImpl: typeof setTimeout; clearTimeoutImpl: typeof clearTimeout } {
    const setTimeoutImpl = ((handler: () => void) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    const clearTimeoutImpl = (() => {}) as typeof clearTimeout
    return { setTimeoutImpl, clearTimeoutImpl }
  }

  it('never spawns anything at Tier 0 — the trust gate is checked before a subprocess would exist', async () => {
    writeSassFixture()
    // No mergeStudioMeta({ trust: ... }) — stays at the default Tier 0.
    const profile = probeProject(tmpDir)
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile, { spawn })

    expect(calls).toHaveLength(0)
    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'style-toolchain-requires-trust-promotion')).toBe(true)
  })

  it('spawns the worker via process.execPath with the task as argv[2], cwd = the project dir, no shell string', async () => {
    writeSassFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ stdout: JSON.stringify({ css: 'compiled', errors: [] }), exitCode: 0 }).proc)

    const { styles } = await compileProjectStyles(tmpDir, profile, { spawn })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv[0]).toBe(process.execPath)
    expect(calls[0]!.argv[1]).toMatch(/styleCompileWorker\.ts$/)
    const task = JSON.parse(calls[0]!.argv[2]!)
    expect(task.kind).toBe('sass')
    expect(path.resolve(calls[0]!.cwd)).toBe(path.resolve(tmpDir))
    expect(styles.css).toContain('compiled')
  })

  it('never forwards STUDIO_SECRET_KEY/DATABASE_URL to the compiler subprocess, even when set in this process', async () => {
    const originalKey = process.env.STUDIO_SECRET_KEY
    const originalDb = process.env.DATABASE_URL
    process.env.STUDIO_SECRET_KEY = 'top-secret-test-value'
    process.env.DATABASE_URL = 'postgres://leak-me'
    try {
      writeSassFixture()
      mergeStudioMeta(tmpDir, { trust: 'render-packages' })
      const profile = probeProject(tmpDir)
      const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ stdout: JSON.stringify({ css: '', errors: [] }), exitCode: 0 }).proc)

      await compileProjectStyles(tmpDir, profile, { spawn })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.env.STUDIO_SECRET_KEY).toBeUndefined()
      expect(calls[0]!.env.DATABASE_URL).toBeUndefined()
      expect(Object.values(calls[0]!.env)).not.toContain('top-secret-test-value')
      expect(Object.values(calls[0]!.env)).not.toContain('postgres://leak-me')
    } finally {
      if (originalKey === undefined) delete process.env.STUDIO_SECRET_KEY
      else process.env.STUDIO_SECRET_KEY = originalKey
      if (originalDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDb
    }
  })

  it('kills the subprocess and surfaces a warning on timeout — no real wait', async () => {
    writeSassFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)
    const { proc, wasKilled } = makeFakeProcess({ hangUntilKilled: true })
    const { spawn } = makeSpawnSpy(() => proc)
    const timer = makeImmediateTimer()

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile, { spawn, ...timer })

    expect(wasKilled()).toBe(true)
    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'sass-compile-failed' && w.message.includes('timed out'))).toBe(true)
  })

  it('degrades to a warning instead of throwing when the worker floods stdout past the cap', async () => {
    writeSassFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)
    // Larger than STYLE_WORKER_MAX_STDOUT_BYTES (4 MiB) — the cap truncates
    // it mid-stream, so what survives is not valid JSON.
    const flood = '{"css":"' + 'x'.repeat(5 * 1024 * 1024)
    const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ stdout: flood, exitCode: 0 }).proc)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile, { spawn })

    expect(calls).toHaveLength(1)
    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'sass-compile-failed' && w.message.includes('could not be read'))).toBe(true)
  })

  it('surfaces a non-zero worker exit as a warning, never a thrown error', async () => {
    writeSassFixture()
    mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    const profile = probeProject(tmpDir)
    const { spawn } = makeSpawnSpy(() => makeFakeProcess({ stderr: 'sass: unexpected token', exitCode: 1 }).proc)

    const { styles, warnings } = await compileProjectStyles(tmpDir, profile, { spawn })

    expect(styles.css).toBe('')
    expect(warnings.some((w) => w.code === 'sass-compile-failed' && w.message.includes('exited with code 1'))).toBe(true)
  })

  it('refuses a postcss.config.js that resolves outside the project through a symlink, and never spawns', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-compile-outside-'))
    try {
      writePackageJson({ tailwindcss: '^3.4.0' })
      write('tailwind.config.js', "module.exports = { content: ['./**/*.{js,jsx}'] }\n")
      write('postcss.config.js', "module.exports = { plugins: [] }\n")
      write('src/index.css', '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n')
      write('node_modules/tailwindcss/package.json', JSON.stringify({ name: 'tailwindcss', main: 'index.js' }))
      write('node_modules/tailwindcss/index.js', 'module.exports = function () { return function (css) { return css } }\n')
      writeFakePostcss()

      const profile = probeProject(tmpDir)
      expect(profile.styleToolchain.postcssConfigPath).toBe('postcss.config.js')
      mergeStudioMeta(tmpDir, { trust: 'render-packages' })

      // Swap the real config for a symlink pointing outside the project —
      // simulating a repo that ships a symlinked config file.
      const outsideConfig = path.join(outsideDir, 'evil-postcss.config.js')
      fs.writeFileSync(outsideConfig, 'module.exports = { plugins: [] }\n', 'utf8')
      fs.rmSync(path.join(tmpDir, 'postcss.config.js'))
      try {
        fs.symlinkSync(outsideConfig, path.join(tmpDir, 'postcss.config.js'), 'file')
      } catch {
        // Some hosts (notably Windows without Developer Mode / elevation)
        // refuse to create symlinks — nothing to test there.
        return
      }

      const { spawn, calls } = makeSpawnSpy(() => makeFakeProcess({ exitCode: 0 }).proc)
      const { styles, warnings } = await compileProjectStyles(tmpDir, profile, { spawn })

      expect(calls).toHaveLength(0)
      expect(styles.css).toBe('')
      expect(warnings.some((w) => w.code === 'postcss-config-load-failed' && w.message.includes('symlink'))).toBe(true)
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
