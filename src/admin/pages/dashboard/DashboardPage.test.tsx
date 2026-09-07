/**
 * DashboardPage — the per-project verbs' UI wiring, and what the page does when
 * the listing itself fails.
 *
 * `projectTrash.test.ts` / `projectDuplicate.test.ts` prove what happens on
 * disk; these tests prove the user cannot reach the destructive one by
 * accident. The case that matters most is still "pressing Delete must open a
 * question, not delete a project" — and it now has a step in front of it,
 * because Delete moved off a hover-only trash ghost into the card's action
 * menu, where a mis-aimed click lands on nothing.
 *
 * The `useStudioProjects` stand-in is a real hook, not a constant: the page
 * redraws by calling `refresh()` rather than by splicing a local copy, so a
 * mock that cannot re-render cannot exercise the flow. `server` is the fixture
 * standing in for what the next listing would return.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'

const EDITED_AT = Date.parse('2026-09-05T12:00:00Z')
const ALPHA = {
  dir: '/ws/alpha',
  name: 'alpha',
  pageCount: 2,
  platform: 'mobile' as const,
  framework: 'vite' as const,
  trust: 'static' as const,
  styleToolchains: ['tailwind' as const],
  editedAt: EDITED_AT,
  hasThumbnail: false,
}
const BETA = {
  dir: '/ws/beta',
  name: 'beta',
  pageCount: 1,
  trust: 'render-packages' as const,
  styleToolchains: ['sass' as const],
  editedAt: EDITED_AT,
  hasThumbnail: true,
  thumbnailUpdatedAt: EDITED_AT,
}

const deleteCalls: string[] = []
const duplicateCalls: string[] = []
const renameCalls: Array<[string, string]> = []
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
  duplicateStudioProject: async (dir: string) => {
    duplicateCalls.push(dir)
    return { ...ALPHA, dir: `${dir}-copy`, name: 'alpha copy' }
  },
  renameStudioProject: async (dir: string, name: string) => {
    renameCalls.push([dir, name])
    server.projects = (server.projects ?? []).map((p) => (p.dir === dir ? { ...p, name } : p))
    return { ...ALPHA, dir, name }
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
  duplicateCalls.length = 0
  renameCalls.length = 0
  refreshCalls.length = 0
  server.projects = [ALPHA, BETA]
  server.error = null
  cleanup()
})

/** Opens a card's action menu — the one route to Rename / Duplicate / Delete. */
async function openCardMenu(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }))
}

describe('DashboardPage card actions', () => {
  it('offers Open / Rename / Duplicate / Delete on every project tile', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')

    for (const verb of ['Open', 'Rename', 'Duplicate', 'Delete']) {
      expect(screen.getByRole('menuitem', { name: verb })).toBeTruthy()
    }
  })

  it('duplicates the project and redraws from the server', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    await waitFor(() => expect(duplicateCalls).toEqual([ALPHA.dir]))
    expect(refreshCalls.length).toBeGreaterThan(0)
  })

  it('renames inline, committing on Enter', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const field = await screen.findByLabelText('Rename alpha')
    fireEvent.change(field, { target: { value: 'Alpha renamed' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field)

    await waitFor(() => expect(renameCalls).toEqual([[ALPHA.dir, 'Alpha renamed']]))
  })

  it('renames nothing when the field is dismissed with Escape', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))

    const field = await screen.findByLabelText('Rename alpha')
    fireEvent.change(field, { target: { value: 'Discarded' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)

    await waitFor(() => expect(screen.queryByLabelText('Rename alpha')).toBeNull())
    expect(renameCalls).toEqual([])
  })
})

describe('DashboardPage delete flow', () => {
  it('asks before deleting anything', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    // The confirmation names the project, so a mis-aimed click is visible
    // before it is destructive.
    expect(await screen.findByText(/Delete .*alpha.*\?/)).toBeTruthy()
    // And nothing has been deleted yet — this is the whole point of the step.
    expect(deleteCalls).toEqual([])
  })

  it('deletes the confirmed project and drops its tile', async () => {
    render(<DashboardPage />)

    await openCardMenu('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: /delete project/i }))

    await waitFor(() => expect(deleteCalls).toEqual([ALPHA.dir]))
    // The tile goes because the launcher refetched, not because it spliced its
    // own copy of the list — that is the whole point of the refresh handle.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Actions for alpha' })).toBeNull()
    })
    expect(refreshCalls.length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Actions for beta' })).toBeTruthy()
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    render(<DashboardPage />)

    await openCardMenu('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

    await waitFor(() => {
      expect(screen.queryByText(/Delete .*beta.*\?/)).toBeNull()
    })
    expect(deleteCalls).toEqual([])
    expect(screen.getByRole('button', { name: 'Actions for beta' })).toBeTruthy()
  })
})

/**
 * The card's whole reason for carrying badges: a Tier-0 project whose Tailwind
 * has never run opens unstyled, and the only place that was ever said used to
 * be a banner on the board — after the user had opened it and started
 * wondering.
 */
describe('DashboardPage project card facts', () => {
  it('badges the platform, the framework, and styles that will not render', async () => {
    render(<DashboardPage />)

    expect(await screen.findByText('Mobile')).toBeTruthy()
    expect(screen.getByText('Vite')).toBeTruthy()
    expect(screen.getByText('Tailwind not compiled')).toBeTruthy()
  })

  it('does not claim uncompiled styles for a promoted project', async () => {
    render(<DashboardPage />)

    // BETA is at Tier 1 with a Sass toolchain — the compile HAPPENS there, so
    // saying it does not would be false.
    await screen.findByText('Vite')
    expect(screen.queryByText('Sass not compiled')).toBeNull()
  })

  it('says when each project was last edited', async () => {
    render(<DashboardPage />)

    expect((await screen.findAllByText(/Edited/)).length).toBe(2)
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
