import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

const CANVAS_ROOT = new URL('../../admin/pages/site/canvas/CanvasRoot.tsx', import.meta.url)
const CANVAS_NOTCH = new URL('../../admin/pages/site/canvas/CanvasNotch.tsx', import.meta.url)
const CANVAS_NOTCH_CSS = new URL('../../admin/pages/site/canvas/CanvasNotch.module.css', import.meta.url)
const CANVAS_MODE_TOGGLE_CSS = new URL(
  '../../admin/pages/site/canvas/CanvasModeToggle.module.css',
  import.meta.url,
)
const SELECTION_OVERLAY_CSS = new URL(
  '../../admin/pages/site/canvas/BreakpointSelectionOverlay.module.css',
  import.meta.url,
)
const TOOLBAR = new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url)
const ADD_PAGE_PICKER = new URL(
  '../../admin/pages/site/canvas/BoardFramesLayer/AddPagePicker.tsx',
  import.meta.url,
)

function cssRule(css: string, selector: string): string {
  return css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[\\s\\S]*?\\}`))?.[0] ?? ''
}

function zIndexForRule(rule: string): number {
  const value = rule.match(/z-index:\s*(\d+)/)?.[1]
  if (!value) throw new Error(`Expected z-index in CSS rule:\n${rule}`)
  return Number(value)
}

describe('CanvasNotch', () => {
  it('is rendered by CanvasRoot as fixed canvas chrome', () => {
    const src = readFileSync(CANVAS_ROOT, 'utf-8')

    expect(src).toContain('CanvasNotch')
    expect(src).toContain('<CanvasNotch')
    expect(src).toContain('floatingControl=')
  })

  it('resolves quick insert actions from module inserter favorites', () => {
    const src = readFileSync(CANVAS_NOTCH, 'utf-8')

    // Icons come from each module's own declaration via the shared ModuleIcon
    // resolver — the notch must not duplicate the icon mapping locally.
    expect(src).toContain('ModuleIcon')
    expect(src).not.toContain('pixel-art-icons/icons/checkbox-sharp')
    expect(src).not.toContain('pixel-art-icons/icons/text-start-t')
    expect(src).not.toContain('pixel-art-icons/icons/image-solid')

    expect(src).not.toContain('QUICK_ACTION_MODULE_IDS')
    expect(src).toContain('useModuleInserterPreference')
    expect(src).toContain('DEFAULT_MODULE_INSERTER_FAVORITES')
    expect(src).toContain('resolveInserterRefs')

    expect(src).toContain('canvas-notch-add-btn')
  })

  it('does not draw real side borders through the inverted-corner seam', () => {
    const css = readFileSync(CANVAS_NOTCH_CSS, 'utf-8')

    expect(css).toContain('border: 0')
    expect(css).not.toContain('border: 1px solid')
    expect(css).not.toContain('border-top: 0')
    expect(css).toContain('left: calc(2px - var(--notch-corner))')
    expect(css).toContain('right: calc(2px - var(--notch-corner))')
  })

  it('stacks above selection overlay chrome', () => {
    const notchCss = readFileSync(CANVAS_NOTCH_CSS, 'utf-8')
    const modeToggleCss = readFileSync(CANVAS_MODE_TOGGLE_CSS, 'utf-8')
    const overlayCss = readFileSync(SELECTION_OVERLAY_CSS, 'utf-8')

    const notchZIndex = zIndexForRule(cssRule(notchCss, '.shell'))
    const modeToggleZIndex = zIndexForRule(cssRule(modeToggleCss, '.shell'))
    const selectionToolbarZIndex = zIndexForRule(cssRule(overlayCss, '.selectionToolbar'))
    const treeLadderZIndex = zIndexForRule(cssRule(overlayCss, '.treeLadder'))

    expect(notchZIndex).toBeGreaterThan(selectionToolbarZIndex)
    expect(notchZIndex).toBeGreaterThan(treeLadderZIndex)
    expect(modeToggleZIndex).toBe(notchZIndex)
    expect(modeToggleZIndex).toBeGreaterThan(selectionToolbarZIndex)
    expect(modeToggleZIndex).toBeGreaterThan(treeLadderZIndex)
  })

  it('keeps the Add picker out of the top toolbar', () => {
    const src = readFileSync(TOOLBAR, 'utf-8')

    expect(src).not.toContain('AddPagePicker')
    expect(src).not.toContain('toolbar-add-module-btn')
  })

  it('hosts the Undo/Redo controls so they only appear on the visual editor canvas', () => {
    const src = readFileSync(CANVAS_NOTCH, 'utf-8')
    const toolbar = readFileSync(TOOLBAR, 'utf-8')

    // Undo/Redo lives next to the quick-insert icons, separated by a divider.
    expect(src).toContain('UndoRedoButtons')
    expect(src).toContain('styles.divider')
    expect(src).toContain('showHistoryControls')

    // The shared admin toolbar must NOT render undo/redo — those controls
    // make no sense on Content / Plugins admin pages where there is no
    // editor page tree to mutate.
    expect(toolbar).not.toContain('UndoRedoButtons')
  })

  it('renders the notch Add trigger as an icon-only Add page chip', () => {
    const notch = readFileSync(CANVAS_NOTCH, 'utf-8')
    const picker = readFileSync(ADD_PAGE_PICKER, 'utf-8')

    // The notch "+" is Add page (DS-8) — the same AppGridPlusGlyphIcon it has
    // always worn, now opening the one page picker instead of the deleted
    // module-inserter dialog.
    expect(notch).toContain('AddPagePicker')
    expect(notch).toContain('iconOnly')
    expect(picker).toContain('AppGridPlusGlyphIcon')
    // Icon-only in the notch: the label renders only for the roomy variants
    // (the board empty state, where the button carries its text).
    expect(picker).toContain('{!iconOnly && <span>{label}</span>}')
    expect(picker).toContain("label = 'Add page'")
  })
})
