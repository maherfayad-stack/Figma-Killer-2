/**
 * G-10 - the Import HTML dialog on a board written in real files. It used to
 * show the whole-import refusal inline; now Insert writes the HTML as JSX (and
 * its styles) and closes. A refusal that remains - markup with nothing to place
 * - stays inline in the dialog, where the user is looking.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImportHtmlModal } from '@admin/modals/ImportHtml'
import { useEditorStore } from '@site/store/store'
import { resetStructuralCommitQueue } from '@site/studio/structuralCommitQueue'
import { __resetToastBusForTests } from '@ui/components/Toast/toastBus'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const MAIN = 'pages/Menu.tsx:4:5'
let saves: { edits: Record<string, unknown>[] }[]
let realFetch: typeof globalThis.fetch

function openOnStudioBoard(prefill: string): void {
  useEditorStore.setState({
    site: makeSite({
      pages: [makePage({ id: 'menu', rootNodeId: MAIN, nodes: { [MAIN]: makeNode({ id: MAIN, moduleId: 'base.container', props: { tag: 'main' }, children: [] }) } })],
    }),
    activePageId: 'menu',
    activeDocument: { kind: 'page', pageId: 'menu' },
    importHtmlModalOpen: true,
    importHtmlModalParentId: MAIN,
    importHtmlModalPrefill: prefill,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  resetStructuralCommitQueue()
  __resetToastBusForTests()
  saves = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.includes('/studio/save')) {
      saves.push({ edits: (typeof init?.body === 'string' ? JSON.parse(init.body) : {}).edits ?? [] })
      return new Response(JSON.stringify({ ok: true, written: 0, skipped: 0, shifted: false, sharedComponents: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, narrow: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  resetStructuralCommitQueue()
})

describe('ImportHtmlModal on a board written in real files', () => {
  it('Insert writes the HTML as one JSX insert, with its CSS, and closes the dialog', async () => {
    openOnStudioBoard('<style>.dish { color: tomato }</style><ul class="dish"><li>Soup</li></ul>')
    render(<ImportHtmlModal />)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.edits).toEqual([
      expect.objectContaining({
        kind: 'insert',
        nodeId: MAIN,
        name: 'ul',
        props: { className: 'dish' },
        children: [{ name: 'li', children: 'Soup' }],
        pastedHtml: { css: '.dish { color: tomato }' },
      }),
    ])
    expect(useEditorStore.getState().importHtmlModalOpen).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
