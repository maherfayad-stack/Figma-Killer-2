/**
 * CanvasDrawToolButtons — the notch's armed-tool group: Rectangle (R),
 * Ellipse (O) and Pen (P).
 *
 * P5-E shipped the armed draw tools (OD-5) and P5-D the pen with NO visible
 * control at all: the letter keys were the only way in, so an author who did
 * not already know them had no access to shape or vector drawing whatsoever —
 * the owner's "I no longer have any access to the SVG draw tools". These
 * buttons are that missing entry point. They are the SAME tools the keys arm:
 * each button writes `canvasTool` exactly as its key does
 * (`useCanvasToolShortcuts`), toggles off on a second press exactly as the key
 * does, and reads its label and shortcut back out of the keybinding registry,
 * so the button and the key cannot drift apart.
 *
 * Why only these three. Text and Frame are armed tools too (T, F), but the
 * notch already carries a Text and a Div button beside this group — the
 * immediate-insert primitives, whose tooltips name T and F — and a second pair
 * of identical glyphs one slot away would be two answers to one question.
 * Rectangle, Ellipse and Pen had no button of any kind.
 *
 * Design view only, like the surface these tools arm: `CanvasRoot` mounts
 * `CanvasArmedToolLayer` only when the canvas is not live, so a button in live
 * view would arm a tool that has nowhere to draw.
 *
 * Focus. A press must NOT move focus onto the button: Space is the pan key,
 * and releasing it over a focused button is a native click — holding Space to
 * pan with the pen armed would silently put the pen away. `onMouseDown`'s
 * `preventDefault` keeps focus where it was; keyboard users still reach the
 * buttons with Tab, and every tool keeps its letter.
 */
import type { MouseEvent } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import { getKeybindingForCommand, shortcutLabelFor } from '@admin/spotlight/keybindings'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { EllipseGlyphIcon, PenGlyphIcon, RectangleGlyphIcon } from '@ui/components/ElementIcons'
import { cn } from '@ui/cn'
import type { ArmedTool } from './canvasDrawTool'
import styles from './CanvasNotch.module.css'

interface DrawToolButtonSpec {
  tool: ArmedTool
  commandId: string
  label: string
  icon: IconComponent
}

const DRAW_TOOL_BUTTONS: readonly DrawToolButtonSpec[] = [
  { tool: 'rectangle', commandId: 'tools.rectangle', label: 'Rectangle', icon: RectangleGlyphIcon },
  { tool: 'ellipse', commandId: 'tools.ellipse', label: 'Ellipse', icon: EllipseGlyphIcon },
  { tool: 'pen', commandId: 'tools.pen', label: 'Pen', icon: PenGlyphIcon },
]

function keepFocus(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault()
}

export function CanvasDrawToolButtons() {
  const canvasTool = useEditorStore((s) => s.canvasTool)
  const isLive = useEditorStore((s) => s.canvasView === 'live')
  const setCanvasTool = useEditorStore((s) => s.setCanvasTool)

  if (isLive) return null

  // The group brings its own trailing divider, so live view (which renders
  // nothing here) does not leave an orphaned rule in the notch.
  return (
    <>
      <div role="group" aria-label="Draw tools" className={styles.toolGroup} data-testid="canvas-draw-tools">
        {DRAW_TOOL_BUTTONS.map(({ tool, commandId, label, icon: ToolIcon }) => {
          const armed = canvasTool === tool
          const binding = getKeybindingForCommand(commandId)
          return (
            <Button
              key={tool}
              variant="ghost"
              size="sm"
              iconOnly
              pressed={armed}
              className={cn(styles.quickButton, styles.toolButton)}
              aria-label={`${label} tool`}
              aria-keyshortcuts={binding?.ariaKeyshortcuts}
              tooltip={binding?.displayName ?? `${label} tool`}
              tooltipShortcut={shortcutLabelFor(commandId)}
              data-testid={`canvas-draw-tool-${tool}`}
              onMouseDown={keepFocus}
              onClick={() => setCanvasTool(armed ? 'move' : tool)}
            >
              <ToolIcon size={14} aria-hidden="true" />
            </Button>
          )
        })}
      </div>
      <div aria-hidden="true" className={styles.divider} />
    </>
  )
}
