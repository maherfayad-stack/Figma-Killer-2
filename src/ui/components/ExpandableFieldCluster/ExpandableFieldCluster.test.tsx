import { describe, expect, it, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExpandableFieldCluster } from './ExpandableFieldCluster'

/**
 * A minimal stand-in for a real field (Input/TokenAwareInput/etc). Records
 * every "write" so tests can assert expanding never fires one.
 */
function Field({ label, onCommit }: { label: string; onCommit: () => void }) {
  return (
    <input
      aria-label={label}
      onChange={onCommit}
      data-testid={`field-${label}`}
    />
  )
}

function renderCluster(overrides: Partial<Parameters<typeof ExpandableFieldCluster>[0]> = {}) {
  const onCommit = mock(() => {})
  const props = {
    id: overrides.id ?? `cluster-${Math.random()}`,
    collapsed: overrides.collapsed ?? [
      <Field key="h" label="Horizontal" onCommit={onCommit} />,
      <Field key="v" label="Vertical" onCommit={onCommit} />,
    ],
    expanded: overrides.expanded ?? [
      <Field key="t" label="Top" onCommit={onCommit} />,
      <Field key="r" label="Right" onCommit={onCommit} />,
      <Field key="b" label="Bottom" onCommit={onCommit} />,
      <Field key="l" label="Left" onCommit={onCommit} />,
    ],
    linked: overrides.linked ?? true,
    expandLabel: overrides.expandLabel ?? 'Expand to individual padding sides',
    collapseLabel: overrides.collapseLabel ?? 'Collapse to horizontal and vertical padding',
  }
  const utils = render(<ExpandableFieldCluster {...props} />)
  return { ...utils, onCommit, id: props.id }
}

describe('ExpandableFieldCluster', () => {
  it('renders the collapsed fields and an unpressed, collapsed-state toggle by default when linked', () => {
    renderCluster({ id: 'padding-default', linked: true })

    expect(screen.getByLabelText('Horizontal')).toBeTruthy()
    expect(screen.getByLabelText('Vertical')).toBeTruthy()
    expect(screen.queryByLabelText('Top')).toBeNull()

    const toggle = screen.getByTestId('expandable-field-cluster-padding-default-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Expand to individual padding sides')
  })

  it('toggles from collapsed to expanded on click, flips pressed/aria-expanded and the label', async () => {
    const user = userEvent.setup()
    renderCluster({ id: 'padding-toggle', linked: true })

    await user.click(screen.getByTestId('expandable-field-cluster-padding-toggle-toggle'))

    expect(screen.getByLabelText('Top')).toBeTruthy()
    expect(screen.getByLabelText('Right')).toBeTruthy()
    expect(screen.getByLabelText('Bottom')).toBeTruthy()
    expect(screen.getByLabelText('Left')).toBeTruthy()
    expect(screen.queryByLabelText('Horizontal')).toBeNull()

    // Re-query: the Button primitive's Tooltip wrapper re-renders its own
    // child element when `aria-expanded` flips (it suppresses the tooltip
    // while a popup is "open"), so the underlying <button> node identity
    // does not survive the toggle — a stale reference would read pre-click
    // attributes.
    const toggleAfter = screen.getByTestId('expandable-field-cluster-padding-toggle-toggle')
    expect(toggleAfter.getAttribute('aria-expanded')).toBe('true')
    expect(toggleAfter.getAttribute('aria-pressed')).toBe('true')
    expect(toggleAfter.getAttribute('aria-label')).toBe('Collapse to horizontal and vertical padding')
  })

  it('expanding writes nothing — no field onCommit fires from the toggle click alone', async () => {
    const user = userEvent.setup()
    const { onCommit } = renderCluster({ id: 'padding-no-write', linked: true })

    const toggle = screen.getByTestId('expandable-field-cluster-padding-no-write-toggle')
    await user.click(toggle)
    await user.click(toggle) // and back

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('derives linked purely from the caller-supplied flag — collapsed when linked, expanded by default when not', () => {
    renderCluster({ id: 'radius-linked', linked: true })
    expect(screen.queryByLabelText('Top')).toBeNull()

    cleanup()

    renderCluster({ id: 'radius-unlinked', linked: false })
    expect(screen.getByLabelText('Top')).toBeTruthy()
  })

  it('auto-relinks (collapses) when linked flips from false to true while mounted', () => {
    const onCommit = mock(() => {})
    const { rerender } = render(
      <ExpandableFieldCluster
        id="stroke-relink"
        collapsed={[<Field key="w" label="Weight" onCommit={onCommit} />]}
        expanded={[
          <Field key="t" label="Top weight" onCommit={onCommit} />,
          <Field key="r" label="Right weight" onCommit={onCommit} />,
          <Field key="b" label="Bottom weight" onCommit={onCommit} />,
          <Field key="l" label="Left weight" onCommit={onCommit} />,
        ]}
        linked={false}
        expandLabel="Expand to individual side weights"
        collapseLabel="Collapse to a single weight"
      />,
    )

    // Starts expanded because linked=false at mount.
    expect(screen.getByLabelText('Top weight')).toBeTruthy()

    rerender(
      <ExpandableFieldCluster
        id="stroke-relink"
        collapsed={[<Field key="w" label="Weight" onCommit={onCommit} />]}
        expanded={[
          <Field key="t" label="Top weight" onCommit={onCommit} />,
          <Field key="r" label="Right weight" onCommit={onCommit} />,
          <Field key="b" label="Bottom weight" onCommit={onCommit} />,
          <Field key="l" label="Left weight" onCommit={onCommit} />,
        ]}
        linked
        expandLabel="Expand to individual side weights"
        collapseLabel="Collapse to a single weight"
      />,
    )

    // An external change (all sides now equal) collapses it back.
    expect(screen.queryByLabelText('Top weight')).toBeNull()
    expect(screen.getByLabelText('Weight')).toBeTruthy()
  })

  it('is sticky per cluster id across a simulated selection change (remount)', async () => {
    const user = userEvent.setup()
    const clusterId = 'padding-sticky'

    const { unmount } = renderCluster({ id: clusterId, linked: true })
    expect(screen.queryByLabelText('Top')).toBeNull()

    // User deliberately expands while node A is selected.
    const toggle = screen.getByTestId(`expandable-field-cluster-${clusterId}-toggle`)
    await user.click(toggle)
    expect(screen.getByLabelText('Top')).toBeTruthy()

    // Selecting a different node remounts the whole properties panel tree
    // (PropertiesPanel.tsx keys it by selectedNodeId) — simulate that here.
    unmount()

    // Node B also has uniform (linked) padding, which would collapse a
    // component with no memory of the user's choice. It must not.
    renderCluster({ id: clusterId, linked: true })
    expect(screen.getByLabelText('Top')).toBeTruthy()
  })

  it('does not leak stickiness across distinct cluster ids', () => {
    renderCluster({ id: 'radius-independent', linked: true })
    expect(screen.queryByLabelText('Top')).toBeNull()
  })
})
