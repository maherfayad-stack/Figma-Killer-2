/**
 * Lazy panels draw a skeleton on first open, never a blank column (P2-H,
 * UX-24).
 *
 * Layers (`ExplorerPanel`) and the AI assistant (`AgentPanel`) are both
 * `lazy()` chunks, and both used to fall back to `null`: the first open of
 * the most-opened panel in the editor was an empty column for the whole
 * download.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExplorerPanel } from '@site/panels/ExplorerPanel'
import { useEditorStore } from '@site/store/store'
import { AgentPanelSkeleton } from '@site/sidebars/LeftSidebar/AgentPanelSkeleton'

afterEach(cleanup)

const SRC_ROOT = join(import.meta.dir, '../..')

describe('Layers — first open', () => {
  it('shows a tree skeleton while the explorer chunk is still loading', () => {
    const { unmount } = render(<ExplorerPanel />)
    // Synchronously, on the very first commit: `lazy()` always suspends on
    // its first render, so this is exactly the frame the user used to see
    // as an empty panel.
    const skeleton = screen.getByTestId('explorer-panel-skeleton')
    expect(skeleton.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status', { name: 'Loading layers' })).toBeTruthy()
    // Unmount before the chunk resolves: this case is about the fallback,
    // and the explorer body needs a project this test does not load.
    unmount()
  })
})

describe('AI assistant — first open', () => {
  it('mounts the skeleton as the Agent panel Suspense fallback', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'admin/pages/site/sidebars/LeftSidebar/LeftSidebar.tsx'),
      'utf8',
    )
    expect(source).toMatch(/<Suspense fallback=\{<AgentPanelSkeleton \/>\}>\s*<AgentPanel variant="docked" \/>/)
  })

  it('draws the real header, so the tab can be closed before the chunk lands', () => {
    useEditorStore.getState().openAgent()
    expect(useEditorStore.getState().isAgentOpen).toBe(true)
    render(<AgentPanelSkeleton />)
    expect(screen.getByText('AI Assistant')).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Loading AI assistant' })).toBeTruthy()
    fireEvent.click(screen.getByTestId('panel-close-agent'))
    expect(useEditorStore.getState().isAgentOpen).toBe(false)
  })
})
