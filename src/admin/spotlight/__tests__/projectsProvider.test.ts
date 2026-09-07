/**
 * projectsProvider — "Open project …" in ⌘K.
 *
 * The properties worth pinning are the ones that make the row a shortcut
 * rather than a detour: it matches on the name the launcher renders, it opens
 * WITHOUT going via the dashboard, and it requests a site reload before
 * pointing Studio at the new directory — without that, switching projects in
 * one session can leave the previous project's page tree on screen under the
 * new project's path (the same trap `DashboardPage.openProject` documents).
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { CommandContext, CommandRunContext } from '../types'

const reloadCalls: string[] = []
const workspaceDirCalls: string[] = []

const adminEvents = await import('@admin/state/adminEvents')
mock.module('@admin/state/adminEvents', () => ({
  ...adminEvents,
  requestCmsSiteReload: () => reloadCalls.push('reload'),
}))

const workspaceDir = await import('@site/studio/studioWorkspaceDir')
mock.module('@site/studio/studioWorkspaceDir', () => ({
  ...workspaceDir,
  setStudioWorkspaceDir: (dir: string) => workspaceDirCalls.push(dir),
}))

const { projectsProvider } = await import('../providers/projectsProvider')

const ctx = {} as CommandContext
const signal = new AbortController().signal

const PROJECTS = [
  { dir: '/ws/acme-widgets', name: 'Acme Widgets', pageCount: 4 },
  { dir: '/ws/beta', name: 'Beta', pageCount: 1 },
]

function stubFetch(body: unknown = { projects: PROJECTS }) {
  return spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

afterEach(() => {
  reloadCalls.length = 0
  workspaceDirCalls.length = 0
  mock.restore()
})

describe('projectsProvider', () => {
  it('offers every project when nothing has been typed yet', async () => {
    stubFetch()

    const results = await projectsProvider.search('', ctx, signal)

    expect(results.map((command) => command.title)).toEqual(['Open Acme Widgets', 'Open Beta'])
    expect(results[0]!.subtitle).toBe('4 pages')
  })

  it('matches on the display name, case-insensitively', async () => {
    stubFetch()

    const results = await projectsProvider.search('acme', ctx, signal)

    expect(results.map((command) => command.title)).toEqual(['Open Acme Widgets'])
  })

  it('singularises a one-page project', async () => {
    stubFetch()

    const results = await projectsProvider.search('beta', ctx, signal)

    expect(results[0]!.subtitle).toBe('1 page')
  })

  it('opens the project directly: reload requested, dir set, then navigate', async () => {
    stubFetch()
    const navigated: string[] = []
    const closed: string[] = []

    const [command] = await projectsProvider.search('beta', ctx, signal)
    command!.run({
      navigate: (path: string) => navigated.push(path),
      closeSpotlight: () => closed.push('closed'),
    } as unknown as CommandRunContext)

    // The reload must be requested BEFORE the directory changes, or the next
    // Site-editor mount short-circuits on the previous project's `existingSite`.
    expect(reloadCalls).toEqual(['reload'])
    expect(workspaceDirCalls).toEqual(['/ws/beta'])
    expect(navigated).toEqual(['/admin/site'])
    expect(closed).toEqual(['closed'])
  })

  it('yields nothing rather than throwing when the palette cancels the request', async () => {
    spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })

    expect(await projectsProvider.search('acme', ctx, signal)).toEqual([])
  })
})
