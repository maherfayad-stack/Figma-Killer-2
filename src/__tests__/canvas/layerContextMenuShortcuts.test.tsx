/**
 * P5-E — the right-click menu (UX-22, IX-27, IX-26) and tooltips (UX-23).
 *
 *   - every item that has a key shows it, READ FROM THE REGISTRY — so the
 *     menu can never teach a key that does something else;
 *   - the verbs the audit found missing: Group, Lock, Bring to front, Send to
 *     back, flex layout, Align, Copy / Paste style, and on the canvas
 *     "Select layer" (every layer under the pointer);
 *   - a tooltip with a `shortcut` renders it as keycaps after its label.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LayerNodeContextMenu } from '@site/panels/DomPanel/LayerNodeContextMenu'
import { useEditorStore } from '@site/store/store'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { Button } from '@ui/components/Button'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const noop = () => {}

function seed(selected: string[]) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['card', 'title'] }),
      card: makeNode({ id: 'card', moduleId: 'base.container', children: ['inner'], label: 'Card' }),
      inner: makeNode({ id: 'inner', moduleId: 'base.container', label: 'Inner' }),
      title: makeNode({ id: 'title', moduleId: 'base.text', props: { text: 'Hi', tag: 'p' }, label: 'Title' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    selectedNodeId: selected.at(-1) ?? null,
    selectedNodeIds: selected,
    _historyPast: [],
    _historyFuture: [],
  } as Parameters<typeof useEditorStore.setState>[0])
}

function menu(nodeId: string, layerIdsUnderPointer: readonly string[] = []) {
  return render(
    <LayerNodeContextMenu
      x={10}
      y={10}
      nodeId={nodeId}
      layerIdsUnderPointer={layerIdsUnderPointer}
      onClose={noop}
      onDelete={noop}
      onDuplicate={noop}
      onRename={noop}
      onWrapInContainer={noop}
      onCopy={noop}
      onCut={noop}
      onPaste={noop}
    />,
  )
}

const label = (commandId: string) => formatShortcut(getKeybindingForCommand(commandId)!.shortcut)

/** The keycaps an item renders, joined — `<kbd>` per key. */
function keycapsOf(item: HTMLElement): string {
  return [...item.querySelectorAll('kbd')].map((kbd) => kbd.textContent).join('')
}

beforeEach(() => seed(['card']))
afterEach(cleanup)

describe('the layer menu shows each item’s shortcut, from the registry (UX-22)', () => {
  it('Duplicate, Copy, Rename and Delete carry their keys', () => {
    menu('card')
    for (const [name, commandId] of [
      [/^duplicate/i, 'layers.duplicate'],
      [/^copy$/i, 'layers.copy'],
      [/^rename/i, 'layers.rename'],
      [/^delete/i, 'layers.delete'],
    ] as const) {
      const item = screen.getByRole('menuitem', { name })
      expect(keycapsOf(item)).toBe(label(commandId))
    }
  })
})

describe('the verbs the audit found missing (IX-27)', () => {
  it('offers Lock, Bring to front, Send to back, flex layout, Align and Copy style — with keys', () => {
    menu('card')
    for (const [name, commandId] of [
      [/^lock/i, 'layers.toggleLock'],
      [/bring to front/i, 'layers.bringToFront'],
      [/send to back/i, 'layers.sendToBack'],
      [/flex layout/i, 'layers.toggleFlexLayout'],
      [/^copy style/i, 'layers.copyStyle'],
    ] as const) {
      const item = screen.getByRole('menuitem', { name })
      expect(keycapsOf(item)).toBe(label(commandId))
    }
    expect(screen.getByRole('menuitem', { name: /^align/i })).toBeTruthy()
  })

  it('offers Group for several layers, and Ungroup for a container', () => {
    menu('card')
    expect(screen.getByRole('menuitem', { name: /^ungroup/i })).toBeTruthy()
    cleanup()
    seed(['card', 'title'])
    menu('card')
    expect(screen.getByRole('menuitem', { name: /^group/i })).toBeTruthy()
  })

  it('Bring to front makes the layer the last child', () => {
    menu('card')
    fireEvent.click(screen.getByRole('menuitem', { name: /bring to front/i }))
    expect([...useEditorStore.getState().site!.pages[0]!.nodes.root!.children]).toEqual(['title', 'card'])
  })
})

describe('"Select layer" — every layer under the pointer (IX-26)', () => {
  it('lists them by name, innermost first, and picks one', () => {
    menu('card', ['inner', 'card', 'root'])
    const submenuTrigger = screen.getByRole('menuitem', { name: /select layer/i })
    fireEvent.click(submenuTrigger)
    const inner = screen.getByRole('menuitemradio', { name: /inner/i })
    fireEvent.click(inner)
    expect(useEditorStore.getState().selectedNodeId).toBe('inner')
  })

  it('is not offered with nothing to choose between (the Layers panel has no pointer)', () => {
    menu('card')
    expect(screen.queryByRole('menuitem', { name: /select layer/i })).toBeNull()
  })
})

describe('tooltips carry the shortcut as keycaps (UX-23)', () => {
  it('a Button tooltip shows the label, then the keys', async () => {
    render(<Button tooltip="Duplicate" tooltipShortcut={label('layers.duplicate')}>D</Button>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'D' }))
    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('Duplicate')).toBeTruthy()
    expect(keycapsOf(tooltip)).toBe(label('layers.duplicate'))
  })
})
