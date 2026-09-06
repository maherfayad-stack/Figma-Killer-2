import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Button } from '@ui/components/Button'
import { InspectorPopover } from './InspectorPopover'

afterEach(cleanup)

function rect(r: Partial<DOMRect>): DOMRect {
  return {
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}), ...r,
  } as DOMRect
}

/**
 * Stubs `getBoundingClientRect` so the trigger sits well inside a generous
 * viewport (plenty of room on every side) and the popover reports a small,
 * fixed size. Good enough to exercise open/close/focus/dismiss behaviour
 * without caring about the exact flip math (that's `useAnchoredFloating`'s
 * job, exercised via `ContextMenu`'s own tests, which share the hook).
 */
function stubLayout({
  anchorRect,
  popoverRect,
}: {
  anchorRect?: Partial<DOMRect>
  popoverRect?: Partial<DOMRect>
} = {}) {
  const realRect = HTMLElement.prototype.getBoundingClientRect
  const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const realInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const realRO = globalThis.ResizeObserver

  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })

  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute('role') === 'dialog') {
      return rect({ top: 0, left: 0, right: 248, bottom: 200, width: 248, height: 200, ...popoverRect })
    }
    if ((this as HTMLElement).dataset.anchor === 'true') {
      return rect({ top: 400, bottom: 420, left: 700, right: 780, width: 80, height: 20, ...anchorRect })
    }
    return realRect.call(this)
  }

  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

  return function restore() {
    HTMLElement.prototype.getBoundingClientRect = realRect
    globalThis.ResizeObserver = realRO
    if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
    if (realInnerWidth) Object.defineProperty(window, 'innerWidth', realInnerWidth)
  }
}

function Harness({
  onClose,
  title = 'Layout settings',
  id = 'layout-settings',
  side,
}: {
  onClose: () => void
  title?: string
  id?: string
  side?: 'left' | 'right' | 'top' | 'bottom'
}) {
  const [open, setOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={triggerRef} data-anchor="true" type="button">
        Open settings
      </button>
      <button type="button">Elsewhere</button>
      {open && (
        <InspectorPopover
          id={id}
          anchorRef={triggerRef}
          title={title}
          side={side}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <input type="text" defaultValue="" aria-label="First field" />
          <input type="text" defaultValue="" aria-label="Second field" />
        </InspectorPopover>
      )}
    </>
  )
}

describe('InspectorPopover', () => {
  it('renders a dialog with data-field-skin="inspector" on the root', () => {
    const restore = stubLayout()
    try {
      render(<Harness onClose={() => {}} />)
      const dialog = screen.getByRole('dialog', { name: /layout settings/i })
      expect(dialog.getAttribute('data-field-skin')).toBe('inspector')
      expect(document.body.contains(dialog)).toBe(true)
    } finally {
      restore()
    }
  })

  it('moves focus into the first focusable control on open and restores it to the trigger on close', async () => {
    const restore = stubLayout()
    try {
      render(<Harness onClose={() => {}} />)
      const trigger = screen.getByRole('button', { name: /open settings/i })

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText('First field'))
      })

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull()
      })
      // Focus restore is deferred one extra frame — see InspectorPopover.tsx's
      // close-cleanup doc comment — so assert via waitFor, not a bare expect.
      await waitFor(() => {
        expect(document.activeElement).toBe(trigger)
      })
    } finally {
      restore()
    }
  })

  it('restores focus to a real Button trigger whose Tooltip wrapper swaps its DOM node when aria-expanded flips off', async () => {
    // Regression: `Button`'s Tooltip wrapper renders a bare <button> while
    // `aria-expanded` is true (Tooltip.tsx: `if (disabled) return children`)
    // and mounts a wholly different element type (`TooltipInner`, wrapping a
    // freshly cloned <button>) the instant it flips back to false — which is
    // exactly the transition that happens when this popover closes. A naive
    // synchronous `anchorRef.current?.focus()` in the close cleanup can
    // target the outgoing node. This must land focus on whichever <button>
    // is actually in the DOM afterward, found by a FRESH query (not the
    // stale pre-close reference, which may point at a node React discarded).
    function RealTriggerHarness() {
      const [open, setOpen] = useState(true)
      const triggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Button
            ref={triggerRef}
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Layout settings"
            aria-expanded={open}
            tooltip="Layout settings"
            onClick={() => setOpen(true)}
          />
          {open && (
            <InspectorPopover
              id="layout-settings"
              anchorRef={triggerRef}
              title="Layout settings"
              onClose={() => setOpen(false)}
            >
              <input type="text" aria-label="Gap" defaultValue="" />
            </InspectorPopover>
          )}
        </>
      )
    }

    const restore = stubLayout()
    try {
      render(<RealTriggerHarness />)
      await screen.findByRole('dialog')

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      await waitFor(() => {
        const currentTrigger = screen.getByRole('button', { name: /layout settings/i })
        expect(document.activeElement).toBe(currentTrigger)
      })
    } finally {
      restore()
    }
  })

  it('traps Tab focus within the popover', async () => {
    const restore = stubLayout()
    try {
      render(<Harness onClose={() => {}} />)
      const dialog = await screen.findByRole('dialog')
      const first = screen.getByLabelText('First field')
      const second = screen.getByLabelText('Second field')
      const closeButton = screen.getByRole('button', { name: /close/i })

      await waitFor(() => expect(document.activeElement).toBe(first))

      second.focus()
      fireEvent.keyDown(dialog, { key: 'Tab' })
      expect(document.activeElement).toBe(closeButton)

      closeButton.focus()
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(second)
    } finally {
      restore()
    }
  })

  it('closes on Escape', async () => {
    const restore = stubLayout()
    const onClose = mock(() => {})
    try {
      render(<Harness onClose={onClose} />)
      const dialog = await screen.findByRole('dialog')
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('dismisses on an outside pointer down', async () => {
    const restore = stubLayout()
    const onClose = mock(() => {})
    try {
      render(<Harness onClose={onClose} />)
      await screen.findByRole('dialog')
      fireEvent.mouseDown(screen.getByRole('button', { name: /elsewhere/i }))
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('does not close when the trigger is clicked again — the caller toggles it', async () => {
    const restore = stubLayout()
    const onClose = mock(() => {})
    try {
      render(<Harness onClose={onClose} />)
      await screen.findByRole('dialog')
      fireEvent.mouseDown(screen.getByRole('button', { name: /open settings/i }))
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('defaults to the left side and flips when there is no room on the left', () => {
    // Trigger pinned to the LEFT edge of the viewport — no room to open left.
    const restore = stubLayout({ anchorRect: { top: 400, bottom: 420, left: 10, right: 90, width: 80 } })
    try {
      render(<Harness onClose={() => {}} />)
      const dialog = screen.getByRole('dialog')
      // Popover width is 248 by default; opening left of a trigger at
      // left=10 would go negative, so it must flip to a side that fits.
      const x = Number.parseFloat(dialog.style.getPropertyValue('--inspector-popover-x'))
      expect(x).toBeGreaterThanOrEqual(0)
      expect(dialog.style.getPropertyValue('--inspector-popover-x')).not.toBe('')
    } finally {
      restore()
    }
  })

  it('opens to the left of a trigger with room on every side', () => {
    const restore = stubLayout()
    try {
      render(<Harness onClose={() => {}} />)
      const dialog = screen.getByRole('dialog')
      // Anchor left edge is 700; a 248px-wide popover with an 8px offset
      // opening left should sit at 700 - 248 - 8 = 444.
      expect(dialog.style.getPropertyValue('--inspector-popover-x')).toBe('444px')
    } finally {
      restore()
    }
  })

  it('does not close the parent popover when a nested popover is clicked', async () => {
    const restore = stubLayout()
    const onCloseParent = mock(() => {})
    const onCloseChild = mock(() => {})

    function NestedHarness() {
      const parentTriggerRef = useRef<HTMLButtonElement>(null)
      const childTriggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={parentTriggerRef} data-anchor="true" type="button">
            Open fill
          </button>
          <InspectorPopover id="fill" anchorRef={parentTriggerRef} title="Fill" onClose={onCloseParent}>
            <button ref={childTriggerRef} type="button">
              Open color picker
            </button>
            <InspectorPopover
              id="fill-color"
              anchorRef={childTriggerRef}
              title="Color picker"
              onClose={onCloseChild}
            >
              <input type="text" aria-label="Hex" defaultValue="#000000" />
            </InspectorPopover>
          </InspectorPopover>
        </>
      )
    }

    try {
      render(<NestedHarness />)
      const hexField = await screen.findByLabelText('Hex')
      fireEvent.mouseDown(hexField)
      expect(onCloseParent).not.toHaveBeenCalled()
      expect(onCloseChild).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('remembers the last active tab per id when reopened', async () => {
    const restore = stubLayout()

    function TabbedHarness({ popoverId }: { popoverId: string }) {
      const [open, setOpen] = useState(true)
      const triggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={triggerRef} data-anchor="true" type="button" onClick={() => setOpen(true)}>
            Trigger
          </button>
          {open && (
            <InspectorPopover
              id={popoverId}
              anchorRef={triggerRef}
              title="Type settings"
              onClose={() => setOpen(false)}
              tabs={[
                { value: 'basics', label: 'Basics', content: <div>Basics content</div> },
                { value: 'details', label: 'Details', content: <div>Details content</div> },
              ]}
            />
          )}
        </>
      )
    }

    try {
      render(<TabbedHarness popoverId="type-settings-shared" />)
      await screen.findByRole('dialog')
      fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
      expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')

      // Close (unmounts the popover — the caller owns `open`) then reopen the
      // same id via its trigger.
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.click(screen.getByRole('button', { name: /trigger/i }))

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true')
      })
    } finally {
      restore()
    }
  })

  it('starts a different popover id back at the default tab', async () => {
    const restore = stubLayout()

    function TabbedHarness({ popoverId }: { popoverId: string }) {
      const triggerRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={triggerRef} data-anchor="true" type="button">
            Trigger
          </button>
          <InspectorPopover
            id={popoverId}
            anchorRef={triggerRef}
            title="Type settings"
            onClose={() => {}}
            tabs={[
              { value: 'basics', label: 'Basics', content: <div>Basics content</div> },
              { value: 'details', label: 'Details', content: <div>Details content</div> },
            ]}
          />
        </>
      )
    }

    try {
      render(<TabbedHarness popoverId="type-settings-node-a" />)
      await screen.findByRole('dialog')
      expect(screen.getByRole('tab', { name: 'Basics' }).getAttribute('aria-selected')).toBe('true')
    } finally {
      restore()
    }
  })
})
