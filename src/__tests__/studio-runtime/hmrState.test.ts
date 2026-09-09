/**
 * `snapshotFrameState`/`restoreFrameState` against a fake DOM. Node ids are
 * attached directly to the input/dialog/scroll elements in these fixtures —
 * matching how L3's Vite plugin actually stamps `data-node-id` (on the JSX
 * element itself, not on some ancestor wrapper) for any intrinsic element an
 * author writes directly in their own JSX. The `closest()` walk in `keyFor`
 * is a defensive fallback for an element a module renders without its own
 * id, not the expected shape for a plain `<input>`/`<dialog>`.
 *
 * The `import.meta.hot` wiring itself (`wireHmrStateAcrossUpdates`) is not
 * exercised here — see that function's own doc for why it can't be, and
 * `STATE.md`'s `live-04` handoff for the "needs dogfood" list.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { emptyFrameStateSnapshot, restoreFrameState, snapshotFrameState } from '@core/studio-runtime'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('snapshotFrameState / restoreFrameState — controls', () => {
  it('captures and restores an input value', () => {
    document.body.innerHTML = `<input data-node-id="n1" id="i" />`
    const input = document.getElementById('i') as HTMLInputElement
    input.value = 'typed text'

    const snapshot = snapshotFrameState(document)

    // Simulate Fast Refresh: the DOM is torn down and rebuilt fresh.
    document.body.innerHTML = `<input data-node-id="n1" id="i" />`
    restoreFrameState(document, snapshot)

    expect((document.getElementById('i') as HTMLInputElement).value).toBe('typed text')
  })

  it('captures and restores a checkbox\'s checked state', () => {
    document.body.innerHTML = `<input type="checkbox" data-node-id="n1" id="c" />`
    ;(document.getElementById('c') as HTMLInputElement).checked = true

    const snapshot = snapshotFrameState(document)
    document.body.innerHTML = `<input type="checkbox" data-node-id="n1" id="c" />`
    restoreFrameState(document, snapshot)

    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true)
  })

  it('falls back to the nearest node-id ancestor when the control has none of its own', () => {
    // A module that renders an <input> without spreading the id onto it
    // directly — the id lands on the module's own root instead. Restoring
    // still resolves back to the SAME wrapper, so the control found inside
    // it (this fixture's only one) is still addressable.
    document.body.innerHTML = `<div data-node-id="n1"><input id="i" /></div>`
    const input = document.getElementById('i') as HTMLInputElement
    input.value = 'typed text'

    const snapshot = snapshotFrameState(document)
    expect(Object.keys(snapshot.controls)).toContain('n1#0')
  })

  it('ignores an input with no node-id ancestor at all — no addressable identity across a remount', () => {
    document.body.innerHTML = `<input id="orphan" />`
    ;(document.getElementById('orphan') as HTMLInputElement).value = 'lost'

    const snapshot = snapshotFrameState(document)
    expect(Object.keys(snapshot.controls)).toHaveLength(0)
  })
})

describe('snapshotFrameState / restoreFrameState — sibling disambiguation', () => {
  it('keys same-node-id siblings (a .map() row) by position, not by bare node id', () => {
    document.body.innerHTML = `
      <input data-node-id="row" id="a" />
      <input data-node-id="row" id="b" />
    `
    ;(document.getElementById('a') as HTMLInputElement).value = 'first'
    ;(document.getElementById('b') as HTMLInputElement).value = 'second'

    const snapshot = snapshotFrameState(document)
    expect(Object.keys(snapshot.controls)).toContain('row#0')
    expect(Object.keys(snapshot.controls)).toContain('row#1')

    document.body.innerHTML = `
      <input data-node-id="row" id="a" />
      <input data-node-id="row" id="b" />
    `
    restoreFrameState(document, snapshot)

    expect((document.getElementById('a') as HTMLInputElement).value).toBe('first')
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('second')
  })

  it('silently drops an entry whose row no longer exists after the edit', () => {
    document.body.innerHTML = `
      <input data-node-id="row" id="a" />
      <input data-node-id="row" id="b" />
    `
    ;(document.getElementById('b') as HTMLInputElement).value = 'second'
    const snapshot = snapshotFrameState(document)

    // The edit removed the second row entirely.
    document.body.innerHTML = `<input data-node-id="row" id="a" />`

    expect(() => restoreFrameState(document, snapshot)).not.toThrow()
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('')
  })
})

describe('snapshotFrameState / restoreFrameState — scroll, open elements, focus', () => {
  it('captures a non-zero scroll offset and restores it', () => {
    document.body.innerHTML = `<div data-node-id="scroller"></div>`
    const scroller = document.querySelector('[data-node-id="scroller"]') as HTMLElement
    Object.defineProperty(scroller, 'scrollTop', { value: 120, configurable: true })
    Object.defineProperty(scroller, 'scrollLeft', { value: 4, configurable: true })

    const snapshot = snapshotFrameState(document)
    expect(snapshot.scroll['scroller#0']).toEqual({ top: 120, left: 4 })
  })

  it('restores a captured scroll offset onto the post-update element', () => {
    document.body.innerHTML = `<div data-node-id="scroller"></div>`
    const before = document.querySelector('[data-node-id="scroller"]') as HTMLElement
    Object.defineProperty(before, 'scrollTop', { value: 120, configurable: true })
    Object.defineProperty(before, 'scrollLeft', { value: 4, configurable: true })
    const snapshot = snapshotFrameState(document)

    document.body.innerHTML = `<div data-node-id="scroller"></div>`
    restoreFrameState(document, snapshot)

    const after = document.querySelector('[data-node-id="scroller"]') as HTMLElement
    expect(after.scrollTop).toBe(120)
    expect(after.scrollLeft).toBe(4)
  })

  it('records an [open] element carrying a node id', () => {
    document.body.innerHTML = `<dialog data-node-id="d1" open></dialog>`
    const snapshot = snapshotFrameState(document)
    expect(snapshot.openElements).toContain('d1#0')
  })

  it('restores [open] onto the post-update element', () => {
    document.body.innerHTML = `<dialog data-node-id="d1" open></dialog>`
    const snapshot = snapshotFrameState(document)

    document.body.innerHTML = `<dialog data-node-id="d1"></dialog>`
    restoreFrameState(document, snapshot)

    expect(document.querySelector('[data-node-id="d1"]')?.hasAttribute('open')).toBe(true)
  })

  it('captures the focused element and restores focus after a remount', () => {
    document.body.innerHTML = `<input data-node-id="n1" id="i" />`
    const input = document.getElementById('i') as HTMLInputElement
    input.focus()

    const snapshot = snapshotFrameState(document)
    expect(snapshot.focused).toBe('n1#0')

    document.body.innerHTML = `<input data-node-id="n1" id="i" />`
    restoreFrameState(document, snapshot)

    expect(document.activeElement?.id).toBe('i')
  })

  it('records no focus when nothing (or only body) is focused', () => {
    document.body.innerHTML = `<div data-node-id="n1"></div>`
    const snapshot = snapshotFrameState(document)
    expect(snapshot.focused).toBeNull()
  })
})

describe('emptyFrameStateSnapshot', () => {
  it('is inert against restoreFrameState', () => {
    document.body.innerHTML = `<input data-node-id="n1" id="i" value="untouched" />`
    ;(document.getElementById('i') as HTMLInputElement).value = 'untouched'
    expect(() => restoreFrameState(document, emptyFrameStateSnapshot())).not.toThrow()
    expect((document.getElementById('i') as HTMLInputElement).value).toBe('untouched')
  })
})
