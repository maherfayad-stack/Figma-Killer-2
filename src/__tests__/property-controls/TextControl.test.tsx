/**
 * `TextControl` — draft-then-commit, Escape reverts (P2-G, UX-16).
 *
 * The field used to call `onChange` on every keystroke — for a component
 * prop, one source write per character — and Escape did nothing. These tests
 * drive the real control with real key events: typing writes nothing, blur
 * and Enter commit once, Escape restores the pre-edit value and writes
 * nothing.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TextControl } from '@site/property-controls/TextControl'

afterEach(() => {
  cleanup()
})

function renderField(props: Partial<Parameters<typeof TextControl>[0]> = {}) {
  const onChange = mock((_key: string, _next: string) => {})
  const result = render(
    <TextControl propKey="label" label="Label" value="Get started" onChange={onChange} {...props} />,
  )
  const input = screen.getByRole('textbox', { name: props.label ?? 'Label' }) as HTMLInputElement
  return { ...result, onChange, input }
}

describe('TextControl — draft, then commit', () => {
  it('writes nothing while the user types', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()
    await user.clear(input)
    await user.type(input, 'Buy now')
    expect(input.value).toBe('Buy now')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits once, on blur', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()
    await user.clear(input)
    await user.type(input, 'Buy now')
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('label', 'Buy now')
  })

  it('commits once on Enter and keeps the caret in the field', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()
    await user.clear(input)
    await user.type(input, 'Buy now{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('label', 'Buy now')
    expect(document.activeElement).toBe(input)
  })

  it('Escape restores the pre-edit value, leaves the field, and writes nothing', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()
    await user.clear(input)
    await user.type(input, 'Buy now')
    await user.keyboard('{Escape}')
    expect(input.value).toBe('Get started')
    expect(document.activeElement).not.toBe(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('focusing and leaving an untouched field writes nothing', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField()
    await user.click(input)
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('follows the store value while not being edited', () => {
    const { input, rerender, onChange } = renderField()
    rerender(<TextControl propKey="label" label="Label" value="Changed elsewhere" onChange={onChange} />)
    expect(input.value).toBe('Changed elsewhere')
  })

  it('a parked caret follows the store and commits nothing (§5.4, ERR-1)', async () => {
    const user = userEvent.setup()
    const { input, rerender, onChange } = renderField()
    await user.click(input)
    rerender(<TextControl propKey="label" label="Label" value="Undone elsewhere" onChange={onChange} />)
    expect(input.value).toBe('Undone elsewhere')
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('text the user is typing is never overwritten by an outside change', async () => {
    const user = userEvent.setup()
    const { input, rerender, onChange } = renderField()
    await user.clear(input)
    await user.type(input, 'Buy now')
    rerender(<TextControl propKey="label" label="Label" value="Changed elsewhere" onChange={onChange} />)
    expect(input.value).toBe('Buy now')
  })

  it('an untouched Mixed field stays mixed on blur', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ mixed: true })
    expect(input.value).toBe('')
    await user.click(input)
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a numeric field gives a bare number its unit on commit', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ propKey: 'borderWidth', label: 'Width', value: '1px', numericUnit: 'px' })
    await user.clear(input)
    await user.type(input, '4')
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('borderWidth', '4px')
  })

  it('an arrow-key nudge on a numeric field writes straight away', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ propKey: 'borderWidth', label: 'Width', value: '1px', numericUnit: 'px' })
    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenCalledWith('borderWidth', '2px')
    expect(input.value).toBe('2px')
  })

  it('an identifier field normalises as the user types and commits the normalised name', async () => {
    const user = userEvent.setup()
    const { input, onChange } = renderField({ propKey: 'name', label: 'Name', value: '', normalize: 'identifier' })
    await user.type(input, 'my field')
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()
    expect(onChange).toHaveBeenCalledTimes(1)
    const [, written] = onChange.mock.calls[0]!
    expect(written).not.toContain(' ')
  })
})
