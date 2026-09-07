/**
 * ⌘⇧C routing — which of "node / frame / open screen" the Copy-as-PNG shortcut
 * photographs, and the cases it refuses by name.
 *
 * Two halves, both here because they answer the same question:
 *   - `resolveCopyAsPngTarget` — WHAT gets captured.
 *   - the `export.copySelectionPng` keybinding — WHEN the shortcut fires, and
 *     (the part that has bitten this editor before) that it does not also fire
 *     `layers.copy`, which shares the letter `c`.
 */
import { describe, expect, it } from 'bun:test'
import { getKeybindingForCommand, type KeyEventLike } from '@admin/spotlight/keybindings'
import { resolveCopyAsPngTarget, type CopyAsPngSelection } from '../copyAsPngTarget'

const EMPTY: CopyAsPngSelection = {
  isVisualComponentDocument: false,
  selectedNodeId: null,
  selectedNodeLabel: null,
  selectedFramePageIds: [],
  activePageId: null,
  activePageTitle: null,
}

describe('resolveCopyAsPngTarget', () => {
  it('captures the selected NODE, cropped out of the screen it is on', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      selectedNodeId: 'pages/Onboarding.tsx:12:4',
      selectedNodeLabel: 'Hero',
      activePageId: 'onboarding',
      activePageTitle: 'Onboarding',
    })

    expect(target).toEqual({
      ok: true,
      pageId: 'onboarding',
      nodeId: 'pages/Onboarding.tsx:12:4',
      label: 'Hero',
    })
  })

  it('prefers the node over a frame selection — the node is the more specific gesture', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      selectedNodeId: 'n1',
      selectedNodeLabel: 'Card',
      selectedFramePageIds: ['other'],
      activePageId: 'onboarding',
      activePageTitle: 'Onboarding',
    })

    expect(target).toMatchObject({ ok: true, pageId: 'onboarding', nodeId: 'n1' })
  })

  it('captures the WHOLE frame when exactly one board frame is selected', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      selectedFramePageIds: ['checkout'],
      activePageId: 'onboarding',
      activePageTitle: 'Onboarding',
    })

    // `nodeId: null` is the "no crop" request the server reads as the frame.
    expect(target).toEqual({ ok: true, pageId: 'checkout', nodeId: null, label: 'frame' })
  })

  it('captures the OPEN SCREEN when nothing is selected', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      activePageId: 'onboarding',
      activePageTitle: 'Onboarding',
    })

    expect(target).toEqual({ ok: true, pageId: 'onboarding', nodeId: null, label: 'Onboarding' })
  })

  it('refuses a multi-frame selection by name rather than picking one', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      selectedFramePageIds: ['a', 'b', 'c'],
      activePageId: 'a',
      activePageTitle: 'A',
    })

    expect(target.ok).toBe(false)
    if (target.ok) return
    expect(target.reason).toContain('3 frames are selected')
  })

  it('refuses while a Visual Component is open — a VC has no frame to photograph', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      isVisualComponentDocument: true,
      selectedNodeId: 'n1',
      selectedNodeLabel: 'Slot',
      activePageId: 'vc:card',
      activePageTitle: 'Card',
    })

    expect(target.ok).toBe(false)
    if (target.ok) return
    expect(target.reason).toContain('Visual Component')
  })

  it('refuses when no screen is open', () => {
    const target = resolveCopyAsPngTarget(EMPTY)

    expect(target.ok).toBe(false)
    if (target.ok) return
    expect(target.reason).toBe('No screen is open, so there is nothing to copy.')
  })

  it('falls back to a generic label rather than an empty toast title', () => {
    const target = resolveCopyAsPngTarget({
      ...EMPTY,
      selectedNodeId: 'n1',
      selectedNodeLabel: '',
      activePageId: 'p',
      activePageTitle: '',
    })

    expect(target).toMatchObject({ ok: true, label: 'element' })
  })
})

function key(overrides: Partial<KeyEventLike>): KeyEventLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: 'c', ...overrides }
}

describe('export.copySelectionPng keybinding', () => {
  const copyPng = getKeybindingForCommand('export.copySelectionPng')
  const layersCopy = getKeybindingForCommand('layers.copy')
  const toolsComment = getKeybindingForCommand('tools.comment')

  it('is registered, and stands down inside an editable field', () => {
    expect(copyPng).toBeDefined()
    expect(copyPng?.ignoreInEditableField).toBe(true)
    expect(copyPng?.shortcut).toEqual({ mac: '⌘⇧C', win: 'Ctrl+Shift+C' })
  })

  it('matches ⌘⇧C and Ctrl+Shift+C', () => {
    expect(copyPng?.match(key({ metaKey: true, shiftKey: true }))).toBe(true)
    expect(copyPng?.match(key({ ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(copyPng?.match(key({ metaKey: true, shiftKey: true, key: 'C' }))).toBe(true)
  })

  it('does not match plain ⌘C, bare c, or ⌥⌘⇧C', () => {
    expect(copyPng?.match(key({ metaKey: true }))).toBe(false)
    expect(copyPng?.match(key({}))).toBe(false)
    expect(copyPng?.match(key({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false)
  })

  // The regression this file exists for: ⌘C and ⌘⇧C differ by ONE modifier, and
  // `layers.copy` used to accept any Shift state — so one ⌘⇧C press ran both
  // "copy node to the layer clipboard" and "copy as PNG".
  it('does not collide with layers.copy (⌘C) or tools.comment (bare c)', () => {
    const shiftedCopy = key({ metaKey: true, shiftKey: true })
    expect(copyPng?.match(shiftedCopy)).toBe(true)
    expect(layersCopy?.match(shiftedCopy)).toBe(false)
    expect(toolsComment?.match(shiftedCopy)).toBe(false)

    const plainCopy = key({ metaKey: true })
    expect(layersCopy?.match(plainCopy)).toBe(true)
    expect(copyPng?.match(plainCopy)).toBe(false)
  })
})
