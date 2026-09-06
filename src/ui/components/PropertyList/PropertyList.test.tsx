import { useState } from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PropertyList, type PropertyListEntry } from './PropertyList'

interface Fixture {
  color: string
}

function makeEntry(id: string, label: string, color: string): PropertyListEntry<Fixture> {
  return { id, label, summary: color, data: { color } }
}

describe('PropertyList', () => {
  it('renders nothing when entries is empty (Law 1)', () => {
    const { container } = render(
      <PropertyList listLabel="Fill" entries={[]} onRemove={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('renders each entry into its leading/summary/value slots', () => {
    const entries: PropertyListEntry<Fixture>[] = [
      {
        id: 'fill-1',
        label: 'Fill 1',
        leading: <span data-testid="swatch">■</span>,
        summary: '#FFFFFF',
        value: '100%',
        data: { color: '#FFFFFF' },
      },
    ]
    render(<PropertyList listLabel="Fill" entries={entries} onRemove={() => {}} />)

    expect(screen.getByRole('list', { name: 'Fill' })).toBeTruthy()
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('#FFFFFF')
    expect(row.textContent).toContain('100%')
    expect(screen.getByTestId('swatch')).toBeTruthy()
  })

  it('fires onActivate with the entry and a ref anchored to the row, on row click only', async () => {
    const user = userEvent.setup()
    const onActivate = mock(() => {})
    const entries = [makeEntry('fill-1', 'Fill 1', '#FFFFFF')]

    render(<PropertyList listLabel="Fill" entries={entries} onActivate={onActivate} onRemove={() => {}} />)

    await user.click(screen.getByText('#FFFFFF'))

    expect(onActivate).toHaveBeenCalledTimes(1)
    const [entryArg, anchorRef] = onActivate.mock.calls[0] as [PropertyListEntry<Fixture>, { current: HTMLElement | null }]
    expect(entryArg.id).toBe('fill-1')
    expect(entryArg.data.color).toBe('#FFFFFF')
    expect(anchorRef.current).toBeInstanceOf(HTMLElement)
    expect(anchorRef.current?.getAttribute('role')).toBe('listitem')
  })

  it('does not fire onActivate when the remove button inside the row is clicked', async () => {
    const user = userEvent.setup()
    const onActivate = mock(() => {})
    const entries = [makeEntry('fill-1', 'Fill 1', '#FFFFFF')]

    render(
      <PropertyList listLabel="Fill" entries={entries} onActivate={onActivate} onRemove={() => {}} />,
    )

    await user.click(screen.getByRole('button', { name: 'Remove Fill 1' }))
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('omits the visibility eye when onToggleVisible is not passed', () => {
    const entries = [makeEntry('fill-1', 'Fill 1', '#FFFFFF')]
    render(<PropertyList listLabel="Fill" entries={entries} onRemove={() => {}} />)

    expect(screen.queryByRole('button', { name: /hide|show/i })).toBeNull()
  })

  it('renders the visibility eye, named per-entry, when onToggleVisible is passed', async () => {
    const user = userEvent.setup()
    const onToggleVisible = mock(() => {})
    const entries = [makeEntry('fill-1', 'Fill 1', '#FFFFFF')]

    render(
      <PropertyList
        listLabel="Fill"
        entries={entries}
        onRemove={() => {}}
        onToggleVisible={onToggleVisible}
      />,
    )

    const eyeButton = screen.getByRole('button', { name: 'Hide Fill 1' })
    await user.click(eyeButton)
    expect(onToggleVisible).toHaveBeenCalledTimes(1)
    expect(onToggleVisible.mock.calls[0][0].id).toBe('fill-1')
  })

  // ── Remove + focus restoration ────────────────────────────────────────────

  function RemoveHarness({ onRemoveSpy }: { onRemoveSpy: (id: string) => void }) {
    const [entries, setEntries] = useState<PropertyListEntry<Fixture>[]>([
      makeEntry('fill-1', 'Fill 1', '#111111'),
      makeEntry('fill-2', 'Fill 2', '#222222'),
    ])
    const addRef = { current: null as HTMLButtonElement | null }

    return (
      <div>
        <button ref={(el) => { addRef.current = el }} type="button">
          Add fill
        </button>
        <PropertyList
          listLabel="Fill"
          entries={entries}
          onRemove={(entry) => {
            onRemoveSpy(entry.id)
            setEntries((prev) => prev.filter((e) => e.id !== entry.id))
          }}
          addTriggerRef={addRef}
        />
      </div>
    )
  }

  it('moves focus to the remaining row after removing one of two entries', async () => {
    const user = userEvent.setup()
    const onRemoveSpy = mock((_id: string) => {})
    render(<RemoveHarness onRemoveSpy={onRemoveSpy} />)

    await user.click(screen.getByRole('button', { name: 'Remove Fill 1' }))

    expect(onRemoveSpy).toHaveBeenCalledWith('fill-1')
    const remainingRow = screen.getByRole('listitem')
    expect(remainingRow.textContent).toContain('#222222')
    expect(document.activeElement).toBe(remainingRow)
  })

  it('moves focus to the addTriggerRef target once the list empties', async () => {
    const user = userEvent.setup()
    const onRemoveSpy = mock((_id: string) => {})
    render(<RemoveHarness onRemoveSpy={onRemoveSpy} />)

    await user.click(screen.getByRole('button', { name: 'Remove Fill 1' }))
    await user.click(screen.getByRole('button', { name: 'Remove Fill 2' }))

    expect(screen.queryByRole('list')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add fill' }))
  })

  // ── Keyboard reorder ───────────────────────────────────────────────────────

  function ReorderHarness({ onReorderSpy }: { onReorderSpy: (from: number, to: number) => void }) {
    const [entries, setEntries] = useState<PropertyListEntry<Fixture>[]>([
      makeEntry('a', 'Effect A', 'A'),
      makeEntry('b', 'Effect B', 'B'),
      makeEntry('c', 'Effect C', 'C'),
    ])

    return (
      <PropertyList
        listLabel="Effects"
        entries={entries}
        onRemove={() => {}}
        onReorder={(from, to) => {
          onReorderSpy(from, to)
          setEntries((prev) => {
            const next = [...prev]
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved)
            return next
          })
        }}
      />
    )
  }

  it('reorders a focused row up with Alt+ArrowUp and keeps focus on it', async () => {
    const user = userEvent.setup()
    const onReorderSpy = mock((_f: number, _t: number) => {})
    render(<ReorderHarness onReorderSpy={onReorderSpy} />)

    const rows = screen.getAllByRole('listitem')
    rows[1].focus()
    expect(rows[1].textContent).toContain('B')

    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')

    expect(onReorderSpy).toHaveBeenCalledWith(1, 0)
    const reorderedRows = screen.getAllByRole('listitem')
    expect(reorderedRows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('B'),
      expect.stringContaining('A'),
      expect.stringContaining('C'),
    ])
    expect(document.activeElement?.textContent).toContain('B')
  })

  it('does not reorder past either edge of the list', async () => {
    const user = userEvent.setup()
    const onReorderSpy = mock((_f: number, _t: number) => {})
    render(<ReorderHarness onReorderSpy={onReorderSpy} />)

    const rows = screen.getAllByRole('listitem')
    rows[0].focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(onReorderSpy).not.toHaveBeenCalled()
  })
})
