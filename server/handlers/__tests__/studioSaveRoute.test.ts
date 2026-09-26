/**
 * studioSaveRoute — `POST /admin/api/studio/save`'s RESPONSE, driven through
 * the real route (`tryServeStudio` as the Owner), not through
 * `applyStudioEditBatch` directly.
 *
 * `store-15` shipped a delete whose undo material the batch computed — and
 * every one of the batch's own tests passed while the route, which lists its
 * response fields by hand, never forwarded it. Every ⌘Z after a delete then
 * resolved to "Studio could not work out how to take this back" with the code
 * that could sitting one layer down. The same class of bug had already
 * happened once to `createdNodeIds`/`relocatedNodeIds` (`store-13`/`store-14`).
 * This file holds the seam: what the batch returns, the route must return —
 * today, P3-F's `undoToken`, and the route is the one caller that journals.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Type } from '@sinclair/typebox'
import { readEnvelope } from '@core/http'
import { createStudioRouteTestHarness, type StudioRouteTestHarness } from './helpers/studioRouteHarness'

let studioRoutes: StudioRouteTestHarness
let previousRoot: string | undefined
let root: string
let projectDir: string

const PAGE = `import { Badge } from './Badge'

export default function Page() {
  return (
    <section>
      <p>First</p>
      <Badge label="new" />
    </section>
  )
}
`

const SaveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  written: Type.Number(),
  undoToken: Type.Optional(Type.String()),
  touchedFiles: Type.Optional(Type.Array(Type.String())),
  refusals: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), reason: Type.String(), message: Type.String() }))),
  fingerprints: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), fingerprint: Type.String() }))),
})

beforeAll(async () => {
  studioRoutes = await createStudioRouteTestHarness()
})

afterAll(async () => {
  await studioRoutes.cleanup()
})

beforeEach(() => {
  // `resolveProjectDir` only serves a dir under the workspace root, and
  // resolves symlinks on both sides — so the root is the temp dir's realpath
  // (macOS: /var → /private/var), the same posture `componentBundle.test.ts`
  // takes.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-save-route-')))
  previousRoot = process.env.STUDIO_WORKSPACE_DIR
  process.env.STUDIO_WORKSPACE_DIR = root
  projectDir = path.join(root, 'proj')
  fs.mkdirSync(path.join(projectDir, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'pages', 'Home.tsx'), PAGE, 'utf8')
  fs.writeFileSync(path.join(projectDir, 'pages', 'Badge.tsx'), 'export function Badge(p: { label: string }) { return <i>{p.label}</i> }\n', 'utf8')
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
  else process.env.STUDIO_WORKSPACE_DIR = previousRoot
  fs.rmSync(root, { recursive: true, force: true })
})

async function save(edits: unknown[], expectations?: Record<string, string>) {
  const url = new URL('http://localhost/admin/api/studio/save')
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify({ dir: projectDir, edits, ...(expectations ? { expect: expectations } : {}) }),
  })
  const res = await studioRoutes.serve(req, url)
  expect(res).not.toBeNull()
  expect(res!.status).toBe(200)
  return readEnvelope(res!, SaveResponseSchema, 'save failed')
}

/** The node id of the element whose opening tag is `<name` — the column names the TAG NAME, one past the `<`, as `buildSourceNodeId` mints it. */
function nodeIdOf(source: string, name: string, file = 'pages/Home.tsx'): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(`<${name}`)
    if (col >= 0) return `${file}:${i + 1}:${col + 2}`
  }
  throw new Error(`no <${name} in fixture`)
}

const homeFile = () => path.join(projectDir, 'pages', 'Home.tsx')

describe('POST /admin/api/studio/save — the undo journal crosses the route (P3-F)', () => {
  it('forwards an undoToken for a delete, and journals it under .studio/undo-journal', async () => {
    const body = await save([{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }])

    expect(body.ok).toBe(true)
    expect(body.written).toBe(1)
    expect(body.undoToken).toMatch(/^[0-9a-f]{32}$/)
    expect(fs.existsSync(path.join(projectDir, '.studio', 'undo-journal', `${body.undoToken}.json`))).toBe(true)
    expect(fs.readFileSync(homeFile(), 'utf8')).not.toContain('Badge')
  })

  it('a restore naming that token puts the element AND its pruned import back byte-for-byte, and consumes the entry', async () => {
    const deleted = await save([{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }])
    const token = deleted.undoToken
    if (!token) throw new Error('the delete reported no undo token')

    const restored = await save([{ kind: 'restore', nodeId: `undo-journal:${token}`, token }])
    expect(restored.refusals).toEqual([])
    expect(restored.written).toBe(1)
    expect(restored.touchedFiles).toEqual(['pages/Home.tsx'])
    expect(fs.readFileSync(homeFile(), 'utf8')).toBe(PAGE)
    expect(fs.existsSync(path.join(projectDir, '.studio', 'undo-journal', `${token}.json`))).toBe(false)
  })

  it('refuses restore-stale, and writes nothing, when the file changed after the delete', async () => {
    const deleted = await save([{ kind: 'delete', nodeId: nodeIdOf(PAGE, 'Badge') }])
    const token = deleted.undoToken!
    const afterDelete = fs.readFileSync(homeFile(), 'utf8')
    const edited = await save([{ kind: 'text', nodeId: nodeIdOf(afterDelete, 'p'), text: 'Changed since' }])
    expect(edited.written).toBe(1)
    const beforeRestore = fs.readFileSync(homeFile(), 'utf8')

    const body = await save([{ kind: 'restore', nodeId: `undo-journal:${token}`, token }])
    expect(body.written).toBe(0)
    expect(body.refusals?.map((r) => r.reason)).toEqual(['restore-stale'])
    expect(body.refusals?.[0]?.message).toContain('pages/Home.tsx has changed since')
    expect(fs.readFileSync(homeFile(), 'utf8')).toBe(beforeRestore)
  })

  it('a value edit is not journaled — only the one-shot kinds are', async () => {
    const body = await save([{ kind: 'text', nodeId: nodeIdOf(PAGE, 'p'), text: 'Typed' }])
    expect(body.written).toBe(1)
    expect(body.undoToken).toBeUndefined()
    expect(fs.existsSync(path.join(projectDir, '.studio', 'undo-journal'))).toBe(false)
  })
})

describe('POST /admin/api/studio/save — the element identity guard (P1-A) crosses the route', () => {
  it('honours expect, and forwards the new identity of each landed value write', async () => {
    const pId = nodeIdOf(PAGE, 'p')
    const wrong = await save([{ kind: 'text', nodeId: pId, text: 'Changed' }], { [pId]: 'p#00000000' })
    expect(wrong.written).toBe(0)
    expect(wrong.refusals?.map((r) => r.reason)).toEqual(['element-moved'])
    expect(fs.readFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'utf8')).toBe(PAGE)

    const written = await save([{ kind: 'text', nodeId: pId, text: 'Changed' }])
    expect(written.written).toBe(1)
    expect(written.fingerprints).toEqual([{ nodeId: pId, fingerprint: expect.stringMatching(/^p#[0-9a-f]{8}$/) }])
  })
})
