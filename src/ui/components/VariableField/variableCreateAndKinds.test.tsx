/**
 * CT-2: the kinds a field filters on (a control never offers a wrong-kind
 * variable), "Create variable from this value", and "Detach" in the picker.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScrubInput } from '@ui/components/ScrubInput'
import { VariableActionsContext, VariableSourceContext, type VariableActions } from './VariableSourceContext'
import { suggestVariableName, normalizeVariableName, isValidVariableName } from './suggestVariableName'
import { classifyVariableValue, filterVariablesByKind, type VariableOption } from './variableKind'

afterEach(cleanup)

describe('classifyVariableValue', () => {
  it('keeps colours, lengths and numbers apart', () => {
    expect(classifyVariableValue('#0c9ab0')).toBe('color')
    expect(classifyVariableValue('oklch(60% 0.2 250)')).toBe('color')
    expect(classifyVariableValue('16px')).toBe('length')
    expect(classifyVariableValue('1.5')).toBe('number')
  })

  it('recognises durations, font stacks and shadows as their own kinds', () => {
    expect(classifyVariableValue('200ms')).toBe('duration')
    expect(classifyVariableValue('0.3s')).toBe('duration')
    expect(classifyVariableValue('"Inter", system-ui, sans-serif')).toBe('font-family')
    expect(classifyVariableValue('Georgia, serif')).toBe('font-family')
    expect(classifyVariableValue('0 1px 2px rgb(0 0 0 / 0.2)')).toBe('shadow')
    expect(classifyVariableValue('inset 0 0 0 1px #ffffff, 0 4px 8px rgba(0,0,0,.3)')).toBe('shadow')
  })

  it('does not mistake a padding shorthand or a keyword for a shadow or a family', () => {
    expect(classifyVariableValue('4px 8px')).toBe('other')
    expect(classifyVariableValue('auto')).toBe('other')
    expect(classifyVariableValue('bold')).toBe('other')
  })
})

describe('filterVariablesByKind', () => {
  const options: VariableOption[] = [
    { name: '--c', resolvedValue: '#fff', kind: 'color', source: 'project' },
    { name: '--s', resolvedValue: '4px', kind: 'length', source: 'project' },
    { name: '--sh', resolvedValue: '0 1px 2px #000', kind: 'shadow', source: 'project' },
    { name: '--f', resolvedValue: 'Georgia, serif', kind: 'font-family', source: 'project' },
    { name: '--d', resolvedValue: '200ms', kind: 'duration', source: 'project' },
  ]

  it('never offers a field a kind it did not declare', () => {
    expect(filterVariablesByKind(options, ['length', 'number']).map((o) => o.name)).toEqual(['--s'])
    expect(filterVariablesByKind(options, ['shadow']).map((o) => o.name)).toEqual(['--sh'])
    expect(filterVariablesByKind(options, ['font-family']).map((o) => o.name)).toEqual(['--f'])
    expect(filterVariablesByKind(options, ['duration']).map((o) => o.name)).toEqual(['--d'])
    expect(filterVariablesByKind(options, ['color']).map((o) => o.name)).toEqual(['--c'])
  })
})

describe('suggestVariableName', () => {
  it('names a value after what it is, in the prefix the project already uses', () => {
    expect(suggestVariableName('color', '#0C9AB0', [])).toBe('--color-0c9ab0')
    expect(suggestVariableName('length', '16px', [])).toBe('--space-16')
    expect(suggestVariableName('length', '16px', [{ name: '--spacing-4', resolvedValue: '4px', kind: 'length', source: 'project' }])).toBe('--spacing-16')
    expect(suggestVariableName('font-family', '"Inter", sans-serif', [])).toBe('--font-inter')
  })

  it('never suggests a name that already exists', () => {
    const taken: VariableOption[] = [{ name: '--space-16', resolvedValue: '16px', kind: 'length', source: 'project' }]
    expect(suggestVariableName('length', '16px', taken)).toBe('--space-16-2')
  })

  it('normalises and validates what the user types', () => {
    expect(normalizeVariableName('brand')).toBe('--brand')
    expect(normalizeVariableName(' --brand ')).toBe('--brand')
    expect(isValidVariableName('--brand-1')).toBe(true)
    expect(isValidVariableName('--has space')).toBe(false)
    expect(isValidVariableName('--')).toBe(false)
  })
})

describe('Create variable from this value', () => {
  const CATALOG: VariableOption[] = [
    { name: '--space-4', resolvedValue: '16px', kind: 'length', source: 'project' },
  ]

  function renderField(value: string, actions: VariableActions | null, catalog: readonly VariableOption[] = CATALOG) {
    const onChange = mock(() => {})
    const tree: ReactNode = (
      <VariableSourceContext.Provider value={catalog}>
        <VariableActionsContext.Provider value={actions}>
          <ScrubInput value={value} onChange={onChange} label="W" aria-label="Width" data-testid="width" />
        </VariableActionsContext.Provider>
      </VariableSourceContext.Provider>
    )
    render(tree)
    return { onChange }
  }

  const open = (label = 'Apply variable to Width') => fireEvent.click(screen.getByRole('button', { name: label }))

  it('declares the variable, then binds the field to it', async () => {
    const createVariable = mock(async (request: { name: string; value: string }) => request.name)
    const { onChange } = renderField('24px', { createVariable })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Create variable from 24px/ }))
    const name = screen.getByRole('textbox', { name: 'New variable name' }) as HTMLInputElement
    expect(name.value).toBe('--space-24')
    fireEvent.change(name, { target: { value: 'gutter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('var(--gutter)'))
    expect(createVariable).toHaveBeenCalledWith({ name: '--gutter', value: '24px' })
  })

  it('offers the existing variable that already holds this value before making a duplicate', () => {
    const createVariable = mock(async (request: { name: string; value: string }) => request.name)
    const { onChange } = renderField('16px', { createVariable })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Use space-4 - same value/ }))
    expect(onChange).toHaveBeenCalledWith('var(--space-4)')
    expect(createVariable).not.toHaveBeenCalled()
  })

  it('shows the server refusal next to the control and leaves the field unbound', async () => {
    const createVariable = mock(async () => {
      throw new Error('The project has no global stylesheet to declare a token in.')
    })
    const { onChange } = renderField('24px', { createVariable })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Create variable from 24px/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toContain('no global stylesheet')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a name that already exists without calling the server', async () => {
    const createVariable = mock(async (request: { name: string; value: string }) => request.name)
    renderField('24px', { createVariable })
    open()
    fireEvent.click(screen.getByRole('button', { name: /Create variable from 24px/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'New variable name' }), { target: { value: 'space-4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')
    expect(createVariable).not.toHaveBeenCalled()
  })

  it('is not offered for a value the field cannot turn into a variable, or without an editor to write it', () => {
    const createVariable = mock(async (request: { name: string; value: string }) => request.name)
    renderField('auto', { createVariable }, [])
    expect(screen.queryByRole('button', { name: /variable/i })).toBeNull()
    cleanup()
    renderField('24px', null, [])
    expect(screen.queryByRole('button', { name: /variable/i })).toBeNull()
  })

  it('is not offered for a colour value in a length field', () => {
    renderField('#ff0000', { createVariable: mock(async (request: { name: string; value: string }) => request.name) }, [])
    expect(screen.queryByRole('button', { name: /variable/i })).toBeNull()
  })

  it('a bound field can detach from the picker, writing the resolved literal', () => {
    const { onChange } = renderField('var(--space-4)', null)
    open('Change variable for Width')
    fireEvent.click(screen.getByRole('button', { name: 'Detach variable' }))
    expect(onChange).toHaveBeenCalledWith('16px')
  })
})
