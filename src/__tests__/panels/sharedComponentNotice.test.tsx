/**
 * `SharedComponentNotice` — what an edit to an element of a shared component
 * does, stated next to the controls that would do it.
 *
 * P3-C (WB-6): it must not claim a text edit lands on every instance when the
 * text is written at the call site. `<SectionHeading title="Weeknight dinners"/>`
 * renders `<h2>{title}</h2>`; the `<h2>` is inlined out of
 * `SectionHeading.tsx`, but its text is the call site's own literal, and a text
 * edit rewrites that one attribute. The notice names where.
 *
 * OD-19: a value changed inside an instance applies to THAT instance, so the
 * default state says so, and "Edit main component" is the explicit way to
 * change every place instead — a banner until "Done".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SharedComponentNotice } from '@site/panels/PropertiesPanel/SharedComponentNotice'
import { useEditorStore } from '@site/store/store'

afterEach(cleanup)

beforeEach(() => {
  useEditorStore.setState({ mainEditComponent: null })
})

const NODE_ID = 'pages/Recipes.tsx:10:7~components/SectionHeading.tsx:5:7'

describe('SharedComponentNotice', () => {
  it('names the call site when the text is written there', () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} textOrigin={{ rel: 'pages/Recipes.tsx', line: 10 }} />)
    const text = screen.getByRole('note').textContent ?? ''
    expect(text).toContain('Part of SectionHeading')
    expect(text).toContain('a text edit is written to pages/Recipes.tsx:10 instead')
  })

  it('says nothing extra when the text lives in the component itself, or there is none', () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} textOrigin={{ rel: 'components/SectionHeading.tsx', line: 5 }} />)
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
    cleanup()
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} />)
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
  })
})

describe('SharedComponentNotice — instance-only by default, "Edit main component" on request (OD-19)', () => {
  it('says which values change this instance only, and offers the explicit mode', () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} />)
    const text = screen.getByRole('note').textContent ?? ''
    expect(text).toContain('change this instance only')
    expect(text).toContain('change every place')
    expect(screen.queryByTestId('shared-component-done-main')).toBeNull()
    expect(screen.getByTestId('shared-component-edit-main')).toBeTruthy()
  })

  it('turns into the all-instances banner until Done, and the store carries the mode', () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} />)
    fireEvent.click(screen.getByTestId('shared-component-edit-main'))
    expect(useEditorStore.getState().mainEditComponent).toBe('SectionHeading')
    const banner = screen.getByRole('note').textContent ?? ''
    expect(banner).toContain('Editing the main component SectionHeading')
    expect(banner).not.toContain('change this instance only')
    expect(screen.queryByTestId('shared-component-edit-main')).toBeNull()

    fireEvent.click(screen.getByTestId('shared-component-done-main'))
    expect(useEditorStore.getState().mainEditComponent).toBeNull()
    expect(screen.getByTestId('shared-component-edit-main')).toBeTruthy()
  })

  it('the banner belongs to one component: another component\'s elements stay instance-only', () => {
    useEditorStore.setState({ mainEditComponent: 'Footer' })
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} />)
    expect(screen.getByRole('note').textContent).toContain('change this instance only')
  })
})
