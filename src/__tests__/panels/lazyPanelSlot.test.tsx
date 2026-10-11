/**
 * LazyPanelSlot - the first-open mount that keeps four docked panels out of
 * the editor body chunk (bundle-budget).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { LazyPanelSlot } from '@site/sidebars/LeftSidebar/LazyPanelSlot'

afterEach(cleanup)

describe('LazyPanelSlot', () => {
  it('renders nothing until the panel is first active', () => {
    render(
      <LazyPanelSlot active={false}>
        <div data-testid="panel" />
      </LazyPanelSlot>,
    )
    expect(screen.queryByTestId('panel')).toBeNull()
  })

  it('mounts on first activation and stays mounted after it is hidden again', () => {
    const { rerender } = render(
      <LazyPanelSlot active={false}>
        <div data-testid="panel" />
      </LazyPanelSlot>,
    )
    rerender(
      <LazyPanelSlot active>
        <div data-testid="panel" />
      </LazyPanelSlot>,
    )
    expect(screen.getByTestId('panel')).toBeTruthy()
    rerender(
      <LazyPanelSlot active={false}>
        <div data-testid="panel" />
      </LazyPanelSlot>,
    )
    expect(screen.getByTestId('panel')).toBeTruthy()
  })
})

describe('LeftSidebar - lazy docked panels', () => {
  const source = readFileSync(
    join(import.meta.dir, '../../admin/pages/site/sidebars/LeftSidebar/LeftSidebar.tsx'),
    'utf8',
  )

  for (const panel of ['FrameworkPanel', 'DependenciesPanel', 'VariablesPanel', 'GitPanel']) {
    it(`${panel} is a dynamic import, never a static one`, () => {
      expect(source).not.toMatch(new RegExp(`^import .*['"]@site/panels/${panel}['"]`, 'm'))
      expect(source).toContain(`import('@site/panels/${panel}')`)
    })
  }
})
