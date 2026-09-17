import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunCommand, bunRunCommand, viteCommand } from '../../scripts/lib/bunCommand'
import {
  GENERATED_ARTEFACTS,
  INSTALL_STAMP_FILENAME,
  installReason,
  localFileDependencies,
  type DependencyPaths,
} from '../../scripts/lib/devPreflight'

const root = new URL('../../', import.meta.url)

function readSiteFile(path: string) {
  return readFileSync(new URL(path, root), 'utf-8')
}

describe('development workflow', () => {
  it('`bun run dev` is the one-command launcher for cms + vite', () => {
    const pkg = JSON.parse(readSiteFile('package.json')) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts['dev']).toBe('bun run scripts/dev.ts')
    expect(pkg.scripts['dev:agent']).toBe('bun run dev:server')
    expect(pkg.scripts['dev:server']).toBe('bun --watch server/index.ts')
    expect(pkg.scripts['dev:vite']).toBe('bun run scripts/vite.ts')
    expect(pkg.scripts['build']).toBe('tsc -b && bun run scripts/vite.ts build')
    expect(pkg.scripts['preview']).toBe('bun run scripts/vite.ts preview')
    expect(pkg.scripts['dev:all']).toBeUndefined()
    expect(existsSync(new URL('scripts/dev.ts', root))).toBe(true)
    expect(existsSync(new URL('scripts/vite.ts', root))).toBe(true)
    expect(existsSync(new URL('scripts/dev-all.ts', root))).toBe(false)

    const script = readSiteFile('scripts/dev.ts')
    // Spawns cms + vite without a recursive `bun run dev` call.
    expect(script).toContain("bunCommand('--watch', 'server/index.ts')")
    expect(script).toContain("viteCommand('--host', '127.0.0.1'")
    expect(script).not.toContain('command: `vite')
    expect(script).not.toContain('command.split')
    // Knows about the docker postgres host port.
    expect(script).toContain('127.0.0.1')
    expect(script).toContain('5433')
    // Manages the docker postgres + app containers.
    expect(script).toContain('compose')
    expect(script).toContain('postgres')
    expect(script).toContain('app')
    // Forwards signals to children.
    expect(script).toContain('SIGINT')
    expect(script).toContain('SIGTERM')
  })

  it('development launchers route local Vite binaries through Bun on Windows', () => {
    const devScript = readSiteFile('scripts/dev.ts')
    const e2eScript = readSiteFile('scripts/e2e-dev.ts')
    const startScript = readSiteFile('scripts/start.ts')
    const viteScript = readSiteFile('scripts/vite.ts')

    expect(bunCommand('--watch', 'server/index.ts')).toEqual([
      process.execPath,
      '--watch',
      'server/index.ts',
    ])
    const viteDevCommand = viteCommand('--host', '127.0.0.1')
    expect(viteDevCommand[0]).toBe(process.execPath)
    expect(viteDevCommand[1].replaceAll('\\', '/')).toEndWith('/node_modules/vite/bin/vite.js')
    expect(viteDevCommand.slice(2)).toEqual(['--host', '127.0.0.1'])
    expect(existsSync(viteDevCommand[1])).toBe(true)

    expect(devScript).toContain("viteCommand('--host', '127.0.0.1'")
    expect(devScript).not.toContain("bunRunCommand('dev:vite'")
    expect(devScript).not.toContain("bunRunCommand('vite'")
    expect(devScript).not.toContain('command: `vite')
    expect(devScript).not.toContain('command.split')
    expect(e2eScript).toContain("viteCommand('--host', '127.0.0.1'")
    expect(e2eScript).not.toContain("bunRunCommand('dev:vite'")
    expect(e2eScript).not.toContain("bunRunCommand('vite'")
    expect(e2eScript).not.toContain("['vite'")
    expect(e2eScript).not.toContain("['bun'")
    expect(viteScript).toContain('viteCommand(...Bun.argv.slice(2))')
    expect(viteScript).not.toContain("['vite'")
    expect(startScript).toContain("bunRunCommand('build')")
    expect(startScript).toContain("bunRunCommand('server/index.ts')")
    expect(startScript).not.toContain("['bun'")
  })

  it('Vite proxies CMS API and uploaded media to the local Bun server', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    // `/admin/api` covers both the CMS endpoints (`/admin/api/cms/...`) and
    // the agent endpoints (`/admin/api/agent`, `/admin/api/agent/tool-result`).
    // The shared `/admin/` prefix is required so the session cookie (scoped
    // to `Path=/admin`) is sent on every request to the Bun backend.
    expect(viteConfig).toContain("'/admin/api'")
    expect(viteConfig).toContain("'/uploads'")
    expect(viteConfig).toContain("const CMS_DEV_SERVER_ORIGIN = `http://localhost:${process.env.PORT ?? '3001'}`")
    expect(viteConfig).toContain('target: CMS_DEV_SERVER_ORIGIN')
    expect(viteConfig).toContain('changeOrigin: true')
  })

  it('Vite forwards public page routes to the CMS server instead of the admin SPA', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    expect(viteConfig).toContain('function publicSiteDevProxyPlugin')
    expect(viteConfig).toContain('publicSiteDevProxyPlugin()')
    expect(viteConfig).toContain("pathname === '/admin'")
    expect(viteConfig).toContain("pathname.startsWith('/admin/')")
    expect(viteConfig).toContain("pathname === '/'")
    expect(viteConfig).toContain('proxyPublicSiteRequest')
  })

  it('Vite forwards published runtime assets to the CMS server in local dev', () => {
    const viteConfig = readSiteFile('vite.config.ts')

    expect(viteConfig).toContain("pathname.startsWith('/_studio/assets/')")
  })

  it('Docker Postgres uses a non-default host port for local dev', () => {
    const compose = readSiteFile('docker-compose.yml')

    // docker-compose.yml is dev-only and only exposes the Postgres container
    // on a non-default host port (5433) to avoid clashing with a local
    // Postgres install. The DATABASE_URL the app uses to reach the container
    // lives in compose.prod.yml — not in the dev-only compose file.
    expect(compose).toContain('"5433:5432"')
    expect(compose).toContain('image: postgres:16')
  })
})

/**
 * `scripts/lib/devPreflight.ts` (work order Z7). Every case below is a
 * REJECTION — a checkout state that must trigger an install or a drift line.
 * The happy path is the boring one: silence.
 */
describe('dev preflight', () => {
  const tempRoots: string[] = []

  function fixture(options: {
    nodeModules?: boolean
    fileDeps?: Record<string, string>
    linked?: string[]
    stamp?: boolean
    lockfile?: boolean
  }): DependencyPaths {
    const root = mkdtempSync(join(tmpdir(), 'studio-preflight-'))
    tempRoots.push(root)

    const dependencies: Record<string, string> = { react: '^19.2.5', ...options.fileDeps }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies }))

    const lockfile = join(root, 'bun.lock')
    if (options.lockfile !== false) writeFileSync(lockfile, '{}')

    // The stamp is written AFTER the lockfile, exactly as a real install does:
    // `bun install` rewrites `bun.lock` and only then is the install complete.
    const nodeModules = join(root, 'node_modules')
    if (options.nodeModules !== false) {
      mkdirSync(nodeModules)
      for (const name of options.linked ?? []) mkdirSync(join(nodeModules, name), { recursive: true })
      if (options.stamp !== false) writeFileSync(join(nodeModules, INSTALL_STAMP_FILENAME), 'stamped\n')
    }

    return { packageJson: join(root, 'package.json'), nodeModules, lockfile }
  }

  afterEach(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  it('says nothing when the checkout is already installed', () => {
    const paths = fixture({ fileDeps: { 'alm-design-system': 'file:./vendor/alm-design-system' }, linked: ['alm-design-system'] })
    expect(installReason(paths)).toBeNull()
  })

  it('installs when node_modules/ is absent', () => {
    expect(installReason(fixture({ nodeModules: false }))).toContain('node_modules/')
  })

  it('installs when a `file:` dependency was never linked — the fresh-checkout trap', () => {
    // The real symptom this exists for: `vite build` reports that
    // `alm-design-system` cannot be resolved from src/modules/alm/register.tsx,
    // which reads as a code bug even though the source is vendored in-tree.
    const reason = installReason(
      fixture({ fileDeps: { 'alm-design-system': 'file:./vendor/alm-design-system' }, linked: [] }),
    )
    expect(reason).toContain('alm-design-system')
    expect(reason).toContain('file:')
  })

  it('installs when nothing recorded a completed install in this checkout', () => {
    expect(installReason(fixture({ stamp: false }))).toContain('no record')
  })

  it('installs when bun.lock moved after the last install', () => {
    const paths = fixture({})
    const future = new Date(Date.now() + 60_000)
    utimesSync(paths.lockfile, future, future)
    expect(installReason(paths)).toContain('bun.lock')
  })

  it('does not install on a lockfile-less checkout that is otherwise stamped', () => {
    expect(installReason(fixture({ lockfile: false }))).toBeNull()
  })

  it('reads every `file:` dependency out of package.json, not a hardcoded list', () => {
    const paths = fixture({
      fileDeps: { 'alm-design-system': 'file:./vendor/alm-design-system', 'pixel-art-icons': 'file:./vendor/pixel-art-icons' },
    })
    expect(localFileDependencies(paths.packageJson).sort()).toEqual(['alm-design-system', 'pixel-art-icons'])
  })

  it('names four generated artefacts whose check and sync scripts both exist', () => {
    const pkg = JSON.parse(readSiteFile('package.json')) as { scripts: Record<string, string> }
    expect(GENERATED_ARTEFACTS).toHaveLength(4)
    for (const artefact of GENERATED_ARTEFACTS) {
      expect(pkg.scripts[artefact.check]).toBeDefined()
      expect(pkg.scripts[artefact.sync]).toBeDefined()
    }
  })

  it('runs from `bun run dev` before anything is spawned', () => {
    const script = readSiteFile('scripts/dev.ts')
    expect(script).toContain('runDevPreflight(log, fail)')
    expect(script.indexOf('runDevPreflight(log, fail)')).toBeLessThan(script.indexOf('Bun.spawn(cfg.command'))
  })
})
