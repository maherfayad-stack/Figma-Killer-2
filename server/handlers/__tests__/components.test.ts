/**
 * components — coverage for `GET /admin/api/studio/components` (Track E1).
 * Same fixture posture as `trustTier.test.ts`/`componentBundle.test.ts`: a
 * temp dir created INSIDE `projectsRootDir()` so the route's own
 * `isRealpathContained(dir, projectsRootDir())` containment guard passes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioComponents } from '../studio/components'
import type { LocalComponentSpec } from '../studio/componentSpecExtract'

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, init)
  return { req, url, pathname: url.pathname }
}

let wsDir: string

beforeEach(() => {
  const root = projectsRootDir()
  fs.mkdirSync(root, { recursive: true })
  wsDir = fs.mkdtempSync(path.join(root, '__components_route_test_'))
})

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(wsDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

describe('tryServeStudioComponents', () => {
  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioComponents(req, url, pathname)).toBeNull()
  })

  it('returns null for a non-GET method on its own path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/components', { method: 'POST' })
    expect(await tryServeStudioComponents(req, url, pathname)).toBeNull()
  })

  it('returns the project-wide catalog, not just what a page happens to import', async () => {
    write(
      'src/components/Card.tsx',
      [
        'export interface CardProps {',
        "  variant?: 'primary' | 'secondary'",
        '  title: string',
        '}',
        'export function Card({ variant, title }: CardProps) {',
        '  return null',
        '}',
      ].join('\n'),
    )
    // Never imported by any page — a full-project catalog must still find it.
    write(
      'src/components/Orphan.tsx',
      ['export function Orphan({ label }: { label: string }) {', '  return null', '}'].join('\n'),
    )

    const { req, url, pathname } = makeRequest(`/admin/api/studio/components?dir=${encodeURIComponent(wsDir)}`)
    const res = await tryServeStudioComponents(req, url, pathname)
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { components: LocalComponentSpec[] }

    const card = body.components.find((c) => c.name === 'Card')
    expect(card).toBeDefined()
    expect(card!.props.find((p) => p.name === 'variant')?.kind).toEqual({
      kind: 'enum',
      values: ['primary', 'secondary'],
    })
    expect(body.components.some((c) => c.name === 'Orphan')).toBe(true)
  })

  it('returns an empty catalog rather than an error for a project with no components', async () => {
    const { req, url, pathname } = makeRequest(`/admin/api/studio/components?dir=${encodeURIComponent(wsDir)}`)
    const res = await tryServeStudioComponents(req, url, pathname)
    const body = (await res!.json()) as { components: LocalComponentSpec[] }
    expect(body.components).toEqual([])
  })

  it('rejects a dir outside studio-workspace/', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'components-outside-'))
    try {
      const { req, url, pathname } = makeRequest(`/admin/api/studio/components?dir=${encodeURIComponent(outside)}`)
      const res = await tryServeStudioComponents(req, url, pathname)
      expect(res!.status).toBe(404)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
