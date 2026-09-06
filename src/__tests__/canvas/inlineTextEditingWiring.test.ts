/**
 * Inline text editing — canvas wiring gates.
 *
 * Source-assertion tests (canvasNotch.test.ts convention) for the pieces that
 * only manifest inside live iframes and the full canvas mount. The editor was
 * rewritten from a parent-document overlay to editing the REAL node element in
 * place via `contentEditable`, so these gates assert the in-place wiring:
 *
 *   - double-click → startInlineEdit, gated to design mode
 *     (`useCanvasNodeInteraction`, extracted from `CanvasRoot` when that file
 *     hit the 700-line ceiling — the RULE is unchanged, only its address);
 *   - NodeRenderer builds an `InlineEditBinding`, passes `inlineEdit` to the
 *     component, and focuses the element via `useLayoutEffect`;
 *   - the canvas keyboard handler bails on `activeInlineEdit` so Delete/Cmd+D
 *     never fire mid-edit;
 *   - BreakpointFrame no longer mounts an inline-edit overlay (the node itself
 *     is the editor now).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

const NODE_INTERACTION = new URL('../../admin/pages/site/canvas/useCanvasNodeInteraction.ts', import.meta.url)
const NODE_RENDERER = new URL('../../admin/pages/site/canvas/NodeRenderer.tsx', import.meta.url)
const KEYBOARD_SHORTCUTS = new URL('../../admin/pages/site/canvas/useCanvasKeyboardShortcuts.ts', import.meta.url)
const IFRAME_EVENT_FORWARDING = new URL('../../admin/pages/site/canvas/useIframeEventForwarding.ts', import.meta.url)
const BREAKPOINT_FRAME = new URL('../../admin/pages/site/canvas/BreakpointFrame.tsx', import.meta.url)
const CONTEXTS = new URL('../../admin/pages/site/canvas/CanvasContexts.ts', import.meta.url)

describe('inline text editing wiring (in-place contentEditable)', () => {
  it('the node-interaction hook starts a session on double-click, gated to design mode', () => {
    const src = readFileSync(NODE_INTERACTION, 'utf-8')
    expect(src).toContain('startInlineEdit')
    // The permission arrives as an option now (`CanvasRoot` reads it from the
    // permissions context and passes it in) rather than being read here.
    expect(src).toContain('options.canEditContent')
    expect(src).toContain('options.isLive')
  })

  it('the double-click context channel carries the originating breakpoint', () => {
    const src = readFileSync(CONTEXTS, 'utf-8')
    // WS-10 Phase 2 added a trailing `frameId` param (board-frame identity —
    // a separate dimension from `breakpointId`, see `CanvasFrameContext`'s
    // doc) alongside the pre-existing `breakpointId` this gate checks for.
    expect(src).toContain('onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string, frameId?: string | null) => void')
  })

  it('NodeRenderer builds an InlineEditBinding for the edited node in the session frame', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    // Edits flow live: read the contentEditable text back, commit through the store.
    expect(src).toContain('const inlineEditBinding: InlineEditBinding | undefined = isInlineEditing')
    expect(src).toContain('applyInlineEditValue(readInlineEditableText')
    // Session is scoped to the one frame that owns it. The three reads of the
    // session (`isInlineEditing` + the two session values) were collapsed into
    // ONE `useShallow` subscription for the per-node selector budget, so the
    // match now reads a local `session` binding rather than `s.activeInlineEdit`
    // three times — the SCOPING is what this gate is about, not the spelling.
    expect(src).toContain('const session = s.activeInlineEdit')
    expect(src).toContain('session.breakpointId === breakpointId')
    expect(src).toContain('session.frameId === frameId')
  })

  it('NodeRenderer passes inlineEdit to the module component (the element IS the editor)', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain('inlineEdit={inlineEditBinding}')
    // No overlay, no per-frame hidden-text attribute — those were the old design.
    expect(src).not.toContain("'data-studio-inline-editing'")
    expect(src).not.toContain('InlineTextEditOverlay')
  })

  it('NodeRenderer focuses the now-editable element on session start via a layout effect', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain('useLayoutEffect(() => {')
    expect(src).toContain('el.focus()')
  })

  it('the canvas keyboard handler bails while an inline edit is active', () => {
    const src = readFileSync(KEYBOARD_SHORTCUTS, 'utf-8')
    expect(src).toContain('if (useEditorStore.getState().activeInlineEdit) return')
  })

  it('the iframe key-forwarding stands down while an inline edit is active', () => {
    // The edited element lives in the iframe; IframeFrameSurface forwards its
    // keystrokes to the parent document. Forwarding mid-edit would let native
    // parent handlers (undo/redo, zoom, panel rail, space-pan) fire on the
    // clone — the worst being Cmd+Z reverting the whole session in the store
    // while the DOM keeps the text. The forward layer must bail during a session
    // so the spacebar types a space and Cmd+Z is the element's own text undo.
    //
    // The three relays moved out of `IframeFrameSurface` into
    // `useIframeEventForwarding` — the RULE is unchanged, only its address, so
    // this gate reads the new home rather than a file that no longer forwards.
    const src = readFileSync(IFRAME_EVENT_FORWARDING, 'utf-8')
    expect(src).toContain('if (useEditorStore.getState().activeInlineEdit) return')
  })

  it('BreakpointFrame no longer mounts an inline-edit overlay', () => {
    const src = readFileSync(BREAKPOINT_FRAME, 'utf-8')
    expect(src).not.toContain('InlineTextEditOverlay')
    // The selection-ring overlay is still mounted — it is a different component.
    expect(src).toContain('<BreakpointSelectionOverlay')
  })
})
