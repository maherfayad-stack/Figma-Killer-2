/**
 * Gate (P1-H): the Studio workspace survives a container recreate in every
 * image, Compose stack and platform template this repo ships.
 *
 * The workspace root holds every user's real React projects, Studio's source
 * of truth, with no other copy. Until P1-H the image kept it at
 * `/app/studio-workspace` and no Compose file or template mounted anything
 * there, so `docker compose pull && docker compose up -d` (an ordinary
 * upgrade) deleted every project. This test fails if that can happen again:
 *
 *   1. The server resolves the root from `STUDIO_WORKSPACE_DIR`, else
 *      `<cwd>/studio-workspace`, checked against `projectsRootDir()` itself,
 *      so the path this test reasons about is the path the server uses.
 *   2. The Dockerfile's runtime stage names the root, and creates it owned by
 *      `bun` (an empty named volume mounted there inherits that owner).
 *   3. Every supported Compose stack (compose.prod.yml plus any mix of its
 *      overlays) mounts a declared named volume at or above that root.
 *   4. Both Render Blueprints point the root inside their persistent disk.
 *   5. Every documented env block for the `/app/storage` single-volume layout
 *      (Railway, Render, `docker run`, the release bundle's INSTALL.md) sets
 *      the root inside `/app/storage` too.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { readSource, REPO_ROOT, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const WORKSPACE_ENV = 'STUDIO_WORKSPACE_DIR'

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

/** True when `path` is `dir` or inside it (POSIX container paths, whole segments). */
function isAtOrUnder(path: string, dir: string): boolean {
  const normalizedDir = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return path === normalizedDir || path.startsWith(`${normalizedDir}/`)
}

// ─── 1. The server's resolution ────────────────────────────────────────────

describe('the server resolves the workspace root the way the image assumes', () => {
  const previous = process.env[WORKSPACE_ENV]
  afterEach(() => {
    if (previous === undefined) delete process.env[WORKSPACE_ENV]
    else process.env[WORKSPACE_ENV] = previous
  })

  it(`reads ${WORKSPACE_ENV} when set`, () => {
    const configured = join(REPO_ROOT, '.tmp', 'somewhere-on-a-volume')
    process.env[WORKSPACE_ENV] = configured
    expect(projectsRootDir()).toBe(resolve(configured))
  })

  it('falls back to <cwd>/studio-workspace when unset', () => {
    delete process.env[WORKSPACE_ENV]
    expect(projectsRootDir()).toBe(join(process.cwd(), 'studio-workspace'))
  })
})

// ─── 2. The Dockerfile ─────────────────────────────────────────────────────

interface DockerRuntimeStage {
  workdir: string
  env: Record<string, string>
  runLines: string[]
}

/** The final stage of the Dockerfile: the image that actually runs. */
function parseDockerfileRuntimeStage(): DockerRuntimeStage {
  const lines = read('Dockerfile').split(/\r?\n/)
  const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line))
  expect(lastFrom).toBeGreaterThanOrEqual(0)
  const stage: DockerRuntimeStage = { workdir: '/', env: {}, runLines: [] }
  for (const line of lines.slice(lastFrom + 1)) {
    const workdir = /^WORKDIR\s+(\S+)/i.exec(line)
    if (workdir) stage.workdir = workdir[1]
    const env = /^ENV\s+([A-Z0-9_]+)=(\S+)/i.exec(line)
    if (env) stage.env[env[1]] = env[2]
    if (/^RUN\s/i.test(line)) stage.runLines.push(line)
  }
  return stage
}

const runtimeStage = parseDockerfileRuntimeStage()

/** Where the image's server process puts the workspace when nothing overrides it. */
const imageWorkspaceRoot = runtimeStage.env[WORKSPACE_ENV] ?? `${runtimeStage.workdir}/studio-workspace`

describe('Dockerfile', () => {
  it(`sets ${WORKSPACE_ENV} explicitly in the runtime stage`, () => {
    expect(runtimeStage.env[WORKSPACE_ENV]).toBeDefined()
    expect(imageWorkspaceRoot.startsWith('/')).toBe(true)
  })

  it('creates the workspace root and hands /app to the non-root bun user, so a fresh named volume is writable', () => {
    const mkdir = runtimeStage.runLines.find((line) => /mkdir\s+-p/.test(line))
    expect(mkdir).toBeDefined()
    expect(mkdir?.split(/\s+/)).toContain(imageWorkspaceRoot)
    expect(mkdir).toMatch(/chown -R bun:bun \/app\b/)
  })
})

// ─── 3. Compose ────────────────────────────────────────────────────────────

const ComposeVolumeSchema = Type.Union([
  Type.String(),
  Type.Object({ type: Type.Optional(Type.String()), source: Type.Optional(Type.String()), target: Type.String() }),
])

const ComposeAppSchema = Type.Object({
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
  volumes: Type.Optional(Type.Array(ComposeVolumeSchema)),
})

const ComposeFileSchema = Type.Object({
  services: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  volumes: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

type ComposeApp = Static<typeof ComposeAppSchema>

interface ResolvedVolume {
  type: string
  source: string
  target: string
}

interface ComposeStack {
  env: Record<string, string>
  volumes: ResolvedVolume[]
  declaredVolumes: Set<string>
}

function parseComposeFile(relPath: string): Static<typeof ComposeFileSchema> {
  const parsed: unknown = Bun.YAML.parse(read(relPath))
  if (!Value.Check(ComposeFileSchema, parsed)) throw new Error(`${relPath} is not a Compose file shape`)
  return parsed
}

function composeApp(relPath: string): ComposeApp | undefined {
  const app = parseComposeFile(relPath).services?.app
  if (app === undefined) return undefined
  if (!Value.Check(ComposeAppSchema, app)) throw new Error(`${relPath}: services.app has an unexpected shape`)
  return app
}

function resolveVolume(volume: Static<typeof ComposeVolumeSchema>): ResolvedVolume {
  if (typeof volume !== 'string') {
    return { type: volume.type ?? 'volume', source: volume.source ?? '', target: volume.target }
  }
  const [source, target] = volume.split(':')
  const isBind = source.startsWith('.') || source.startsWith('/') || source.startsWith('~')
  return { type: isBind ? 'bind' : 'volume', source, target: target ?? source }
}

/** Compose's own override rules for the two keys that matter: environment merges by key, volumes by target. */
function composeStack(files: readonly string[]): ComposeStack {
  const stack: ComposeStack = { env: {}, volumes: [], declaredVolumes: new Set() }
  for (const file of files) {
    for (const name of Object.keys(parseComposeFile(file).volumes ?? {})) stack.declaredVolumes.add(name)
    const app = composeApp(file)
    if (!app) continue
    Object.assign(stack.env, app.environment ?? {})
    for (const volume of (app.volumes ?? []).map(resolveVolume)) {
      stack.volumes = stack.volumes.filter((existing) => existing.target !== volume.target)
      stack.volumes.push(volume)
    }
  }
  return stack
}

/** Every Compose file at the repo root. A new one must be classified below before this gate passes. */
const COMPOSE_BASE = 'compose.prod.yml'
const COMPOSE_OVERLAYS = ['compose.sqlite.yml', 'compose.tls.yml', 'compose.build.yml']
/** `docker-compose.yml` is the dev-only Postgres service for `bun run dev`; it runs no Studio container. */
const COMPOSE_WITHOUT_APP = ['docker-compose.yml']

/** compose.prod.yml with every subset of its overlays: each is a documented or valid install. */
function everyComposeStack(): string[][] {
  const stacks: string[][] = []
  for (let mask = 0; mask < 1 << COMPOSE_OVERLAYS.length; mask++) {
    stacks.push([COMPOSE_BASE, ...COMPOSE_OVERLAYS.filter((_, i) => mask & (1 << i))])
  }
  return stacks
}

describe('Compose', () => {
  it('knows every Compose file in the repo root', () => {
    const onDisk = readdirSync(REPO_ROOT)
      .filter((name) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name))
      .sort()
    expect(onDisk).toEqual([COMPOSE_BASE, ...COMPOSE_OVERLAYS, ...COMPOSE_WITHOUT_APP].sort())
  })

  it('the dev-only file runs no Studio app container', () => {
    for (const file of COMPOSE_WITHOUT_APP) expect(composeApp(file)).toBeUndefined()
  })

  for (const files of everyComposeStack()) {
    it(`${files.join(' + ')} mounts a persistent volume over the path the server uses`, () => {
      const stack = composeStack(files)
      const workspaceRoot = stack.env[WORKSPACE_ENV] ?? imageWorkspaceRoot
      const covering = stack.volumes.filter((volume) => isAtOrUnder(workspaceRoot, volume.target))
      expect(covering.length).toBeGreaterThan(0)
      for (const volume of covering) {
        expect(volume.type).not.toBe('tmpfs')
        if (volume.type === 'volume') expect(stack.declaredVolumes.has(volume.source)).toBe(true)
      }
    })
  }

  it('compose.prod.yml pins the same root the image defaults to', () => {
    expect(composeStack([COMPOSE_BASE]).env[WORKSPACE_ENV]).toBe(imageWorkspaceRoot)
  })
})

// ─── 4. Render Blueprints ──────────────────────────────────────────────────

const RenderBlueprintSchema = Type.Object({
  services: Type.Array(
    Type.Object({
      envVars: Type.Array(Type.Object({ key: Type.String(), value: Type.Optional(Type.String()) })),
      disk: Type.Object({ mountPath: Type.String() }),
    }),
  ),
})

describe('Render Blueprints', () => {
  for (const file of ['docs/deployment/render/sqlite/render.yaml', 'docs/deployment/render/postgres/render.yaml']) {
    it(`${file} points ${WORKSPACE_ENV} inside its persistent disk`, () => {
      const parsed: unknown = Bun.YAML.parse(read(file))
      if (!Value.Check(RenderBlueprintSchema, parsed)) throw new Error(`${file}: unexpected Blueprint shape`)
      for (const service of parsed.services) {
        const root = service.envVars.find((envVar) => envVar.key === WORKSPACE_ENV)?.value
        expect(root).toBeDefined()
        expect(isAtOrUnder(root ?? '', service.disk.mountPath)).toBe(true)
      }
    })
  }
})

// ─── 5. Documented single-volume env blocks ────────────────────────────────

const SINGLE_VOLUME_ROOT = '/app/storage'

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((match) => match[1])
}

describe('documented /app/storage env blocks', () => {
  const sources: Array<{ file: string; text: string }> = [
    ...walkSourceTree(join(REPO_ROOT, 'docs', 'deployment'), ['.md']).map((file) => ({
      file: toRepoRelativePosix(file),
      text: readSource(file),
    })),
    // INSTALL.md is a template literal here, so its fences are written \`\`\`.
    { file: 'scripts/build-release-bundle.ts', text: read('scripts/build-release-bundle.ts').replaceAll('\\`', '`') },
  ]

  it('finds the single-volume layout documented at all (the scan is not vacuous)', () => {
    const blocks = sources.flatMap((source) => fencedBlocks(source.text))
    expect(blocks.filter((block) => block.includes(`UPLOADS_DIR=${SINGLE_VOLUME_ROOT}/`)).length).toBeGreaterThan(3)
  })

  for (const { file, text } of sources) {
    it(`${file}: every block that puts uploads on ${SINGLE_VOLUME_ROOT} puts the workspace there too`, () => {
      for (const block of fencedBlocks(text)) {
        if (!block.includes(`UPLOADS_DIR=${SINGLE_VOLUME_ROOT}/`)) continue
        const root = new RegExp(`${WORKSPACE_ENV}=("?)(\\S+?)\\1(\\s|$)`).exec(block)?.[2]
        expect({ block, root }).toEqual({ block, root: expect.stringMatching(new RegExp(`^${SINGLE_VOLUME_ROOT}/`)) })
      }
    })
  }
})
