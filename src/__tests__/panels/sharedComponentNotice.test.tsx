/**
 * P3-C (WB-6) — `SharedComponentNotice` must not claim a text edit lands on
 * every instance when the text is written at the call site.
 *
 * `<SectionHeading title="Weeknight dinners"/>` renders `<h2>{title}</h2>`.
 * The `<h2>` is inlined out of `SectionHeading.tsx`, so its classes and styles
 * DO write the component file and reach every instance — the notice says so.
 * Its text does not: it is the call site's own literal, and a text edit
 * rewrites that one attribute. The notice names where.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { SharedComponentNotice } from '@site/panels/PropertiesPanel/SharedComponentNotice'

afterEach(cleanup)

const NODE_ID = 'pages/Recipes.tsx:10:7~components/SectionHeading.tsx:5:7'

describe('SharedComponentNotice', () => {
  it('names the call site when the text is written there', () => {
    render(
      <SharedComponentNotice
        componentName="SectionHeading"
        nodeId={NODE_ID}
        textOrigin={{ rel: 'pages/Recipes.tsx', line: 10 }}
      />,
    )
    const text = screen.getByRole('note').textContent ?? ''
    expect(text).toContain('Part of SectionHeading')
    expect(text).toContain('a text edit is written to pages/Recipes.tsx:10 instead')
  })

  it('says nothing extra when the text lives in the component itself, or there is none', () => {
    render(
      <SharedComponentNotice
        componentName="SectionHeading"
        nodeId={NODE_ID}
        textOrigin={{ rel: 'components/SectionHeading.tsx', line: 5 }}
      />,
    )
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
    cleanup()
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} />)
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
  })
})
