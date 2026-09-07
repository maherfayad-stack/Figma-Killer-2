/**
 * styleCompileConsent — coverage for `GET/POST
 * /admin/api/studio/style-compile-consent`, the read/dismiss surface behind
 * the board's first-run "run this project's compiler" prompt.
 *
 * Same fixture posture as `trustTier.test.ts`: a temp dir created INSIDE
 * `projectsRootDir()` so the route's own
 * `isRealpathContained(dir, projectsRootDir())` containment guard passes.
 *
 * The behaviours that matter here are the ones the prompt's honesty depends
 * on: it must report a compilable toolchain when there is one, report NO
 * toolchain for a project that already renders fully at Tier 0, persist a
 * dismissal without touching anything else in `.studio/meta.json`, and — the
 * one that would be a real security regression — never promote the trust tier
 * itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readStudioMeta } from '../studio/studioMeta'
import { projectsRootDir } from '../studioProjects'
import { tryServeStudioStyleCompileConsent } from '../studio/styleCompileConsent'
import { ProjectDirOutsideWorkspaceError } from '../studioProjects'
import { withOutsideWorkspaceDir } from './outsideWorkspaceDir'

interface ConsentStatusBody {
  trust: string
  toolchains: string[]
  dependenciesInstalled: boolean
  dismissed: boolean
}

function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
  const url = new URL(`http://localhost${pathAndQuery}`)
  const req = new Request(url, init)
  return { req, url, pathname: url.pathname }
}

function postBody(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function getStatus(dir: string): Promise<ConsentStatusBody> {
  const { req, url, pathname } = makeRequest(`/admin/api/studio/style-compile-consent?dir=${encodeURIComponent(dir)}`)
  const res = await tryServeStudioStyleCompileConsent(req, url, pathname)
  return (await res!.json()) as ConsentStatusBody
}

function writeFile(dir: string, relPath: string, contents: string): void {
  const abs = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

describe('tryServeStudioStyleCompileConsent', () => {
  let wsDir: string

  beforeEach(() => {
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__style_consent_test_'))
    writeFile(wsDir, 'pages/Home.tsx', 'export default function Home() { return <div /> }\n')
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioStyleCompileConsent(req, url, pathname)).toBeNull()
  })

  it('reports no compilable toolchain for a plain-CSS project', async () => {
    writeFile(wsDir, 'pages/Home.css', '.a { color: red }\n')

    const body = await getStatus(wsDir)
    expect(body.toolchains).toEqual([])
    expect(body.trust).toBe('static')
    expect(body.dismissed).toBe(false)
  })

  it('reports Tailwind + PostCSS on a Tier 0 project that has both', async () => {
    writeFile(wsDir, 'package.json', JSON.stringify({ dependencies: { tailwindcss: '^3.4.0' } }))
    writeFile(wsDir, 'tailwind.config.js', 'module.exports = {}\n')
    writeFile(wsDir, 'postcss.config.js', 'module.exports = {}\n')

    const body = await getStatus(wsDir)
    expect(body.trust).toBe('static')
    expect(body.toolchains).toContain('tailwind')
    expect(body.toolchains).toContain('postcss')
    expect(body.dependenciesInstalled).toBe(false)
  })

  it('reports Sass', async () => {
    writeFile(wsDir, 'styles/app.scss', '$c: red;\n.a { color: $c }\n')

    const body = await getStatus(wsDir)
    expect(body.toolchains).toEqual(['sass'])
  })

  it('reports the persisted trust tier, so an already-promoted project stops being offered', async () => {
    writeFile(wsDir, 'styles/app.scss', '.a { color: red }\n')
    writeFile(wsDir, '.studio/meta.json', JSON.stringify({ trust: 'render-packages' }))

    const body = await getStatus(wsDir)
    expect(body.trust).toBe('render-packages')
    expect(body.toolchains).toEqual(['sass'])
  })

  it('POST persists the dismissal, preserves other meta fields, and never promotes', async () => {
    writeFile(wsDir, 'styles/app.scss', '.a { color: red }\n')
    writeFile(wsDir, '.studio/meta.json', JSON.stringify({ displayName: 'Fixture Project' }))

    const { req, url, pathname } = makeRequest('/admin/api/studio/style-compile-consent', postBody({ dir: wsDir }))
    const res = await tryServeStudioStyleCompileConsent(req, url, pathname)
    expect(((await res!.json()) as { ok: boolean }).ok).toBe(true)

    const meta = readStudioMeta(wsDir)
    expect(meta.styleCompilePromptDismissed).toBe(true)
    expect(meta.displayName).toBe('Fixture Project')
    // The dismissal is a refusal to be asked, never consent to run anything.
    expect(meta.trust).toBeUndefined()

    const body = await getStatus(wsDir)
    expect(body.dismissed).toBe(true)
    expect(body.trust).toBe('static')
  })

  it('GET rejects a dir outside studio-workspace/', async () => {
    await withOutsideWorkspaceDir('style-consent-outside', async (outside) => {
      const { req, url, pathname } = makeRequest(
        `/admin/api/studio/style-compile-consent?dir=${encodeURIComponent(outside)}`,
      )
      await expect(tryServeStudioStyleCompileConsent(req, url, pathname)).rejects.toThrow(ProjectDirOutsideWorkspaceError)
    })
  })

  it('POST rejects a dir outside studio-workspace/ without writing anything', async () => {
    await withOutsideWorkspaceDir('style-consent-outside', async (outside) => {
      const { req, url, pathname } = makeRequest('/admin/api/studio/style-compile-consent', postBody({ dir: outside }))
      await expect(tryServeStudioStyleCompileConsent(req, url, pathname)).rejects.toThrow(ProjectDirOutsideWorkspaceError)
      expect(fs.existsSync(path.join(outside, '.studio'))).toBe(false)
    })
  })
})
