/**
 * P5-C (DET-5) — the Detach verb's surfaces reach ONE action. The right-click
 * menu (the Layers panel's, which the canvas's menu renders too) and ⌘⌥B /
 * Ctrl+Alt+B, pressed through the one editor key dispatcher, each call the
 * store's `detachInstances` with the selection — nothing else — and the menu
 * shows the item only when every target is a component instance.
 *
 * The action itself (confirm, undo, refusal, selection) is
 * `instanceActions.test.ts`; here it is a spy.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LayerNodeContextMenu } from '@site/panels/DomPanel/LayerNodeContextMenu'
import { useEditorStore } from '@site/store/store'
import { useEditorKeyDispatcher } from '@site/canvas/useEditorKeyDispatcher'
import { useCanvasLayerCommandKeys } from '@site/canvas/useCanvasLayerCommandKeys'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const noop = () => {}
const detachInstances = mock((_nodeIds: readonly string[]) => Promise.resolve('detached' as const))
const realDetachInstances = useEditorStore.getState().detachInstances

function instance(id: string, source: 'local' | 'package' = 'local') {
  return makeNode({ id, moduleId: 'studio.instance', label: 'Card', props: { componentName: 'Card', source, sourceFile: 'components/Card.tsx', callSiteProps: {} } })
}

function seed(selected: string[]) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b', 'pkg', 'text'] }),
      a: instance('a'),
      b: instance('b'),
      pkg: instance('pkg', 'package'),
      text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Hi', tag: 'p' } }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    selectedNodeId: selected.at(-1) ?? null,
    selectedNodeIds: selected,
    selectedFrameIds: [],
    activeInlineEdit: null,
    detachInstances,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function menu(nodeId: string) {
  return render(
    <LayerNodeContextMenu
      x={10}
      y={10}
      nodeId={nodeId}
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

function Keys() {
  useEditorKeyDispatcher()
  useCanvasLayerCommandKeys(true, false)
  return null
}

function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => detachInstances.mockClear())
afterEach(() => {
  cleanup()
  useEditorStore.setState({ detachInstances: realDetachInstances })
  document.body.innerHTML = ''
})

describe('the layer menu (both the Layers panel\'s and the canvas\'s)', () => {
  it('offers "Detach instance" with its ⌘⌥B key, and runs the one action on the right-clicked instance', () => {
    seed(['a'])
    menu('a')
    const item = screen.getByTestId('layer-menu-detach-instance')
    expect(item.textContent).toContain('Detach instance')
    expect([...item.querySelectorAll('kbd')].map((kbd) => kbd.textContent).join('')).toBe(
      formatShortcut(getKeybindingForCommand('layers.detachInstance')!.shortcut).replaceAll(' ', ''),
    )
    fireEvent.click(item)
    expect(detachInstances).toHaveBeenCalledTimes(1)
    expect(detachInstances).toHaveBeenCalledWith(['a'])
  })

  it('a multi-selection of instances is one call with every one of them', () => {
    seed(['a', 'b'])
    menu('b')
    const item = screen.getByTestId('layer-menu-detach-instance')
    expect(item.textContent).toContain('Detach instances')
    fireEvent.click(item)
    expect(detachInstances).toHaveBeenCalledWith(['a', 'b'])
  })

  it('is not offered when anything targeted is not an instance', () => {
    seed(['a', 'text'])
    menu('text')
    expect(screen.queryByTestId('layer-menu-detach-instance')).toBeNull()
  })

  it('is disabled, with the reason, for a package instance', () => {
    seed(['pkg'])
    menu('pkg')
    const item = screen.getByTestId('layer-menu-detach-instance') as HTMLButtonElement
    expect(item.disabled || item.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(item)
    expect(detachInstances).not.toHaveBeenCalled()
  })
})

describe('⌘⌥B / Ctrl+Alt+B', () => {
  it('is matched on the physical key (⌥B arrives as "∫" on a Mac) and rejects a chord with ⇧', () => {
    const binding = getKeybindingForCommand('layers.detachInstance')!
    expect(binding.match({ key: '∫', code: 'KeyB', altKey: true, metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true)
    expect(binding.match({ key: 'b', code: 'KeyB', altKey: true, metaKey: false, ctrlKey: true, shiftKey: false })).toBe(true)
    expect(binding.match({ key: 'B', code: 'KeyB', altKey: true, metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false)
    expect(binding.match({ key: 'b', code: 'KeyB', altKey: false, metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false)
  })

  it('runs the one action on the whole selection', async () => {
    seed(['a', 'b'])
    render(<Keys />)
    let prevented = false
    await act(async () => {
      prevented = press({ key: '∫', code: 'KeyB', metaKey: true, altKey: true })
    })
    expect(prevented).toBe(true)
    expect(detachInstances).toHaveBeenCalledTimes(1)
    expect(detachInstances).toHaveBeenCalledWith(['a', 'b'])
  })
})
