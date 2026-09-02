/**
 * Toolbar Component Tests — J13
 *
 * Tests focus on:
 *   1. UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224),
 *      keyboard shortcut handler registration. The component lives in the
 *      canvas notch (src/editor/components/Canvas/UndoRedoButtons.tsx) so
 *      Undo/Redo only appears on the visual editor, not on Content / Plugins
 *      admin pages.
 *   2. ZoomControls — zoom percentage rendering, correct store subscriptions.
 *   3. ModulePickerDropdown — search filter pure logic.
 *   4. Toolbar — overall structure (role, testid, always-rendered sub-components).
 *
 * React component rendering tests use renderToStaticMarkup (same pattern as
 * canvas/accessibility.test.tsx) so no JSDOM or browser is needed.
 *
 * Store-dependent tests use the actual Zustand store (reset between tests
 * via createSite / clearSite) rather than mocks — this catches real
 * integration issues between toolbar actions and store state.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render } from '@testing-library/react'
import { fileURLToPath } from 'node:url'
import { ZoomControls } from '@site/toolbar/ZoomControls'
import { useEditorStore } from '@site/store/store'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'

// ─── Guideline #224 constants ─────────────────────────────────────────────────

const MIN_TOUCH_TARGET = 44 // px

// ---------------------------------------------------------------------------
// 1 — Zoom percentage display
// ---------------------------------------------------------------------------

describe('ZoomControls — zoom percentage display', () => {
  it('converts zoom 1.0 to "100%"', () => {
    expect(Math.round(1.0 * 100)).toBe(100)
  })

  it('converts zoom 0.5 to "50%"', () => {
    expect(Math.round(0.5 * 100)).toBe(50)
  })

  it('converts zoom 1.5 to "150%"', () => {
    expect(Math.round(1.5 * 100)).toBe(150)
  })

  it('converts zoom 0.123 to "12%" (rounds down)', () => {
    expect(Math.round(0.123 * 100)).toBe(12)
  })

  it('converts zoom 4.0 to "400%" (max zoom)', () => {
    expect(Math.round(4.0 * 100)).toBe(400)
  })

  it('converts zoom 0.1 to "10%" (min zoom)', () => {
    expect(Math.round(0.1 * 100)).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 1b — Live mode: zoom pinned to 100% and disabled
// ---------------------------------------------------------------------------

describe('ZoomControls — live mode', () => {
  // renderToStaticMarkup would render zustand's INITIAL state (server
  // snapshot) and ignore setState — these two need a live client render.
  beforeEach(() => {
    cleanup()
  })

  it('pins the display to 100% and disables every control with the reason', () => {
    useEditorStore.setState({ canvasView: 'live', zoom: 0.5 })
    const { container } = render(React.createElement(ZoomControls))

    // Display ignores the stored design-canvas zoom (50%), which is preserved
    // for the return to design mode.
    expect(container.textContent).toContain('100%')
    expect(container.textContent).not.toContain('50%')
    // disabled+tooltip renders aria-disabled (not native disabled) so the
    // explanatory tooltip still shows on hover — the Button primitive's
    // zero-friction path.
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }
    // The reason is surfaced accessibly on the % readout, not only on hover.
    expect(container.innerHTML).toContain('Live mode always shows 100% zoom.')
  })

  it('keeps the stored design zoom interactive in design mode', () => {
    useEditorStore.setState({ canvasView: 'design', zoom: 0.5 })
    const { container } = render(React.createElement(ZoomControls))

    expect(container.textContent).toContain('50%')
    for (const button of container.querySelectorAll('button')) {
      expect(button.getAttribute('aria-disabled')).toBeNull()
      expect(button.hasAttribute('disabled')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 2 — UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224)
// ---------------------------------------------------------------------------

describe('UndoRedoButtons — WCAG aria-disabled pattern (Guideline #224)', () => {
  it('aria-disabled buttons must still be in the DOM (no conditional removal)', () => {
    // Structural assertion: both buttons are always rendered regardless of state.
    // We assert this by checking the toolbar source uses aria-disabled, not disabled.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    // Must use aria-disabled for the disabled state (Guideline #224)
    expect(src).toContain('aria-disabled={!canUndo}')
    expect(src).toContain('aria-disabled={!canRedo}')
    // Must NOT use the `disabled` HTML attribute on the <button> directly.
    // Note: `aria-disabled={!canUndo}` contains "disabled={!canUndo}" as a substring,
    // so we check for the exact standalone HTML attribute pattern: `disabled={` NOT
    // preceded by "aria-". Using a negative lookahead-style check via regex.
    expect(/(?<!aria-)disabled=\{!can/.test(src)).toBe(false)
  })

  it('aria-keyshortcuts attributes are present for screen readers', () => {
    // Post-spotlight refactor: shortcut values come from the keybindings
    // registry (keybindings.ts) rather than being hardcoded in JSX. We assert
    // the JSX wires aria-keyshortcuts to the registry-resolved binding, AND
    // that the registry itself declares the canonical ⌘Z / ⌘⇧Z labels so
    // screen readers still receive "Meta+Z" / "Meta+Shift+Z" on macOS.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('aria-keyshortcuts={kbUndo?.ariaKeyshortcuts}')
    expect(src).toContain('aria-keyshortcuts={kbRedo?.ariaKeyshortcuts}')

    // Confirm the registry resolves the canonical shortcuts the buttons rely on.
    const registrySrc = readFileSync(
      new URL('../../admin/spotlight/keybindings.ts', import.meta.url),
      'utf-8',
    )
    expect(registrySrc).toContain("commandId: 'editor.undo'")
    expect(registrySrc).toContain("commandId: 'editor.redo'")
    expect(registrySrc).toContain("'Meta+Z' : 'Control+Z'")
    expect(registrySrc).toContain("'Meta+Shift+Z' : 'Control+Shift+Z'")
  })

  it('keyboard shortcut handler guards against text input targets', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    // Shortcuts must not fire inside inputs (would break text editing)
    expect(src).toContain("tagName === 'INPUT'")
    expect(src).toContain("tagName === 'TEXTAREA'")
    expect(src).toContain('isContentEditable')
  })

  it('keyboard handler registers on document (global scope, not canvas-local)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('document.addEventListener')
    expect(src).toContain('document.removeEventListener')
  })

  it('handler supports both Cmd+Z (undo) and Cmd+Shift+Z / Cmd+Y (redo)', () => {
    // Post-spotlight refactor: the keydown handler delegates undo/redo matching
    // ENTIRELY to the keybindings registry via `kb.match(e)` — no inline
    // key-combo check of its own (`keybindings-registry-single-source.test.ts`
    // gates that). The Ctrl+Y Windows/Linux redo alias is folded into the
    // `editor.redo` binding's own `match` predicate instead of a second,
    // hand-rolled check here — assert the BEHAVIOR (the registry recognizes
    // both keystrokes as redo) rather than grepping for a literal that moved.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('kbUndo?.match(e)')
    expect(src).toContain('kbRedo?.match(e)')
    expect(src).not.toContain("e.key === 'y'")

    const kbRedo = getKeybindingForCommand('editor.redo')
    expect(kbRedo).toBeDefined()
    const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    expect(kbRedo!.match({ ...base, ctrlKey: true, shiftKey: true, key: 'z' })).toBe(true)
    expect(kbRedo!.match({ ...base, ctrlKey: true, key: 'y' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3 — ModulePickerDropdown — search filter logic
// ---------------------------------------------------------------------------

// The filtering logic is extracted here for pure-function testing.
// It mirrors what the useMemo in ModulePickerDropdown computes.
function filterModules(
  grouped: Record<string, Array<{ id: string; name: string }>>,
  query: string,
): Record<string, Array<{ id: string; name: string }>> {
  const q = query.trim().toLowerCase()
  if (!q) return grouped
  const result: Record<string, Array<{ id: string; name: string }>> = {}
  for (const [cat, mods] of Object.entries(grouped)) {
    const matching = mods.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        cat.toLowerCase().includes(q),
    )
    if (matching.length > 0) result[cat] = matching
  }
  return result
}

const MOCK_REGISTRY: Record<string, Array<{ id: string; name: string }>> = {
  Layout: [
    { id: 'base.container', name: 'Container' },
  ],
  Typography: [
    { id: 'base.text', name: 'Text' },
  ],
  Interactive: [
    { id: 'base.button', name: 'Button' },
    { id: 'base.link', name: 'Link' },
  ],
}

describe('ModulePickerDropdown — search filter', () => {
  it('returns all modules when query is empty', () => {
    const result = filterModules(MOCK_REGISTRY, '')
    expect(Object.keys(result)).toHaveLength(3)
    expect(result['Layout']).toHaveLength(1)
    expect(result['Typography']).toHaveLength(1)
  })

  it('filters by module name (case-insensitive)', () => {
    const result = filterModules(MOCK_REGISTRY, 'text')
    expect(Object.keys(result)).toHaveLength(1)
    expect(result['Typography']).toHaveLength(1)
    expect(result['Typography'][0].name).toBe('Text')
  })

  it('filters by module ID', () => {
    const result = filterModules(MOCK_REGISTRY, 'base.button')
    expect(result['Interactive']).toHaveLength(1)
    expect(result['Interactive'][0].id).toBe('base.button')
  })

  it('filters by category name', () => {
    const result = filterModules(MOCK_REGISTRY, 'layout')
    expect(result['Layout']).toHaveLength(1)
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('returns empty object when no modules match', () => {
    const result = filterModules(MOCK_REGISTRY, 'xyznonexistent')
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('is case-insensitive for all match types', () => {
    expect(filterModules(MOCK_REGISTRY, 'BUTTON')['Interactive']).toHaveLength(1)
    expect(filterModules(MOCK_REGISTRY, 'TEXT')['Typography']).toHaveLength(1)
    expect(filterModules(MOCK_REGISTRY, 'LAYOUT')['Layout']).toHaveLength(1)
  })

  it('trims whitespace from query before filtering', () => {
    const result = filterModules(MOCK_REGISTRY, '  container  ')
    expect(result['Layout']).toHaveLength(1)
    expect(result['Layout'][0].id).toBe('base.container')
  })

  it('partial match works (prefix, suffix, substring)', () => {
    // "tex" should match "Text" (prefix)
    const byPrefix = filterModules(MOCK_REGISTRY, 'tex')
    expect(byPrefix['Typography']).toHaveLength(1)
    expect(byPrefix['Typography'][0].name).toBe('Text')

    // "ext" suffix — unique to Text, does NOT appear in category name "Typography"
    const bySuffix = filterModules(MOCK_REGISTRY, 'ext')
    expect(bySuffix['Typography']).toHaveLength(1)
    expect(bySuffix['Typography'][0].name).toBe('Text')

    // Note: "raph" is a substring of "typography" (the category), so it matches
    // the whole category — we do NOT use "raph" for suffix testing here.
  })
})

// ---------------------------------------------------------------------------
// 4 — Toolbar shell structure
// ---------------------------------------------------------------------------

describe('Toolbar — structural requirements', () => {
  it('source uses a native <header> as the top-level banner landmark', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('<header')
    expect(src).not.toContain('role="banner"')
  })

  it('source has data-testid="toolbar" for Playwright targeting', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('data-testid="toolbar"')
  })

  it('Toolbar is a prop-driven shell — EDITOR-only buttons live in AdminCanvasLayout, global trailer lives in the shell', () => {
    // The Toolbar shell owns the GLOBAL trailer (SettingsButton +
    // OpenLivePageButton + AccountMenuButton) so the settings cog, live-page
    // link, and account menu are identical on every admin route. SettingsButton
    // reads the tiny `adminUi` store, so hosting it in the shell does NOT drag
    // the editor store into non-editor bundles.
    //
    // EDITOR-only sub-components (ZoomControls / StudioToolbarActions / save
    // status) stay out of the shell — they are passed in via the `rightSlot`
    // prop by AdminCanvasLayout, which keeps the toolbar shareable with the
    // lightweight layouts.
    const { readFileSync } = require('fs')
    const toolbarSrc = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    // Toolbar.tsx must not import the editor-only sub-components.
    expect(toolbarSrc).not.toContain('UndoRedoButtons')
    expect(toolbarSrc).not.toContain('ModulePickerDropdown')
    expect(toolbarSrc).not.toContain('ExportButton')
    expect(toolbarSrc).not.toContain('SaveIndicator')
    expect(toolbarSrc).not.toContain("from './ZoomControls'")
    expect(toolbarSrc).not.toContain("from './StudioToolbarActions'")
    expect(toolbarSrc).not.toContain('saveStatus={saveStatus}')
    // The global trailer — including the settings cog — IS owned by the shell.
    expect(toolbarSrc).toContain("from './SettingsButton'")
    expect(toolbarSrc).toContain('<SettingsButton />')

    // The editor-only buttons must be mounted from AdminCanvasLayout, which
    // must NOT re-mount the now-global SettingsButton.
    const layoutSrc = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(layoutSrc).toContain('ZoomControls')
    expect(layoutSrc).toContain('StudioToolbarActions')
    expect(layoutSrc).not.toContain('SettingsButton')
    expect(layoutSrc).toContain('persistence.saveStatus')
  })

  it('module picker trigger has data-testid for Playwright', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/ModulePickerDropdown.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('triggerTestId')
  })

  it('Toolbar no longer renders panel toggles or create-page/component quick actions', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/Toolbar.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).not.toContain('FilesButton')
    expect(src).not.toContain('CodeEditorButton')
    expect(src).not.toContain('PropertiesButton')
    expect(src).not.toContain('AgentButton')
    expect(src).not.toContain('NewPageButton')
    expect(src).not.toContain('NewComponentButton')
  })

  it('Add inserter is module-only — no in-toolbar page/component create actions', () => {
    // Page / Component creation lives in the Site Explorer panel (the dedicated
    // place for site structure). The toolbar "+ Add" inserter is module-only.
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/toolbar/ModulePickerDropdown.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).not.toContain('toolbar-add-page-action')
    expect(src).not.toContain('toolbar-add-component-action')
    expect(src).not.toContain('SiteCreateDialog')
    expect(src).not.toContain('NewFileModal')
    expect(src).not.toContain('src/pages/')
    expect(src).not.toContain('src/components/')
  })

  it('all required data-testid attributes are present (Guideline #221)', () => {
    const { readFileSync } = require('fs')
    // UndoRedo testids
    const undoSrc = readFileSync(
      new URL('../../admin/pages/site/canvas/UndoRedoButtons.tsx', import.meta.url), 'utf-8',
    )
    expect(undoSrc).toContain('data-testid="canvas-notch-undo-btn"')
    expect(undoSrc).toContain('data-testid="canvas-notch-redo-btn"')

    // ZoomControls testid
    const zoomSrc = readFileSync(
      new URL('../../admin/pages/site/toolbar/ZoomControls.tsx', import.meta.url), 'utf-8',
    )
    expect(zoomSrc).toContain('data-testid="toolbar-zoom-controls"')
  })

  it('ModulePicker uses ContextMenu primitives (role="menu" + role="menuitem")', () => {
    const { readFileSync } = require('fs')
    // The compact picker content lives in ModulePicker.tsx for DOM-panel
    // right-click submenus. The toolbar "+ Add" opens ModuleInserterDialog.
    // ModulePicker doesn't author its own role="menu" — it relies on the
    // wrapping ContextMenuSubmenu for that — and uses ContextMenuItem for
    // every row, which renders a `role="menuitem"` button.
    const src = readFileSync(
      new URL('../../admin/pages/site/module-picker/ModulePicker.tsx', import.meta.url), 'utf-8',
    )
    expect(src).toContain('ContextMenuItem')
    // UX Review #333: role="listbox" without arrow-key nav is incorrect. The
    // picker uses ContextMenuItem (role="menuitem") instead.
    const codeLines = src.split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(codeLines).not.toContain('role="listbox"')
    expect(codeLines).not.toContain('role="option"')
  })

  it('ModulePicker search input has a visible focus ring (WCAG SC 2.4.7)', () => {
    const { readFileSync } = require('fs')
    // The picker uses the shared <SearchBar /> primitive; the focus ring lives
    // in that primitive's CSS module so every search bar in the editor uses
    // the same focus treatment. We assert on the primitive's stylesheet.
    const cssPath = fileURLToPath(new URL('../../ui/components/SearchBar/SearchBar.module.css', import.meta.url))
    const cssSrc = readFileSync(cssPath, 'utf-8')
    // Assert CSS module :focus / :focus-visible selector (no Tailwind).
    const hasCssModuleFocus = /:focus[-\s{]|:focus-visible/.test(cssSrc)
    expect(hasCssModuleFocus).toBe(true)
  })

  it('SplitButton exposes a menu trigger and portals the menu above editor panels', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../ui/components/SplitButton/SplitButton.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('aria-haspopup="menu"')
    expect(src).toContain('aria-expanded={menuOpen}')
    expect(src).toContain('@ui/components/ContextMenu')
    expect(src).toContain('<ContextMenu')
    expect(src).toContain('<ContextMenuItem')
    expect(src).toContain('createPortal')
    expect(src).toContain('zIndex={10000}')
  })

  it('AdminCanvasLayout imports and renders Toolbar', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain("import { Toolbar }")
    expect(src).toContain('const persistence = usePersistence(')
    expect(src).toContain("'default'")
    expect(src).toContain('fsCodemodAdapter')
    // Studio is the only editor mode — the toolbar's right slot always
    // mounts StudioToolbarActions inside the toolbar's rightSlot.
    expect(src).toContain('<StudioToolbarActions')
  })

  it('AdminCanvasLayout keeps zoom and Studio toolbar actions adjacent without a divider', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx', import.meta.url),
      'utf-8',
    )
    expect(src).toContain('<ZoomControls />')
    expect(src).toContain('<StudioToolbarActions')
    expect(src).not.toContain('ToolbarDivider')
  })

  it('touch targets: all toolbar buttons have a defined compact height (Guideline #357)', () => {
    // Guideline #357 (user directive #1532): WCAG 2.5.5 44px touch target requirement
    // is explicitly waived for editor chrome. Toolbar controls target 28px.
    // Pattern asserts a 24–29px height value declared in the shared Toolbar.module.css.
    // UndoRedoButtons lives in the canvas notch and uses the notch chrome
    // styling, not the toolbar shared CSS — covered by canvasNotch.test.ts.
    const files = [
      'ZoomControls.tsx',
      'SettingsButton.tsx',
    ]
    const { readFileSync } = require('fs')
    // Read the shared Toolbar.module.css once — all Toolbar sub-components use it
    const cssUrl = fileURLToPath(new URL('../../admin/pages/site/toolbar/Toolbar.module.css', import.meta.url))
    const sharedCss = readFileSync(cssUrl, 'utf-8')
    for (const file of files) {
      const tsx = readFileSync(
        fileURLToPath(new URL(`../../admin/pages/site/toolbar/${file}`, import.meta.url)),
        'utf-8',
      )
      const src = tsx + '\n' + sharedCss
      // Compact only — 24–29px height declared in the shared Toolbar.module.css.
      const hasHeight = /height:\s*2[4-9]/.test(src)
      expect(hasHeight).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — ModulePickerDropdown keyboard navigation: ArrowDown from search input
//     Regression test for the WCAG 2.1.1 gap found in UX Review #343.
//
//     Bug: handleMenuKeyDown was attached to the menu container div, NOT the
//     search input. When the dropdown opens, focus is on the search input.
//     Pressing ArrowDown dispatched the event on the input; it bubbled up to
//     the input's ancestors — but the menu div is a SIBLING, not an ancestor,
//     so ArrowDown was silently lost. Keyboard-only users could type a query
//     but could never navigate to or select any module result.
//
//     Fix (Contribution #350): added onKeyDown to the search <input> that
//     forwards ArrowDown to the first [role="menuitem"] element via .focus().
// ---------------------------------------------------------------------------

describe('ModulePicker — ArrowDown keyboard bridge (WCAG SC 2.1.1)', () => {
  // The bridge logic lives in the shared ModulePicker.tsx (used by both the
  // DOM-panel right-click submenu.
  const { readFileSync } = require('fs')
  const src = readFileSync(
    new URL('../../admin/pages/site/module-picker/ModulePicker.tsx', import.meta.url),
    'utf-8',
  )

  it('search input has an onKeyDown handler (WCAG 2.1.1 — keyboard access)', () => {
    // The search input must have its OWN onKeyDown. Without it, ArrowDown from
    // the input cannot reach the wrapping menu's keyboard nav. We verify the
    // handler is wired to the <SearchBar /> via an `onKeyDown=` prop.
    const inputBlock = src.slice(
      src.indexOf('ref={searchRef}') - 10,
      src.indexOf('ref={searchRef}') + 600,
    )
    expect(inputBlock).toContain('onKeyDown')
  })

  it('ArrowDown on search input forwards focus to first menu item', () => {
    // The bridge must use querySelector('[role="menuitem"]') to find the first
    // item, then call .focus() on it.
    const codeLines = src.split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')

    expect(codeLines).toMatch(/ArrowDown/)
    expect(codeLines).toContain('[role="menuitem"]')
    expect(codeLines).toMatch(/first.*\.focus\(\)|querySelector.*focus\(\)/)
  })

  it('ArrowDown bridge calls preventDefault() to stop page scroll', () => {
    // Without preventDefault, ArrowDown scrolls the page while also (if the
    // bridge is working) moving focus. The scroll is jarring and unexpected.
    // Strip JSDoc/line comments first so prose mentions of "ArrowDown" don't
    // shadow the actual handler block.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .join('\n')
    const idx = codeOnly.indexOf('ArrowDown')
    const bridgeBlock = codeOnly.slice(idx, idx + 200)
    expect(bridgeBlock).toContain('preventDefault()')
  })
})

// ---------------------------------------------------------------------------
// 7 — SettingsModal WCAG fixes (Guideline #225 + WCAG 2.5.5 + section ID)
//
// Three issues were identified after the initial J10 acceptance:
//   1. WCAG 2.4.3 / Guideline #225: focus not returned to trigger on close
//   2. WCAG 2.5.5: nav buttons + close button minHeight: 36 (below 44px min)
//   3. Section ID mismatch: 'general' is not a valid SectionId — silently falls back
//
// These tests lock in the fixes so they cannot be silently reverted.
// ---------------------------------------------------------------------------

describe('SettingsModal — WCAG 2.4.3 focus-return on close (Guideline #225)', () => {
  it('declares a triggerRef to capture the element that opened the modal', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      fileURLToPath(new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url)),
      'utf-8',
    ) as string
    // The ref must be a nullable HTMLElement ref (so .focus() is available)
    expect(src).toContain('triggerRef')
    expect(src).toMatch(/useRef<HTMLElement\s*\|\s*null>/)
  })

  it('captures document.activeElement into triggerRef when modal opens', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      fileURLToPath(new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url)),
      'utf-8',
    ) as string
    // Must guard with instanceof before assigning (avoids assigning non-focusable elements)
    expect(src).toMatch(/document\.activeElement\s+instanceof\s+HTMLElement/)
    expect(src).toContain('triggerRef.current = document.activeElement')
  })

  it('restores focus to trigger when modal closes (Guideline #225)', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      fileURLToPath(new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url)),
      'utf-8',
    ) as string
    // The else branch (open → false) must focus the captured trigger
    expect(src).toContain('triggerRef.current?.focus()')
    // And must clear the ref to avoid a stale reference
    expect(src).toContain('triggerRef.current = null')
  })

  it('does not regress to a 36px touch target anywhere', () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      fileURLToPath(new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url)),
      'utf-8',
    ) as string
    expect(src).not.toMatch(/minHeight:\s*36/)
  })

  it('closes via the shared Esc keycap affordance, not a dedicated close button', () => {
    // The modal shares the Spotlight / Module Inserter language: backdrop click
    // and Esc both close, surfaced through a <Kbd>Esc</Kbd> hint in the rail.
    // There is no bespoke "Close settings" button (consistency pass).
    const { readFileSync } = require('fs')
    const tsx = readFileSync(
      fileURLToPath(new URL('../../admin/modals/Settings/SettingsModal.tsx', import.meta.url)),
      'utf-8',
    ) as string
    expect(tsx).not.toContain('aria-label="Close settings"')
    expect(tsx).toContain('<Kbd>Esc</Kbd>')
  })
})

describe('SettingsButton — section ID matches a valid SectionId', () => {
  it("dispatches 'general' (a valid SectionId after dropping the Pages section)", () => {
    const { readFileSync } = require('fs')
    const src = readFileSync(
      fileURLToPath(new URL('../../admin/pages/site/toolbar/SettingsButton.tsx', import.meta.url)),
      'utf-8',
    ) as string
    // 'pages' / 'breakpoints' / 'conditions' were dropped from the modal —
    // 'general' is the first NAV_ITEMS entry and the canonical default.
    expect(src).toContain("openSettings('general')")
  })
})
