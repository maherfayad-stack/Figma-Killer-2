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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SharedComponentNotice } from '@site/panels/PropertiesPanel/SharedComponentNotice'
import { registerEditorSave } from '@site/hooks/editorSaveRef'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { setStudioLoadedDir } from '@site/studio/studioWorkspaceDir'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode } from '../fixtures'

afterEach(cleanup)

const NODE_ID = 'pages/Recipes.tsx:10:7~components/SectionHeading.tsx:5:7'
const heading = (props: Record<string, unknown> = { text: 'Weeknight dinners', tag: 'h2' }, codeProps?: string[]) =>
  makeNode({ id: NODE_ID, moduleId: 'base.text', props, ...(codeProps ? { codeProps } : {}) })

describe('SharedComponentNotice', () => {
  it('names the call site when the text is written there', () => {
    render(
      <SharedComponentNotice
        componentName="SectionHeading"
        nodeId={NODE_ID}
        node={heading()}
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
        node={heading()}
        textOrigin={{ rel: 'components/SectionHeading.tsx', line: 5 }}
      />,
    )
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
    cleanup()
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} node={heading()} />)
    expect(screen.getByRole('note').textContent).not.toContain('text edit')
  })
})

describe('SharedComponentNotice — "Make the text a prop" (P5-C, DET-7)', () => {
  const originalFetch = globalThis.fetch
  let posted: { edits: Record<string, unknown>[] }[] = []
  let unregisterSave: (() => void) | null = null

  beforeEach(() => {
    posted = []
    __resetToastBusForTests()
    resetStructuralCommitQueue()
    unregisterSave = registerEditorSave(async () => {})
    setStudioLoadedDir('/tmp/studio-test')
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(init?.body ? JSON.parse(String(init.body)) : { edits: [] })
      return new Response(
        JSON.stringify({ ok: true, written: 0, skipped: 1, shifted: false, sharedComponents: true, refusals: [{ nodeId: NODE_ID, kind: 'expose-prop', reason: 'call-site-spread', message: 'A call site spreads props.' }] }),
        { status: 200 },
      )
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    unregisterSave?.()
    setStudioLoadedDir(null)
    resetStructuralCommitQueue()
  })

  it('offers it for literal text one call site deep, and posts ONE expose-prop edit named after the tag', async () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} node={heading()} />)
    fireEvent.click(screen.getByTestId('shared-component-expose-text'))
    for (let i = 0; i < 50 && posted.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(posted).toHaveLength(1)
    expect(posted[0]!.edits).toEqual([{ kind: 'expose-prop', nodeId: NODE_ID, target: { kind: 'text' }, propName: 'heading' }])
  })

  it('is not offered for text that is a binding, text set at the call site, or an element two call sites deep', () => {
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} node={heading(undefined, ['text'])} />)
    expect(screen.queryByTestId('shared-component-expose-text')).toBeNull()
    cleanup()
    render(<SharedComponentNotice componentName="SectionHeading" nodeId={NODE_ID} node={heading()} textOrigin={{ rel: 'pages/Recipes.tsx', line: 10 }} />)
    expect(screen.queryByTestId('shared-component-expose-text')).toBeNull()
    cleanup()
    const deep = `${NODE_ID}~components/Icon.tsx:2:3`
    render(<SharedComponentNotice componentName="Icon" nodeId={deep} node={makeNode({ id: deep, moduleId: 'base.text', props: { text: 'x' } })} />)
    expect(screen.queryByTestId('shared-component-expose-text')).toBeNull()
  })
})
