/**
 * DashboardPage — the delete flow's UI wiring.
 *
 * `projectTrash.test.ts` proves the files survive; these tests prove the user
 * cannot reach that code by accident. The case that matters most is the second
 * one: pressing Delete on a tile must open a question, not delete a project.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const ALPHA = { dir: '/ws/alpha', name: 'alpha', pageCount: 2 }
const BETA = { dir: '/ws/beta', name: 'beta', pageCount: 1 }

const deleteCalls: string[] = []

const studioProjects = await import('./hooks/useStudioProjects')
mock.module('./hooks/useStudioProjects', () => ({
  ...studioProjects,
  useStudioProjects: () => [ALPHA, BETA],
  deleteStudioProject: async (dir: string) => {
    deleteCalls.push(dir)
    return [BETA]
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
    // The launcher subtracts it locally — `useStudioProjects` has no refetch.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete alpha' })).toBeNull()
    })
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
