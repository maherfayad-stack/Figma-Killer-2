/**
 * Pre-flight write lock on a class property row.
 *
 * The failure this pins: a class with no hand-editable CSS source (a compiled
 * Tailwind/CSS-Modules artefact, an unmapped rule) rendered every property row
 * fully editable. The user typed, the canvas updated, and ~2 s later autosave
 * came back with a toast naming the selector it had not written. Nothing in
 * the panel said so BEFORE the keystroke, and the value was then only in the
 * browser.
 *
 * `StyleWriteLockContext` carries the reason from `StyleSurface` (which owns
 * the verdict, via `classCssWritability.ts`) down to every row. A locked row
 * must: render its control disabled, keep SHOWING its value (seeing what a
 * compiled class declares is the reason to open it at all), drop its remove
 * button, and refuse `onChange`/`onRemove` even if something reaches the
 * handlers anyway.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ClassPropertyRow } from '@site/panels/PropertiesPanel/ClassPropertyRow'
import { StyleWriteLockContext } from '@site/panels/PropertiesPanel/StyleWriteLockContext'

afterEach(cleanup)

const noop = () => {}

const LOCK_REASON = 'This file lives in a build/output directory, not the project’s own source.'

function renderLocked(children: ReactNode) {
  return render(
    <StyleWriteLockContext.Provider value={LOCK_REASON}>{children}</StyleWriteLockContext.Provider>,
  )
}

describe('ClassPropertyRow write lock', () => {
  it('disables a text row and still shows its value', () => {
    renderLocked(
      <ClassPropertyRow property="width" value="240px" onChange={noop} onRemove={noop} />,
    )

    const input = screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('240px')
  })

  it('disables an icon toggle group', () => {
    renderLocked(
      <ClassPropertyRow property="textAlign" value="center" onChange={noop} onRemove={noop} />,
    )

    const group = screen.getByRole('group', { name: 'Text align' })
    const segments = within(group).getAllByRole('button')
    expect(segments.length).toBeGreaterThan(0)
    // `Button` converts `disabled` + `tooltip` into `aria-disabled` (so the
    // tooltip explaining why can still fire) and intercepts the click itself.
    expect(segments.every((segment) => segment.getAttribute('aria-disabled') === 'true')).toBe(true)
  })

  it('disables a select row', () => {
    renderLocked(
      <ClassPropertyRow property="position" value="absolute" onChange={noop} onRemove={noop} />,
    )
    const select = screen.getByRole('combobox', { name: 'Position' }) as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('drops the remove button — removing a declaration is a write too', () => {
    renderLocked(
      <ClassPropertyRow property="width" value="240px" isSet onChange={noop} onRemove={noop} />,
    )
    expect(screen.queryByRole('button', { name: /Remove Width/ })).toBeNull()
  })

  it('marks the row and carries the reason where the cursor can reach it', () => {
    renderLocked(
      <ClassPropertyRow property="width" value="240px" onChange={noop} onRemove={noop} />,
    )
    const row = screen.getByTestId('css-property-row-width')
    expect(row.getAttribute('data-write-locked')).toBe('true')
    expect(row.getAttribute('title')).toBe(LOCK_REASON)
  })

  it('refuses a change even if a handler is reached anyway', () => {
    const written: unknown[] = []
    renderLocked(
      <ClassPropertyRow
        property="width"
        value="240px"
        onChange={(_p, v) => written.push(v)}
        onRemove={noop}
      />,
    )

    const input = screen.getByRole('textbox', { name: 'Width' })
    fireEvent.change(input, { target: { value: '999px' } })
    expect(written).toEqual([])
  })

  it('leaves rows editable with no lock in scope — the honest default', () => {
    render(<ClassPropertyRow property="width" value="240px" isSet onChange={noop} onRemove={noop} />)

    const input = screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement
    expect(input.disabled).toBe(false)
    const row = screen.getByTestId('css-property-row-width')
    expect(row.getAttribute('data-write-locked')).toBeNull()
    expect(screen.getByRole('button', { name: /Remove Width/ })).toBeTruthy()
  })
})
