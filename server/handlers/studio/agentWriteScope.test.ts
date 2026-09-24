/**
 * agentWriteScope — the native-write control-plane refusal (sec-12).
 *
 * Driven with the paths an escalation would actually use, not with the happy
 * spelling: the direct one, the traversal that arrives at the same file by a
 * longer route, the case variant that reaches it on a case-insensitive
 * filesystem, and the symlink a repository from GitHub can legitimately carry.
 * Each of those is a way to write `.studio/meta.json` — i.e. to promote the
 * project to Tier 2 without the user, which is the consent A10's second gate
 * is built on.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UNWRITABLE_WORKSPACE_DIR_NAMES } from '@core/page-parser'
import { agentContentRefusal, agentToolInputContentRefusal, agentWriteRefusal } from './agentWriteScope'
import { writeStudioMeta } from './studioMeta'
import { ensurePrototypeShell } from './prototypeShell'

const created: string[] = []

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-'))
  created.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, '.studio'), { recursive: true })
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

describe('agentWriteRefusal — what an agent may not write', () => {
  it('refuses .studio/meta.json, the file that carries the trust tier', () => {
    const dir = tmpProject()
    const reason = agentWriteRefusal(join(dir, '.studio', 'meta.json'), dir)
    expect(reason?.code).toBe('protected-path')
    expect(reason?.message).toContain('.studio')
  })

  it('refuses a relative path, resolved against cwd', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal('.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a traversal that arrives at the control plane the long way', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'src', '..', '.studio', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal('src/../.studio/meta.json', dir)).not.toBeNull()
  })

  it('refuses a case variant — the filesystem is case-insensitive on Windows', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.STUDIO', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.Claude', 'settings.local.json'), dir)).not.toBeNull()
  })

  it('refuses spellings Windows resolves to the control plane — trailing dot, trailing space, NTFS stream', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.studio.', 'meta.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.claude ', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.git::$INDEX_ALLOCATION', 'hooks', 'pre-commit'), dir)).not.toBeNull()
  })

  it('refuses a write through a dangling symlink, which would land wherever it points', () => {
    const dir = tmpProject()
    const outside = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-outside-'))
    created.push(outside)
    try {
      symlinkSync(join(outside, 'payload.sh'), join(dir, 'src', 'run.sh'))
    } catch {
      return // unprivileged file symlinks are not always available on Windows
    }
    expect(agentWriteRefusal(join(dir, 'src', 'run.sh'), dir)).not.toBeNull()
  })

  it('refuses .claude/, which holds the settings file wiring this very hook', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.claude', 'settings.local.json'), dir)).not.toBeNull()
    expect(agentWriteRefusal(join(dir, '.claude', '.studio-generated.json'), dir)).not.toBeNull()
  })

  it('refuses .git/, where a planted hook runs on the user\'s next commit', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.git', 'hooks', 'pre-commit'), dir)).not.toBeNull()
  })

  it('refuses a nested control-plane directory, not only one at the project root', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'packages', 'app', '.studio', 'meta.json'), dir)).not.toBeNull()
  })

  it('refuses a symlink that merely LOOKS like source but resolves into the control plane', () => {
    const dir = tmpProject()
    try {
      symlinkSync(join(dir, '.studio'), join(dir, 'src', 'cfg'), 'dir')
    } catch {
      // Unprivileged symlink creation is not always available on Windows —
      // the textual cases above still cover the rest of the predicate.
      return
    }
    // Nothing in this spelling says `.studio`; only the resolved path does.
    expect(agentWriteRefusal(join(dir, 'src', 'cfg', 'meta.json'), dir)).not.toBeNull()
  })

  it('allows the source files an agent actually authors', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, 'src', 'pages', 'Home.tsx'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'pages', 'Home.module.css'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'lib', 'format.ts'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'public', 'logo.svg'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'tsconfig.json'), dir)).toBeNull()
  })

  it('does not refuse a name that merely starts with a forbidden one', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'studio-notes.md'), '')
    expect(agentWriteRefusal(join(dir, '.studiorc'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'studio-notes.md'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'gitignore.ts'), dir)).toBeNull()
  })

  it('judges segments relative to the PROJECT, not over the absolute path', () => {
    // Studio's own checkout sits under `.claude/worktrees/<id>/` and under a
    // `.git`-bearing repo. An absolute-path scan refuses every write in a
    // project that merely lives somewhere so named, which is a dead product,
    // not a secure one.
    const outer = mkdtempSync(join(tmpdir(), 'studio-agent-write-scope-outer-'))
    created.push(outer)
    const project = join(outer, '.claude', 'worktrees', 'wt', 'demo-project')
    mkdirSync(join(project, 'src'), { recursive: true })

    expect(agentWriteRefusal(join(project, 'src', 'Home.tsx'), project)).toBeNull()
    expect(agentWriteRefusal(join(project, '.studio', 'meta.json'), project)).not.toBeNull()
  })

  it('leaves a path outside the project to the process boundary that already owns it', () => {
    // Not this predicate's job and deliberately not claimed: the CLI refuses a
    // write outside `cwd` + `--add-dir` before a hook is consulted at all.
    const dir = tmpProject()
    const elsewhere = tmpProject()
    expect(agentWriteRefusal(join(elsewhere, '.studio', 'meta.json'), dir)).toBeNull()
  })

  it('names .studio, .claude and .git — the escalation set, not a subset', () => {
    for (const name of ['.studio', '.claude', '.git', 'node_modules']) {
      expect(UNWRITABLE_WORKSPACE_DIR_NAMES.has(name), `${name} must be unwritable`).toBe(true)
    }
  })
})

describe('agentWriteRefusal — files that run on the host need the user (security review of #233, F3)', () => {
  // One case per class. The HTTP tools reach the same predicate through
  // agentFileAccess.ts; fileTools.test.ts proves that side, and the spawned
  // hook test in hooks/hooks.test.ts proves the CLI side end to end.
  const CLASSES: ReadonlyArray<readonly [string, string]> = [
    ['Node-executed build config', 'vite.config.ts'],
    ['the same, spelled the way Windows resolves it', 'Vite.Config.JS.'],
    ['a named-mode Vite config', 'vite.prod.config.mjs'],
    ['PostCSS config', 'postcss.config.cjs'],
    ['Tailwind config', 'tailwind.config.js'],
    ['a Babel rc file', '.babelrc'],
    ['the package manifest', 'package.json'],
    ['a nested package manifest', 'packages/app/package.json'],
    ['npm config', '.npmrc'],
    ['an env file', '.env.local'],
    ['a husky git hook', '.husky/pre-commit'],
    ['VS Code tasks', '.vscode/tasks.json'],
    ['a CI workflow', '.github/workflows/ci.yml'],
    ['bun config', 'bunfig.toml'],
    ['the root CLAUDE.md', 'CLAUDE.md'],
    ['a nested CLAUDE.md', 'pages/CLAUDE.md'],
    ['a lint-staged config', '.lintstagedrc.json'],
    ['a lefthook config', 'lefthook.yml'],
    ['a pre-commit config', '.pre-commit-config.yaml'],
    ['a GitLab CI definition', '.gitlab-ci.yml'],
    ['a CircleCI definition', '.circleci/config.yml'],
    ['a Babel JSON config', 'babel.config.json'],
  ]
  for (const [label, rel] of CLASSES) {
    it(`${label} (${rel}) refuses needs-user and says to ask the user`, () => {
      const dir = tmpProject()
      const refusal = agentWriteRefusal(join(dir, ...rel.split('/')), dir)
      expect(refusal?.code).toBe('needs-user')
      expect(refusal?.message).toContain('ask them to make or approve it')
    })
  }

  it('.git and .claude stay protected-path — the control plane Studio owns, not a user approval', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '.git', 'hooks', 'pre-commit'), dir)?.code).toBe('protected-path')
    expect(agentWriteRefusal(join(dir, '.claude', 'settings.local.json'), dir)?.code).toBe('protected-path')
  })

  it('a segment that merely starts with two dots is inside the project (F9)', () => {
    const dir = tmpProject()
    expect(agentWriteRefusal(join(dir, '..foo', '.claude', 'x.json'), dir)?.code).toBe('protected-path')
  })
})

describe('agentWriteRefusal — the re-review bypass (R1): what a host config LOADS runs on the host too', () => {
  it('every file Studio\'s preview-shell templates emit is refused — derived from the templates, so a new one cannot slip through', () => {
    const dir = tmpProject()
    const result = ensurePrototypeShell(dir)
    const emitted = [...new Set([...result.created, ...result.regenerated])]
    // Vacuity guard: the scaffold writes the Vite config, the runtime plugin
    // it imports, and the shell app.
    expect(emitted).toContain('vite.config.js')
    expect(emitted).toContain('prototype/studioRuntime.generated.js')
    expect(emitted.length).toBeGreaterThan(8)
    for (const rel of emitted) {
      const refusal = agentWriteRefusal(join(dir, ...rel.split('/')), dir)
      if (rel === 'index.html') {
        // The one exception: only the browser runs it, and its module script
        // points into prototype/, which is refused.
        expect(refusal, rel).toBeNull()
      } else if (rel === 'vite.config.js' || rel === 'package.json') {
        expect(refusal?.code, rel).toBe('needs-user')
      } else {
        expect(refusal?.code, rel).toBe('protected-path')
      }
    }
  })

  it('a local module a root config imports (depth 1 and 2, with or without an extension) needs the user', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'vite.config.ts'), "import { plugins } from './vite/plugins'\nexport default { plugins: plugins() }\n")
    mkdirSync(join(dir, 'vite'), { recursive: true })
    writeFileSync(join(dir, 'vite', 'plugins.ts'), "import { helper } from './helper.js'\nexport const plugins = () => [helper()]\n")
    writeFileSync(join(dir, 'vite', 'helper.ts'), 'export const helper = () => ({})\n')
    expect(agentWriteRefusal(join(dir, 'vite', 'plugins.ts'), dir)?.code).toBe('needs-user')
    expect(agentWriteRefusal(join(dir, 'vite', 'plugins.ts'), dir)?.message).toContain('imported by vite.config.ts')
    expect(agentWriteRefusal(join(dir, 'vite', 'helper.ts'), dir)?.code).toBe('needs-user')
    expect(agentWriteRefusal(join(dir, 'VITE', 'Plugins.TS'), dir)?.code).toBe('needs-user')
    // A screen next to it is untouched.
    expect(agentWriteRefusal(join(dir, 'vite', 'notes.ts'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'pages', 'Home.tsx'), dir)).toBeNull()
  })

  it('a config that starts importing a new module protects it at once (the cache follows the config)', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'postcss.config.cjs'), 'module.exports = {}\n')
    expect(agentWriteRefusal(join(dir, 'plugins', 'extra.cjs'), dir)).toBeNull()
    writeFileSync(join(dir, 'postcss.config.cjs'), "module.exports = { plugins: [require('./plugins/extra.cjs')] }\n")
    // mtime granularity: make the change unmistakable.
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(dir, 'postcss.config.cjs'), later, later)
    expect(agentWriteRefusal(join(dir, 'plugins', 'extra.cjs'), dir)?.code).toBe('needs-user')
  })
})

// Security re-review 2 of #233, R1 residuals: each needs a loading edge the
// project already has — and Studio runs a nested app's config itself.
describe('agentWriteRefusal — the R1 residuals: every edge that loads a module in Node', () => {
  function write(dir: string, rel: string, contents: string): void {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  const refusalCode = (dir: string, rel: string): string | undefined => agentWriteRefusal(join(dir, ...rel.split('/')), dir)?.code

  it("a nested app's config — the one devServer.ts actually runs — protects what it imports", () => {
    const dir = tmpProject()
    writeStudioMeta(dir, {
      profile: {
        probeVersion: 2,
        appRoot: 'apps/web',
        framework: 'vite',
        pagesDir: 'apps/web/pages',
        routeStyle: 'flat',
        entryFiles: [],
        packageManager: 'npm',
        styleToolchain: { tailwind: null, cssModules: true, sass: false, postcssConfigPath: null, cssInJs: null },
        componentPackages: [],
        aliases: {},
        warnings: [],
      },
    })
    write(dir, 'apps/web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }))
    write(dir, 'apps/web/vite.config.ts', "import { p } from './plugins/p'\nexport default { plugins: [p()] }\n")
    write(dir, 'apps/web/plugins/p.ts', 'export const p = () => ({})\n')
    expect(refusalCode(dir, 'apps/web/plugins/p.ts')).toBe('needs-user')
    expect(refusalCode(dir, 'apps/web/pages/Home.tsx')).toBeUndefined()
  })

  it('a chain three and more imports deep', () => {
    const dir = tmpProject()
    write(dir, 'vite.config.ts', "import './vite/one'\n")
    write(dir, 'vite/one.ts', "import './two'\n")
    write(dir, 'vite/two.ts', "import './three'\n")
    write(dir, 'vite/three.ts', "import './four'\n")
    write(dir, 'vite/four.ts', 'export {}\n')
    expect(refusalCode(dir, 'vite/three.ts')).toBe('needs-user')
    expect(refusalCode(dir, 'vite/four.ts')).toBe('needs-user')
  })

  it('a backtick import() with no substitution', () => {
    const dir = tmpProject()
    write(dir, 'vite.config.ts', 'export default async () => (await import(`./vite/template.js`)).default\n')
    expect(refusalCode(dir, 'vite/template.js')).toBe('needs-user')
    expect(refusalCode(dir, 'vite/template.ts')).toBe('needs-user')
  })

  it('a local plugin named as a key of a PostCSS plugin map, in both config forms', () => {
    const dir = tmpProject()
    write(dir, 'postcss.config.js', "export default { plugins: { './postcss/local-plugin.js': {}, autoprefixer: {} } }\n")
    write(dir, 'postcss/local-plugin.js', 'export default () => ({})\n')
    expect(refusalCode(dir, 'postcss/local-plugin.js')).toBe('needs-user')
    const other = tmpProject()
    write(other, '.postcssrc.json', JSON.stringify({ plugins: { './tools/rc-plugin.cjs': {} } }))
    expect(refusalCode(other, 'tools/rc-plugin.cjs')).toBe('needs-user')
  })

  it('a symlinked root config: the file it points at and what THAT imports, resolved from its own folder', () => {
    const dir = tmpProject()
    write(dir, 'build/real-config.ts', "import dep from './real-dep'\nexport default dep\n")
    write(dir, 'build/real-dep.ts', 'export default {}\n')
    try {
      symlinkSync(join(dir, 'build', 'real-config.ts'), join(dir, 'tailwind.config.ts'), 'file')
    } catch {
      return // unprivileged file symlinks are not always available on Windows
    }
    expect(refusalCode(dir, 'build/real-dep.ts')).toBe('needs-user')
    expect(refusalCode(dir, 'build/real-config.ts')).toBe('needs-user')
  })

  it('the file a dev script names with --config, and its imports', () => {
    const dir = tmpProject()
    write(dir, 'package.json', JSON.stringify({ name: 'p', scripts: { dev: 'vite --config config/vite.ts --port 4000' } }))
    write(dir, 'config/vite.ts', "import { plug } from './plug'\nexport default { plugins: [plug()] }\n")
    write(dir, 'config/plug.ts', 'export const plug = () => ({})\n')
    expect(refusalCode(dir, 'config/vite.ts')).toBe('needs-user')
    expect(refusalCode(dir, 'config/plug.ts')).toBe('needs-user')
  })

  it("Tailwind v4: what a stylesheet's @plugin / @config loads", () => {
    const dir = tmpProject()
    write(dir, 'package.json', JSON.stringify({ name: 'p', devDependencies: { tailwindcss: '^4.0.0', '@tailwindcss/vite': '^4.0.0' } }))
    write(dir, 'src/app.css', '@import "tailwindcss";\n@plugin "./tw/plugin.js";\n@config "../tailwind.legacy.js";\n')
    write(dir, 'src/tw/plugin.js', "import './helper.js'\nexport default {}\n")
    write(dir, 'src/tw/helper.js', 'export {}\n')
    expect(refusalCode(dir, 'src/tw/plugin.js')).toBe('needs-user')
    expect(refusalCode(dir, 'src/tw/helper.js')).toBe('needs-user')
    expect(refusalCode(dir, 'tailwind.legacy.js')).toBe('needs-user')
    // The stylesheet itself stays the agent's to write.
    expect(refusalCode(dir, 'src/app.css')).toBeUndefined()
  })
})

describe('agentContentRefusal — a stylesheet write may not ADD what loads a module in Node', () => {
  it('adding @plugin or @config needs the user, relative or a package name', () => {
    expect(agentContentRefusal('src/app.css', '@import "tailwindcss";\n', '@import "tailwindcss";\n@plugin "./evil.js";\n')?.code).toBe('needs-user')
    expect(agentContentRefusal('src/app.css', null, '@config "./evil.config.js";\n')?.code).toBe('needs-user')
    expect(agentContentRefusal('src/app.css', '', '@plugin "evil-package";\n')?.code).toBe('needs-user')
  })

  it("keeping the directives a file already has, and editing the rest, is the agent's", () => {
    const before = '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n@theme { --color-brand: red; }\n'
    const after = '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n@theme { --color-brand: coral; }\n'
    expect(agentContentRefusal('src/app.css', before, after)).toBeNull()
    expect(agentContentRefusal('src/Home.tsx', '', '@plugin "./x.js"')).toBeNull()
  })

  it('the CLI hook input: an Edit is judged by old_string/new_string, a Write against the file on disk', () => {
    const dir = tmpProject()
    writeFileSync(join(dir, 'src', 'app.css'), '@plugin "./kept.js";\n')
    expect(agentToolInputContentRefusal('src/app.css', dir, { old_string: '/* x */', new_string: '@plugin "./evil.js";' })?.code).toBe('needs-user')
    expect(agentToolInputContentRefusal('src/app.css', dir, { content: '@plugin "./kept.js";\nbody { margin: 0 }\n' })).toBeNull()
    expect(agentToolInputContentRefusal('src/app.css', dir, { content: '@plugin "./kept.js";\n@plugin "./evil.js";\n' })?.code).toBe('needs-user')
  })
})
