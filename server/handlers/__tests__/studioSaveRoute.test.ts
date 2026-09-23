/**
 * studioSaveRoute — `POST /admin/api/studio/save`'s RESPONSE, driven through
 * the real route (`tryServeStudio` as the Owner), not through
 * `applyStudioEditBatch` directly.
 *
 * `store-15` shipped a delete whose undo (`reinsert-source`) is built from
 * the `removed`/`prunedImports` the batch computes — and every one of the
 * batch's own tests passed while the route, which lists its response fields
 * by hand, forwarded neither. Every ⌘Z after a delete then resolved to
 * "Studio could not work out how to take this back" with the code that could
 * sitting one layer down. The same class of bug had already happened once to
 * `createdNodeIds`/`relocatedNodeIds` (`store-13`/`store-14`). This file
 * holds the seam: what the batch returns, the route must return.
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
  removed: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), text: Type.String(), wholeLine: Type.Boolean() }))),
  prunedImports: Type.Optional(Type.Array(Type.Object({ file: Type.String(), declarations: Type.Array(Type.String()) }))),
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

describe('POST /admin/api/studio/save — the delete material ⌘Z is built from', () => {
  it('forwards removed (keyed by the edit nodeId) and prunedImports for a delete', async () => {
    const badgeId = nodeIdOf(PAGE, 'Badge')
    const body = await save([{ kind: 'delete', nodeId: badgeId }])

    expect(body.ok).toBe(true)
    expect(body.written).toBe(1)
    expect(body.removed).toEqual([{ nodeId: badgeId, text: '      <Badge label="new" />\n', wholeLine: true }])
    expect(body.prunedImports).toEqual([{ file: 'pages/Home.tsx', declarations: ["import { Badge } from './Badge'"] }])

    const after = fs.readFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'utf8')
    expect(after).not.toContain('Badge')
  })

  it('a reinsert-source built from that response puts the element and its import back byte-for-byte', async () => {
    const badgeId = nodeIdOf(PAGE, 'Badge')
    const deleted = await save([{ kind: 'delete', nodeId: badgeId }])
    const [removed] = deleted.removed ?? []
    const [pruned] = deleted.prunedImports ?? []
    if (!removed || !pruned) throw new Error('delete response carried no restore material')

    const afterDelete = fs.readFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'utf8')
    const sectionId = nodeIdOf(afterDelete, 'section')
    const restored = await save([
      { kind: 'reinsert-source', nodeId: sectionId, index: 1, text: removed.text, imports: pruned.declarations },
    ])
    expect(restored.written).toBe(1)
    expect(fs.readFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'utf8')).toBe(PAGE)
  })

  it('refuses by name, through the route, a reinsert-source whose text is not JSX content (sec-22)', async () => {
    const sectionId = nodeIdOf(PAGE, 'section')
    const body = await save([
      {
        kind: 'reinsert-source',
        nodeId: sectionId,
        index: 1,
        text: "</section>\n  )\n}\nvoid (function () { /* module load */ })();\nexport function Dummy() {\n  return (\n    <section>\n",
      },
    ])
    expect(body.written).toBe(0)
    expect(body.refusals?.map((r) => r.reason)).toEqual(['not-jsx-content'])
    expect(fs.readFileSync(path.join(projectDir, 'pages', 'Home.tsx'), 'utf8')).toBe(PAGE)
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
