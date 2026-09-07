/**
 * DashboardPage — the delete flow's UI wiring, and what the page does when the
 * listing itself fails.
 *
 * `projectTrash.test.ts` proves the files survive; these tests prove the user
 * cannot reach that code by accident. The case that matters most is the second
 * one: pressing Delete on a tile must open a question, not delete a project.
 *
 * The `useStudioProjects` stand-in is a real hook, not a constant: the page now
 * redraws by calling `refresh()` rather than by splicing a local copy, so a
 * mock that cannot re-render cannot exercise the flow. `server` is the fixture
 * standing in for what the next listing would return.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'

const ALPHA = { dir: '/ws/alpha', name: 'alpha', pageCount: 2 }
const BETA = { dir: '/ws/beta', name: 'beta', pageCount: 1 }

const deleteCalls: string[] = []
const refreshCalls: string[] = []

/** What the (stubbed) server would answer with right now. */
const server: { projects: typeof ALPHA[] | null; error: string | null } = {
  projects: [ALPHA, BETA],
  error: null,
}

const studioProjects = await import('./hooks/useStudioProjects')
mock.module('./hooks/useStudioProjects', () => ({
  ...studioProjects,
  useStudioProjects: () => {
    const [, redraw] = useState(0)
    return {
      projects: server.projects,
      loading: false,
      error: server.error,
      refresh: () => {
        refreshCalls.push('refresh')
        redraw((n) => n + 1)
      },
    }
  },
  deleteStudioProject: async (dir: string) => {
    deleteCalls.push(dir)
    server.projects = (server.projects ?? []).filter((p) => p.dir !== dir)
  },
}))

// Spread the real module and override one export, rather than replacing it
// wholesale: these modules have OTHER importers in the render tree, and a
// replacement object drops the exports they need (`useAdminSessionSetter`,
// for one) into a module-resolution error that reads nothing like its cause.
// The page chrome is not under test, and rendering it drags in the whole admin
// shell — `AccountMenuButton` alone requires a `StepUpProvider`. A passthrough
// keeps the test about the project grid.
const adminPageLayout = await import('@admin/layouts/AdminPageLayout')
mock.module('@admin/layouts/AdminPageLayout', () => ({
  ...adminPageLayout,
  AdminPageLayout: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

const sessionContext = await import('@admin/sessionContext')
mock.module('@admin/sessionContext', () => ({
  ...sessionContext,
  useAuthenticatedAdminUser: () => ({ displayName: 'Tester' }),
}))

const adminNavigate = await import('@admin/lib/useAdminNavigate')
mock.module('@admin/lib/useAdminNavigate', () => ({
  ...adminNavigate,
  useAdminNavigate: () => () => {},
}))

const { DashboardPage } = await import('./DashboardPage')

afterEach(() => {
  deleteCalls.length = 0
  refreshCalls.length = 0
  server.projects = [ALPHA, BETA]
  server.error = null
  cleanup()
})

describe('DashboardPage delete flow', () => {
  it('offers a delete control on every project tile', async () => {
    render(<DashboardPage />)

    expect(await screen.findByRole('button', { name: 'Delete alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeTruthy()
  })

  it('asks before deleting anything', async () => {
    render(<DashboardPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete alpha' }))

    // The confirmation names the project, so a mis-aimed click is visible
    // before it is destructive.
    expect(await screen.findByText(/Delete .*alpha.*\?/)).toBeTruthy()
    // And nothing has been deleted yet — this is the whole point of the step.
    expect(deleteCalls).toEqual([])
  })

  it('deletes the confirmed project and drops its tile', async () => {
    render(<DashboardPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete alpha' }))
    fireEvent.click(await screen.findByRole('button', { name: /delete project/i }))

    await waitFor(() => expect(deleteCalls).toEqual([ALPHA.dir]))
    // The tile goes because the launcher refetched, not because it spliced its
    // own copy of the list — that is the whole point of the refresh handle.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete alpha' })).toBeNull()
    })
    expect(refreshCalls.length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeTruthy()
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    render(<DashboardPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete beta' }))
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

    await waitFor(() => {
      expect(screen.queryByText(/Delete .*beta.*\?/)).toBeNull()
    })
    expect(deleteCalls).toEqual([])
    expect(screen.getByRole('button', { name: 'Delete beta' })).toBeTruthy()
  })
})

/**
 * A failed listing used to leave six skeleton tiles shimmering forever: the
 * hook swallowed the error, so "loading" and "broken" were the same screen and
 * only one of them ever ended.
 */
describe('DashboardPage failed listing', () => {
  it('says the listing failed instead of shimmering forever', async () => {
    server.projects = null
    server.error = 'Network request failed'

    render(<DashboardPage />)

    expect(await screen.findByText('Could not load your projects.')).toBeTruthy()
    // The reason survives to the screen — not just "something went wrong".
    expect(screen.getByText('Network request failed')).toBeTruthy()
    expect(screen.queryByLabelText('Loading projects')).toBeNull()
  })

  it('retries the listing from the failure state', async () => {
    server.projects = null
    server.error = 'Network request failed'

    render(<DashboardPage />)

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }))

    expect(refreshCalls.length).toBe(1)
  })
})
