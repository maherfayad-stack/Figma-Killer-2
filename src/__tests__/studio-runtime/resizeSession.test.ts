/**
 * The live (Tier 2) frame's resize session — `resizeSession.ts`, the runtime's
 * half of the same gesture `useElementResizeDrag` runs for a portal frame. The
 * handles and the pointer are the PARENT's (SB-4); the frame is driven by
 * `begin` / `step` / `end` over the wire. Both hosts share
 * `elementResizeRules.ts` and `elementResizeMeasure.ts`, so these cases pin
 * that the runtime actually USES them: the commit it posts is the CSS size
 * (IX-6a), a positioned element's offset (IX-6d), live modifiers (IX-6c) and
 * the gesture freeze. happy-dom resolves the inline styles; the preview is the
 * runtime-owned stylesheet rule. The drag guard (ERR-12), the badge (IX-18) and
 * the pointer capture live in the parent now, under `elementResizeDrag.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  RESIZE_PREVIEW_STYLE_ID,
  installResizeSession,
  type ResizeCommitPatch,
  type ResizeSessionController,
  type ResizeTargetContext,
  type SnapGuide,
} from '@core/studio-runtime'

let controller: ResizeSessionController | null = null
let commits: ResizeCommitPatch[] = []
let guidePosts: Array<readonly SnapGuide[]> = []
let gestures: boolean[] = []

function install(
  targetStyle: string,
  options: { container?: HTMLElement; context?: ResizeTargetContext; peers?: Record<string, Element> } = {},
): { target: HTMLElement } {
  const target = document.createElement('div')
  target.setAttribute('data-node-id', 'box')
  target.setAttribute('style', targetStyle)
  ;(options.container ?? document.body).appendChild(target)
  if (options.container && !options.container.isConnected) document.body.appendChild(options.container)
  commits = []
  guidePosts = []
  gestures = []
  controller = installResizeSession({
    doc: document,
    view: window,
    resolveTarget: (ref) => (ref.nodeId === 'box' ? target : (options.peers?.[ref.nodeId] ?? null)),
    onCommit: (_ref, patch) => commits.push(patch),
    onGuides: (guides) => guidePosts.push(guides),
    onGestureChange: (active) => gestures.push(active),
  })
  controller.setTarget({ nodeId: 'box', occurrenceIndex: 0 }, false, options.context)
  return { target }
}

const NO_KEYS = { shiftKey: false, altKey: false }

afterEach(() => {
  controller?.dispose()
  controller = null
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('installResizeSession — the runtime drag', () => {
  it('commits the CSS width of a content-box element, not its border box (IX-6a)', () => {
    install('box-sizing: content-box; width: 100px; height: 50px; padding: 10px; border: 1px solid black')
    controller!.begin('e')
    controller!.step(40, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([{ width: '140px' }])
  })

  it('moves `left` with the W edge of an absolute element, and previews it (IX-6d)', () => {
    install('position: absolute; left: 50px; top: 30px; box-sizing: border-box; width: 100px; height: 60px')
    controller!.begin('w')
    controller!.step(-20, 0, NO_KEYS)
    const rule = document.getElementById(RESIZE_PREVIEW_STYLE_ID)?.textContent ?? ''
    expect(rule).toContain('width: 120px !important')
    expect(rule).toContain('left: 30px !important')
    controller!.end(true)
    expect(commits).toEqual([{ width: '120px', left: '30px' }])
  })

  it('writes the edge the source anchors by: a W drag on a `right`-anchored layer is the width alone (PA-8)', () => {
    install('position: absolute; right: 24px; top: 30px; box-sizing: border-box; width: 100px; height: 60px', {
      context: { sizing: {}, snap: null, anchors: { horizontal: ['right'], vertical: ['top'] } },
    })
    controller!.begin('w')
    controller!.step(-20, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([{ width: '120px' }])
  })

  it('an E drag on a `right`-anchored layer moves `right` in by the growth (PA-8)', () => {
    install('position: absolute; right: 24px; top: 30px; box-sizing: border-box; width: 100px; height: 60px', {
      context: { sizing: {}, snap: null, anchors: { horizontal: ['right'], vertical: ['top'] } },
    })
    controller!.begin('e')
    controller!.step(10, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([{ width: '110px', right: '14px' }])
  })

  it('reads ⇧ as it is held at each step (IX-6c)', () => {
    install('box-sizing: border-box; width: 200px; height: 100px')
    controller!.begin('e')
    controller!.step(40, 0, NO_KEYS)
    // ⇧ pressed mid-drag: the very next step keeps the aspect ratio.
    controller!.step(40, 0, { shiftKey: true, altKey: false })
    controller!.end(true)
    expect(commits).toEqual([{ width: '240px', height: '120px' }])
  })

  it('⌥ resizes about the centre (IX-6c)', () => {
    install('position: absolute; left: 50px; top: 30px; box-sizing: border-box; width: 100px; height: 60px')
    controller!.begin('e')
    controller!.step(20, 0, { shiftKey: false, altKey: true })
    controller!.end(true)
    expect(commits).toEqual([{ width: '140px', left: '30px' }])
  })

  it('the scale tool latched at the target keeps the ratio with no key held', () => {
    install('box-sizing: border-box; width: 100px; height: 60px')
    controller!.setTarget({ nodeId: 'box', occurrenceIndex: 0 }, true)
    controller!.begin('e')
    controller!.step(20, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([{ width: '120px', height: '72px' }])
  })

  it('a cancelled drag drops the preview and commits nothing; a release that came back to the start commits nothing', () => {
    install('box-sizing: border-box; width: 200px; height: 100px')
    controller!.begin('e')
    controller!.step(40, 0, NO_KEYS)
    expect(document.getElementById(RESIZE_PREVIEW_STYLE_ID)).not.toBeNull()
    controller!.end(false)
    expect(document.getElementById(RESIZE_PREVIEW_STYLE_ID)).toBeNull()
    expect(commits).toEqual([])

    controller!.begin('e')
    controller!.step(0, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([])
  })

  it('refuses a drag with no sizeable target, and ignores a step or an end with no drag in flight', () => {
    install('display: inline; width: 100px')
    expect(controller!.begin('e')).toBe(false)
    controller!.step(10, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([])
    expect(gestures).toEqual([])
  })
})

/** A flex row the target sits in — the layout whose main axis a `flex: 1` item does not let `width` decide. */
function flexRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('style', 'display: flex; flex-direction: row; width: 600px')
  return row
}

/** Stub an element's border box — happy-dom lays nothing out. */
function placeAt(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}

describe('installResizeSession — a flex item goes Fixed, as in a portal frame (canvas-23 / IX-6b)', () => {
  it('drops an inline `flex: 1` Fill marker with the width, and previews the cleared value', () => {
    install('flex: 1; width: 100px; height: 40px; box-sizing: border-box', {
      container: flexRow(),
      context: { sizing: { flex: '1' }, snap: null, anchors: null },
    })
    controller!.begin('e')
    controller!.step(40, 0, NO_KEYS)
    const rule = document.getElementById(RESIZE_PREVIEW_STYLE_ID)?.textContent ?? ''
    // Without the cleared flex the item keeps growing to fill the row and the
    // preview tracks nothing: `flex-grow` has to be beaten, not only `width`.
    expect(rule).toContain('flex-grow: 0 !important')
    expect(rule).toContain('width: 140px !important')
    controller!.end(true)
    expect(commits).toEqual([{ flex: null, width: '140px' }])
  })

  it('overrides a `flex: 1` that lives in the cascade, which no clear could reach', () => {
    const style = document.createElement('style')
    style.textContent = '.grow { flex: 1 1 0%; }'
    document.head.appendChild(style)
    const { target } = install('width: 100px; height: 40px; box-sizing: border-box', { container: flexRow(), context: { sizing: {}, snap: null, anchors: null } })
    target.className = 'grow'
    controller!.begin('e')
    controller!.step(40, 0, NO_KEYS)
    controller!.end(true)
    expect(commits).toEqual([{ flex: '0 1 auto', width: '140px' }])
  })
})

describe('installResizeSession — the moving edge snaps, as in a portal frame (canvas-26 / IX-6e)', () => {
  it('snaps the east edge to a sibling within the zoomed threshold, and reports the guide', () => {
    const sibling = document.createElement('div')
    document.body.appendChild(sibling)
    placeAt(sibling, 110, 0, 100, 50)
    const { target } = install('width: 100px; height: 50px; box-sizing: border-box', {
      context: { sizing: {}, snap: { siblings: [{ nodeId: 'sibling', occurrenceIndex: 0 }], parent: null, zoom: 1 }, anchors: null },
      peers: { sibling },
    })
    placeAt(target, 0, 0, 100, 50)
    controller!.begin('e')
    // The edge lands at 157 — 3 px short of the sibling's centre (160).
    controller!.step(57, 0, NO_KEYS)
    expect(guidePosts.at(-1)).toEqual([{ axis: 'x', position: 160, start: 0, end: 50 }])
    controller!.end(true)
    expect(commits).toEqual([{ width: '160px' }])
    // The guides are cleared once the drag ends.
    expect(guidePosts.at(-1)).toEqual([])
  })

  it('pulls from 8 SCREEN px: at 50% zoom a 12 frame-px gap still snaps', () => {
    const sibling = document.createElement('div')
    document.body.appendChild(sibling)
    placeAt(sibling, 110, 0, 100, 50)
    const { target } = install('width: 100px; height: 50px; box-sizing: border-box', {
      context: { sizing: {}, snap: { siblings: [{ nodeId: 'sibling', occurrenceIndex: 0 }], parent: null, zoom: 0.5 } },
      peers: { sibling },
    })
    placeAt(target, 0, 0, 100, 50)
    controller!.begin('e')
    controller!.step(98, 0, NO_KEYS)
    controller!.end(true)
    // The edge at 198 is 12 frame px from the sibling's end (210): 6 screen px at 50%.
    expect(commits).toEqual([{ width: '210px' }])
  })
})

describe('installResizeSession — the drag is a gesture (canvas-23, the badge at the bottom of a live frame)', () => {
  it('reports the gesture start at begin and its end on release and on cancel', () => {
    install('box-sizing: border-box; width: 200px; height: 100px')
    controller!.begin('e')
    expect(gestures).toEqual([true])
    controller!.step(20, 0, NO_KEYS)
    controller!.end(true)
    expect(gestures).toEqual([true, false])
    controller!.begin('e')
    controller!.end(false)
    expect(gestures).toEqual([true, false, true, false])
  })

  it('a second begin while one is out ends the first without committing it', () => {
    install('box-sizing: border-box; width: 200px; height: 100px')
    controller!.begin('e')
    controller!.step(20, 0, NO_KEYS)
    controller!.begin('s')
    expect(commits).toEqual([])
    expect(gestures).toEqual([true, false, true])
  })
})
