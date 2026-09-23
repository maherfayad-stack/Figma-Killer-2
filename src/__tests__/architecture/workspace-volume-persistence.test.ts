/**
 * Gate (P1-H): the Studio workspace, and Studio's private data, survive a
 * container recreate in every image, Compose stack and platform template this
 * repo ships.
 *
 * The workspace root holds every user's real React projects, Studio's source
 * of truth, with no other copy. The private data root (`STUDIO_DATA_DIR`,
 * `<cwd>/.data`) holds encrypted MCP server secrets and Claude CLI logins.
 * Until P1-H the image kept both under `/app` and no Compose file or template
 * mounted anything there, so `docker compose pull && docker compose up -d`
 * (an ordinary upgrade) deleted every project. This test fails if that can
 * happen again:
 *
 *   1. The server resolves each root from its variable, else a `<cwd>`
 *      default, checked against the resolvers themselves, so the path this
 *      test reasons about is the path the server uses.
 *   2. The Dockerfile's runtime stage names both roots and creates them owned
 *      by `bun` (an empty named volume mounted there inherits that owner),
 *      and does NOT hand Studio's own code to `bun` (review F3).
 *   3. Every supported Compose stack (compose.prod.yml plus any mix of its
 *      overlays) mounts a declared, writable named volume at or above each
 *      root, with no service-level `tmpfs` over it.
 *   4. Both Render Blueprints point both roots inside their persistent disk.
 *   5. Every documented env block for the `/app/storage` single-volume layout
 *      (Railway, Render, `docker run`, the release bundle's INSTALL.md) sets
 *      both roots inside `/app/storage` too.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { projectsRootDir } from '../../../server/handlers/studioProjects'
import { resolveStudioDataRoot } from '../../../server/runtimeDirs'
import { readSource, REPO_ROOT, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const WORKSPACE_ENV = 'STUDIO_WORKSPACE_DIR'
const DATA_ENV = 'STUDIO_DATA_DIR'

/** Each persisted root: its variable, and the server's default relative to the working directory. */
const PERSISTED_ROOTS = [
  { variable: WORKSPACE_ENV, cwdDefault: 'studio-workspace' },
  { variable: DATA_ENV, cwdDefault: '.data' },
] as const

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8')
}

/** True when `path` is `dir` or inside it (POSIX container paths, whole segments). */
function isAtOrUnder(path: string, dir: string): boolean {
  const normalizedDir = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return path === normalizedDir || path.startsWith(`${normalizedDir}/`)
}

// ─── 1. The server's resolution ────────────────────────────────────────────

describe('the server resolves each root the way the image assumes', () => {
  const previous = { workspace: process.env[WORKSPACE_ENV], data: process.env[DATA_ENV] }
  afterEach(() => {
    for (const [variable, value] of [[WORKSPACE_ENV, previous.workspace], [DATA_ENV, previous.data]] as const) {
      if (value === undefined) delete process.env[variable]
      else process.env[variable] = value
    }
  })

  it(`reads ${WORKSPACE_ENV} and ${DATA_ENV} when set`, () => {
    const configured = join(REPO_ROOT, '.tmp', 'somewhere-on-a-volume')
    process.env[WORKSPACE_ENV] = configured
    process.env[DATA_ENV] = join(configured, 'private')
    expect(projectsRootDir()).toBe(resolve(configured))
    expect(resolveStudioDataRoot()).toBe(resolve(configured, 'private'))
  })

  it('falls back to <cwd>/studio-workspace and <cwd>/.data when unset', () => {
    delete process.env[WORKSPACE_ENV]
    delete process.env[DATA_ENV]
    expect(projectsRootDir()).toBe(join(process.cwd(), 'studio-workspace'))
    expect(resolveStudioDataRoot()).toBe(resolve(process.cwd(), '.data'))
  })
})

// ─── 2. The Dockerfile ─────────────────────────────────────────────────────

interface DockerRuntimeStage {
  workdir: string
  env: Record<string, string>
  runLines: string[]
  copyLines: string[]
}

/** The final stage of the Dockerfile: the image that actually runs. */
function parseDockerfileRuntimeStage(): DockerRuntimeStage {
  const lines = read('Dockerfile').split(/\r?\n/)
  const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line))
  expect(lastFrom).toBeGreaterThanOrEqual(0)
  const stage: DockerRuntimeStage = { workdir: '/', env: {}, runLines: [], copyLines: [] }
  for (const line of lines.slice(lastFrom + 1)) {
    const workdir = /^WORKDIR\s+(\S+)/i.exec(line)
    if (workdir) stage.workdir = workdir[1]
    const env = /^ENV\s+([A-Z0-9_]+)=(\S+)/i.exec(line)
    if (env) stage.env[env[1]] = env[2]
    if (/^RUN\s/i.test(line)) stage.runLines.push(line)
    if (/^COPY\s/i.test(line)) stage.copyLines.push(line)
  }
  return stage
}

const runtimeStage = parseDockerfileRuntimeStage()

/** Where the image's server process puts a root when nothing overrides it. */
function imageRoot(root: (typeof PERSISTED_ROOTS)[number]): string {
  return runtimeStage.env[root.variable] ?? `${runtimeStage.workdir}/${root.cwdDefault}`
}

describe('Dockerfile', () => {
  for (const root of PERSISTED_ROOTS) {
    it(`sets ${root.variable} explicitly, and creates that directory owned by bun`, () => {
      expect(runtimeStage.env[root.variable]).toBeDefined()
      expect(imageRoot(root).startsWith('/')).toBe(true)
      const run = runtimeStage.runLines.find((line) => /mkdir\s+-p/.test(line)) ?? ''
      const [mkdirPart, chownPart = ''] = run.split('&&')
      expect(mkdirPart.split(/\s+/)).toContain(imageRoot(root))
      expect(chownPart).toMatch(/^\s*chown bun:bun /)
      expect(chownPart.trim().split(/\s+/)).toContain(imageRoot(root))
    })
  }

  // Review F3: a Tier 2 dev server runs as `bun`; it must not own Studio's code.
  it("leaves Studio's own code root-owned (no recursive chown of /app, no --chown on COPY)", () => {
    for (const line of runtimeStage.runLines) expect(line).not.toMatch(/chown\s+(-R|--recursive)\b/)
    for (const line of runtimeStage.copyLines) expect(line).not.toContain('--chown')
  })
})

// ─── 3. Compose ────────────────────────────────────────────────────────────

const ComposeVolumeSchema = Type.Union([
  Type.String(),
  Type.Object({
    type: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    target: Type.String(),
    read_only: Type.Optional(Type.Boolean()),
  }),
])

const ComposeAppSchema = Type.Object({
  environment: Type.Optional(Type.Record(Type.String(), Type.String())),
  volumes: Type.Optional(Type.Array(ComposeVolumeSchema)),
  tmpfs: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
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
  readOnly: boolean
}

interface ComposeStack {
  env: Record<string, string>
  volumes: ResolvedVolume[]
  tmpfs: string[]
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
    return { type: volume.type ?? 'volume', source: volume.source ?? '', target: volume.target, readOnly: volume.read_only === true }
  }
  const [source, target, mode = ''] = volume.split(':')
  const isBind = source.startsWith('.') || source.startsWith('/') || source.startsWith('~')
  return { type: isBind ? 'bind' : 'volume', source, target: target ?? source, readOnly: mode.split(',').includes('ro') }
}

/** Compose's own override rules for the keys that matter: environment merges by key, volumes by target, tmpfs appends. */
function composeStack(files: readonly string[]): ComposeStack {
  const stack: ComposeStack = { env: {}, volumes: [], tmpfs: [], declaredVolumes: new Set() }
  for (const file of files) {
    for (const name of Object.keys(parseComposeFile(file).volumes ?? {})) stack.declaredVolumes.add(name)
    const app = composeApp(file)
    if (!app) continue
    Object.assign(stack.env, app.environment ?? {})
    for (const volume of (app.volumes ?? []).map(resolveVolume)) {
      stack.volumes = stack.volumes.filter((existing) => existing.target !== volume.target)
      stack.volumes.push(volume)
    }
    const tmpfs = app.tmpfs === undefined ? [] : typeof app.tmpfs === 'string' ? [app.tmpfs] : app.tmpfs
    stack.tmpfs.push(...tmpfs.map((entry) => entry.split(':')[0]))
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
    for (const root of PERSISTED_ROOTS) {
      it(`${files.join(' + ')} mounts a writable, persistent volume over ${root.variable}`, () => {
        const stack = composeStack(files)
        const path = stack.env[root.variable] ?? imageRoot(root)
        const covering = stack.volumes.filter((volume) => isAtOrUnder(path, volume.target))
        expect(covering.length).toBeGreaterThan(0)
        for (const volume of covering) {
          expect(volume.type).not.toBe('tmpfs')
          expect(volume.readOnly).toBe(false)
          if (volume.type === 'volume') expect(stack.declaredVolumes.has(volume.source)).toBe(true)
        }
        expect(stack.tmpfs.filter((target) => isAtOrUnder(path, target))).toEqual([])
      })
    }
  }

  for (const root of PERSISTED_ROOTS) {
    it(`compose.prod.yml pins the same ${root.variable} the image defaults to`, () => {
      expect(composeStack([COMPOSE_BASE]).env[root.variable]).toBe(imageRoot(root))
    })
  }
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
    for (const root of PERSISTED_ROOTS) {
      it(`${file} points ${root.variable} at a dedicated directory inside its persistent disk`, () => {
        const parsed: unknown = Bun.YAML.parse(read(file))
        if (!Value.Check(RenderBlueprintSchema, parsed)) throw new Error(`${file}: unexpected Blueprint shape`)
        for (const service of parsed.services) {
          const path = service.envVars.find((envVar) => envVar.key === root.variable)?.value ?? ''
          expect(isAtOrUnder(path, service.disk.mountPath)).toBe(true)
          // Never the mount root itself: that also holds the database and uploads (review F1).
          expect(path).not.toBe(service.disk.mountPath)
        }
      })
    }
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
    it(`${file}: every block that puts uploads on ${SINGLE_VOLUME_ROOT} puts the workspace and private data there too`, () => {
      for (const block of fencedBlocks(text)) {
        if (!block.includes(`UPLOADS_DIR=${SINGLE_VOLUME_ROOT}/`)) continue
        for (const root of PERSISTED_ROOTS) {
          const path = new RegExp(`${root.variable}=("?)(\\S+?)\\1(\\s|$)`).exec(block)?.[2]
          expect({ variable: root.variable, block, path }).toEqual({
            variable: root.variable,
            block,
            path: expect.stringMatching(new RegExp(`^${SINGLE_VOLUME_ROOT}/.+`)),
          })
        }
      }
    })
  }
})
