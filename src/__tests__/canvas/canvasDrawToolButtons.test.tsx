/**
 * The notch's armed-tool buttons (`CanvasDrawToolButtons`) — the visible door
 * to the rectangle, ellipse and pen tools, which shipped keyboard-only and so
 * were unreachable for anyone who did not know the letters.
 *
 * Pins the contract that keeps the door honest: every button arms EXACTLY the
 * tool its key arms, a second press puts it away the way the key does, the
 * pressed state follows the store (so arming from the keyboard lights the
 * button too), and the group is absent in live view, where no armed surface
 * is mounted to draw on. The draw itself is measured in a real browser by
 * `tests/e2e/canvas-draw-tool-buttons.e2e.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEditorStore } from '@site/store/store'
import { CanvasNotch } from '@site/canvas/CanvasNotch'
import { __resetAssetFavoritesForTests } from '@site/panels/AssetsPanel/assetsPrefs'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import '@modules/base/index'

const originalFetch = globalThis.fetch

beforeEach(() => {
  localStorage.clear()
  __resetAssetFavoritesForTests()
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ value: null }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  useEditorStore.setState({ canvasTool: 'move', canvasView: 'design' })
  useEditorStore.getState().createSite('Draw tools')
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  useEditorStore.setState({ canvasTool: 'move', canvasView: 'design' })
})

const TOOLS = [
  { tool: 'rectangle', commandId: 'tools.rectangle' },
  { tool: 'ellipse', commandId: 'tools.ellipse' },
  { tool: 'pen', commandId: 'tools.pen' },
] as const

describe('CanvasDrawToolButtons', () => {
  it('shows a rectangle, an ellipse and a pen button in the notch, each naming its key', () => {
    render(<CanvasNotch />)
    for (const { tool, commandId } of TOOLS) {
      const button = screen.getByTestId(`canvas-draw-tool-${tool}`)
      expect(button.getAttribute('aria-keyshortcuts')).toBe(getKeybindingForCommand(commandId)!.ariaKeyshortcuts!)
      expect(button.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('a click arms the same tool the key arms, and a second click puts it away', async () => {
    const user = userEvent.setup()
    render(<CanvasNotch />)
    for (const { tool } of TOOLS) {
      const button = screen.getByTestId(`canvas-draw-tool-${tool}`)
      await user.click(button)
      expect(useEditorStore.getState().canvasTool).toBe(tool)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      await user.click(button)
      expect(useEditorStore.getState().canvasTool).toBe('move')
      expect(button.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('switches straight from one armed tool to another', async () => {
    const user = userEvent.setup()
    render(<CanvasNotch />)
    await user.click(screen.getByTestId('canvas-draw-tool-rectangle'))
    await user.click(screen.getByTestId('canvas-draw-tool-pen'))
    expect(useEditorStore.getState().canvasTool).toBe('pen')
    expect(screen.getByTestId('canvas-draw-tool-rectangle').getAttribute('aria-pressed')).toBe('false')
  })

  it('lights the button when the tool is armed from the keyboard', () => {
    render(<CanvasNotch />)
    act(() => useEditorStore.getState().setCanvasTool('pen'))
    expect(screen.getByTestId('canvas-draw-tool-pen').getAttribute('aria-pressed')).toBe('true')
  })

  it('does not take focus on press, so a held Space cannot click the tool away', () => {
    render(<CanvasNotch />)
    const button = screen.getByTestId('canvas-draw-tool-pen')
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  })

  it('is absent in live view, where no armed surface exists to draw on', () => {
    useEditorStore.setState({ canvasView: 'live' })
    render(<CanvasNotch />)
    expect(screen.queryByTestId('canvas-draw-tools')).toBeNull()
  })

  it('is absent from a notch that supplies its own actions', () => {
    render(<CanvasNotch actions={[]} addControl={null} />)
    expect(screen.queryByTestId('canvas-draw-tools')).toBeNull()
  })
})
