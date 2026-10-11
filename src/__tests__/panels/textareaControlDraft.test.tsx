/**
 * The inspector's multi-line Text field is a draft: typing writes nothing,
 * Enter or blur commits once, Shift+Enter is a line break only where the value
 * can hold one, Escape puts the old value back. It used to write per keystroke
 * (one undo per character) and Enter inserted "\n", which turned
 * `title="First"` into `title={"Alpha\n"}`.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TextareaControl } from '@site/property-controls/TextareaControl'

afterEach(cleanup)

function setup(props: { value?: string; multiline?: boolean } = {}) {
  const onChange = mock((_key: string, _value: string) => {})
  render(<TextareaControl propKey="text" label="Text" value={props.value ?? 'First'} multiline={props.multiline} onChange={onChange} />)
  const field = screen.getByRole('textbox') as HTMLTextAreaElement
  return { onChange, field }
}

describe('TextareaControl — draft, then commit once', () => {
  it('writes nothing while typing, and exactly one value on Enter', () => {
    const { onChange, field } = setup()
    for (const typed of ['A', 'Al', 'Alp', 'Alpha']) fireEvent.change(field, { target: { value: typed } })
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.keyDown(field, { key: 'Enter' })

    expect(onChange.mock.calls).toEqual([['text', 'Alpha']])
  })

  it('Enter is not a newline, even in a multi-line field', () => {
    const { field } = setup({ multiline: true })
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter' })
    expect(notPrevented).toBe(false)
  })

  it('Shift+Enter is left to the browser (a line break) when the value can hold one', () => {
    const { onChange, field } = setup({ multiline: true })
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(notPrevented).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Shift+Enter commits like Enter when the value is an attribute, and line breaks fold to spaces', () => {
    const { onChange, field } = setup({ multiline: false })
    fireEvent.change(field, { target: { value: 'Alpha\nBeta' } })
    expect(field.value).toBe('Alpha Beta')
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(onChange.mock.calls).toEqual([['text', 'Alpha Beta']])
  })

  it('blur commits, and an untouched blur writes nothing', () => {
    const { onChange, field } = setup()
    fireEvent.focus(field)
    fireEvent.blur(field)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: 'Beta' } })
    fireEvent.blur(field)
    expect(onChange.mock.calls).toEqual([['text', 'Beta']])
  })

  it('Escape restores the value and writes nothing', () => {
    const { onChange, field } = setup()
    fireEvent.change(field, { target: { value: 'Gamma' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field.value).toBe('First')
    expect(onChange).not.toHaveBeenCalled()
  })
})
