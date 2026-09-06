/**
 * ZoomControls — toolbar controls for canvas zoom.
 *
 *   [Zoom -] [% ▾] [Zoom +] [Fit]
 *
 * Zooming +/− anchors around the canvas viewport center so the visible content
 * scales around the middle of the screen instead of the document's top-left.
 *
 * The `%` readout is a MENU trigger (viewport-01): 50 / 100 / 200 / Fit /
 * Fill / Zoom to selection. It used to be a click-to-reset-to-100% button,
 * which meant the only way to reach fit-to-screen or zoom-to-selection was to
 * already know `⇧1` / `⇧2`.
 *
 * Live mode: the single real-size frame always renders at 100%, so the
 * controls show 100% and are disabled with the reason in their tooltip —
 * never an interactive control that silently does nothing. (Wheel/keyboard
 * zoom is already gated off in live mode by useCanvas's `enabled` flag.)
 *
 * Performance: subscribes only to `zoom`, `canvasView`, the zoom actions, the
 * published viewport commands, and whether anything is selected — no
 * re-render when other canvas state changes.
 *
 * Keyboard shortcuts (handled in useCanvas via the keybindings registry,
 * documented here for screen readers):
 *   +/= → zoom in
 *   -   → zoom out
 *   Cmd/Ctrl+0 (`canvas.zoomReset`) → reset to 100%
 *   Shift+1 (`canvas.zoomToFit`) → zoom to fit every visible frame
 *   Shift+2 (`canvas.zoomToSelection`) → zoom to the current selection
 *
 * ## How the fit gestures reach this component
 *
 * They no longer don't. This component renders in the toolbar, which
 * `AdminCanvasLayout` paints eagerly ABOVE the lazily-mounted editor body that
 * contains `CanvasRoot` — there is no shared provider to move either side
 * into, and `CanvasViewportActionsContext`'s value is built from refs that
 * only exist once the canvas mounts. Instead, `CanvasRoot` publishes its own
 * DOM-measuring gestures to the editor store as `canvasViewportCommands`, and
 * this component calls them the same way it already calls `zoomIn`/`zoomOut`.
 * `null` (no canvas mounted / live mode) disables the Fit control rather than
 * letting it no-op. Full rationale: `canvas/canvasViewportCommands.ts`.
 */

import { useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { ArrowsScaleIcon } from 'pixel-art-icons/icons/arrows-scale'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import styles from './Toolbar.module.css'

/**
 * Resolve the canvas viewport center in canvas-local coordinates.
 * Returns `null` if the canvas root isn't mounted (e.g. before first render).
 *
 * The canvas root is queried by data-testid because ZoomControls lives in the
 * toolbar (a sibling of the canvas), not inside CanvasRoot — passing a ref
 * would require threading it through several layers of layout components for
 * a one-off geometry lookup at click time.
 */
function getCanvasCenter(): { x: number; y: number } | null {
  const el = document.querySelector('[data-testid="canvas-root"]')
  if (!(el instanceof HTMLElement)) return null
  const rect = el.getBoundingClientRect()
  return { x: rect.width / 2, y: rect.height / 2 }
}

const LIVE_ZOOM_REASON = 'Live mode always shows 100% zoom.'

/** Fixed zoom levels offered by the % menu, as multipliers. */
const ZOOM_PRESETS = [0.5, 1, 2] as const

/**
 * Shortcut labels come from the registry, never hand-typed — that's the rule
 * `keybindings-registry-single-source.test.ts` enforces, and it is why these
 * read `⇧1` on macOS and `Shift+1` elsewhere without this file knowing.
 */
const FIT_BINDING = getKeybindingForCommand('canvas.zoomToFit')
const RESET_BINDING = getKeybindingForCommand('canvas.zoomReset')
const SELECTION_BINDING = getKeybindingForCommand('canvas.zoomToSelection')

export function ZoomControls() {
  // Subscribe only to zoom + view — no re-render when other canvas state changes
  const zoom = useEditorStore((s) => s.zoom)
  const isLive = useEditorStore((s) => s.canvasView === 'live')
  const zoomIn = useEditorStore((s) => s.zoomIn)
  const zoomOut = useEditorStore((s) => s.zoomOut)
  const zoomTo = useEditorStore((s) => s.zoomTo)
  const viewportCommands = useEditorStore((s) => s.canvasViewportCommands)
  // A boolean, not the selection array — this must not re-render the toolbar
  // on every selection change, only when "is anything selected" flips.
  const hasSelection = useEditorStore((s) => s.selectedNodeIds.length > 0)

  const [menuOpen, setMenuOpen] = useState(false)
  const pctRef = useRef<HTMLButtonElement>(null)

  const handleZoomIn = () => {
    const center = getCanvasCenter()
    if (center) zoomIn(center.x, center.y)
    else zoomIn()
  }

  const handleZoomOut = () => {
    const center = getCanvasCenter()
    if (center) zoomOut(center.x, center.y)
    else zoomOut()
  }

  const applyPreset = (level: number) => {
    const center = getCanvasCenter()
    // Anchoring on the viewport center keeps whatever the author is looking at
    // in place; without an origin `zoomTo` pivots on the document's top-left.
    zoomTo(level, center?.x ?? 0, center?.y ?? 0)
  }

  // The live frame renders real-size regardless of the stored design-canvas
  // zoom, which is preserved for the return to design view.
  const pct = isLive ? 100 : Math.round(zoom * 100)
  // No mounted design canvas = nothing to measure. Disabled with a reason
  // beats a control that silently does nothing.
  const canFit = !isLive && viewportCommands !== null
  const fitReason = isLive ? LIVE_ZOOM_REASON : 'The canvas is still loading.'

  return (
    <div
      role="group"
      aria-label="Canvas navigation"
      data-testid="toolbar-zoom-controls"
      className={styles.zoomGroup}
    >
      {/* Zoom out */}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Zoom out"
        aria-keyshortcuts="-"
        tooltip={isLive ? LIVE_ZOOM_REASON : 'Zoom out (−)'}
        disabled={isLive}
        onClick={handleZoomOut}
      >
        <MinusIcon size={14} />
      </Button>

      {/* Zoom % display — opens the zoom menu */}
      <Button
        ref={pctRef}
        variant="ghost"
        size="sm"
        aria-label={isLive ? LIVE_ZOOM_REASON : `Current zoom ${pct}%. Open zoom menu.`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        tooltip={isLive ? LIVE_ZOOM_REASON : 'Zoom menu'}
        disabled={isLive}
        onClick={() => setMenuOpen((open) => !open)}
        numeric
        className={styles.zoomPct}
        data-testid="toolbar-zoom-menu-trigger"
      >
        {pct}%
      </Button>

      {menuOpen && (
        <ContextMenu
          anchorRef={pctRef}
          triggerRef={pctRef}
          align="end"
          side="bottom"
          offset={6}
          minWidth={200}
          ariaLabel="Zoom"
          onClose={() => setMenuOpen(false)}
        >
          {ZOOM_PRESETS.map((level) => (
            <ContextMenuItem
              key={level}
              selected={pct === Math.round(level * 100)}
              // 100% is also Cmd/Ctrl+0 — surface that on the row itself so
              // the menu teaches the shortcut instead of hiding it.
              tooltip={level === 1 && RESET_BINDING ? formatShortcut(RESET_BINDING.shortcut) : undefined}
              onClick={() => {
                setMenuOpen(false)
                applyPreset(level)
              }}
            >
              {`${Math.round(level * 100)}%`}
            </ContextMenuItem>
          ))}

          <ContextMenuSeparator />

          <ContextMenuItem
            disabled={!canFit}
            tooltip={FIT_BINDING ? formatShortcut(FIT_BINDING.shortcut) : undefined}
            onClick={() => {
              setMenuOpen(false)
              viewportCommands?.zoomToFit()
            }}
          >
            Zoom to fit
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canFit}
            onClick={() => {
              setMenuOpen(false)
              viewportCommands?.zoomToFill()
            }}
          >
            Zoom to fill
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canFit || !hasSelection}
            tooltip={
              !hasSelection
                ? 'Select a layer first.'
                : SELECTION_BINDING
                  ? formatShortcut(SELECTION_BINDING.shortcut)
                  : undefined
            }
            onClick={() => {
              setMenuOpen(false)
              viewportCommands?.zoomToSelection()
            }}
          >
            Zoom to selection
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Zoom in */}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Zoom in"
        aria-keyshortcuts="="
        tooltip={isLive ? LIVE_ZOOM_REASON : 'Zoom in (+)'}
        disabled={isLive}
        onClick={handleZoomIn}
      >
        <PlusIcon size={14} />
      </Button>

      {/* Zoom to fit — the one fit gesture that earns its own always-visible
          control; fill and zoom-to-selection live in the menu above. */}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Zoom to fit"
        aria-keyshortcuts={FIT_BINDING?.ariaKeyshortcuts}
        tooltip={
          canFit
            ? `Zoom to fit${FIT_BINDING ? ` (${formatShortcut(FIT_BINDING.shortcut)})` : ''}`
            : fitReason
        }
        disabled={!canFit}
        onClick={() => viewportCommands?.zoomToFit()}
        data-testid="toolbar-zoom-fit-btn"
      >
        <ArrowsScaleIcon size={14} />
      </Button>
    </div>
  )
}
