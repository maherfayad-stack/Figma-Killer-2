/**
 * FillSection — Penpot's Fill section (`STATE.md` `panel-25`, P3 item 5).
 *
 * Mounts `<FillSection />` against the store (`useSelectionModel`/
 * `useInspectorCommit`) rather than as a prop-driven component — the same
 * shift every migrated section's own test suite already made (see
 * `measuresSection.test.tsx`/`alignSection.test.tsx`).
 *
 * Covers:
 *   1. Law 1 — nothing set renders the empty header (title + add buttons),
 *      no `PropertyList`, no chevron.
 *   2. Text fill entry (`color`) — summary, inline `%` opacity field, popover
 *      edit, remove.
 *   3. Background layers (G6.5) — one row per `background-image` layer, add
 *      / remove / reorder, per-layer satellites.
 *   4. Honest refusal of an unsplittable layer list.
 *   5. Solid fill (`backgroundColor`) — pinned below the layers, its own `%`
 *      opacity field.
 *   6. Content fit (`objectFit`/`objectPosition`).
 *   7. The `background` shorthand escape hatch.
 *   8. The header's add buttons (ported from the old, separately-exported
 *      `FillSectionActions`' own test suite — now exercised through the full
 *      section mount, since the header component is no longer exported on
 *      its own).
 *   9. Code-locked properties — the write is refused, same posture
 *      `MeasuresSection`'s own rotation test already established.
 *  10. `STATE.md` `panel-30` — a value the frame genuinely renders but
 *      nothing stores anywhere still opens Fill, muted, no remove button;
 *      a genuinely-initial value does not; the write-target refusal gap in
 *      the muted row's own popover; the Tier 2 loading guard.
 *  11. `STATE.md` `panel-32` — a value stored at BASE, with no override at
 *      the active breakpoint/condition, is a DIFFERENT muted case from #10
 *      (something DOES declare it, just not here): still opens Fill, muted;
 *      the header's own "Add …" buttons hide once the row is visible; the
 *      popover states a write creates a NEW override rather than editing the
 *      declaration shown; an override at the active context is a normal
 *      stored row, not muted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { setStudioStyleRuleSources } from '@site/studio/styleRuleWriteback'
import { registerFrameAdapter, unregisterFrameAdapter } from '@site/canvas/frameAdapter/canvasFrameAdapterRegistry'
import { PortalFrameAdapter } from '@site/canvas/frameAdapter/PortalFrameAdapter'
import { BridgeFrameAdapter, type BridgeFrameChannel } from '@site/canvas/frameAdapter/BridgeFrameAdapter'
import { toOutboundEnvelope, type InboundEnvelope } from '@core/studio-runtime'
import { FillSection } from '../FillSection'
import { makeSite, makePage, makeNode } from '../../../../../../__tests__/fixtures'
import '@modules/base/index'

const NODE_ID = 'node-1'
const ROOT_ID = 'root'

const GRADIENT = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'
const GRADIENT_B = 'radial-gradient(circle, #00ff00 0%, #ffffff 100%)'

let liveFrames: Array<{ frame: HTMLIFrameElement; dispose: () => void }> = []

afterEach(() => {
  cleanup()
  for (const live of liveFrames) live.dispose()
  liveFrames = []
})

/**
 * A registered PORTAL canvas frame carrying one styled element for
 * `NODE_ID` — the exact pattern `useInspectComputedStyle.test.tsx` already
 * established (see that file's own doc for why this, not a second fixture
 * shape). `styleNode` sets whatever the FRAME actually renders — deliberately
 * independent of the studio node's own (usually empty) `inlineStyles` bag,
 * matching the real gap this suite exists to close: the CANVAS shows a
 * colour the STORED bag never declared.
 */
function setUpCanvasFrame(
  nodeId: string,
  styleNode: (el: HTMLElement, frameDoc: Document) => void,
  breakpointId = 'desktop',
) {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  frame.setAttribute('data-breakpoint-id', breakpointId)

  const node = frameDoc.createElement('div')
  node.setAttribute('data-node-id', nodeId)
  frameDoc.body.appendChild(node)
  styleNode(node, frameDoc)

  const adapter = new PortalFrameAdapter(frameDoc)
  registerFrameAdapter(frame, adapter)
  liveFrames.push({
    frame,
    dispose: () => {
      unregisterFrameAdapter(frame)
      adapter.dispose()
      frame.remove()
    },
  })
  return node
}

const BRIDGE_ORIGIN = 'https://live.studio.test'

/**
 * A registered BRIDGE canvas frame (Tier 2, `panel-26`) whose `measure`
 * requests this test resolves manually — same stub-channel shape
 * `useBridgeComputedValues.test.ts` already established, trimmed to only
 * what this suite needs (one manual resolve, no auto-reply).
 */
function addBridgeFrame(breakpointId: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('data-breakpoint-id', breakpointId)
  document.body.appendChild(frame)

  let handler: ((ev: MessageEvent) => void) | null = null
  const posted: InboundEnvelope[] = []
  const channel: BridgeFrameChannel = {
    postMessage: (message) => posted.push(message as InboundEnvelope),
    addEventListener: (type, h) => {
      if (type === 'message') handler = h
    },
    removeEventListener: (type, h) => {
      if (type === 'message' && handler === h) handler = null
    },
  }
  const adapter = new BridgeFrameAdapter({ channel, frameOrigin: BRIDGE_ORIGIN })
  registerFrameAdapter(frame, adapter)
  liveFrames.push({
    frame,
    dispose: () => {
      unregisterFrameAdapter(frame)
      adapter.dispose()
      frame.remove()
    },
  })

  return {
    /** Resolves the FIRST still-pending `measure` request with `computedStyle`. */
    resolveFirstMeasure(computedStyle: Record<string, string>) {
      const request = posted.find((env) => env.message.type === 'measure')
      if (!request || request.message.type !== 'measure') {
        throw new Error('No pending "measure" request')
      }
      handler?.({
        origin: BRIDGE_ORIGIN,
        source: undefined,
        data: toOutboundEnvelope({
          type: 'measure:result',
          requestId: request.message.requestId,
          measurements: request.message.refs.map((ref) => ({
            nodeId: ref.nodeId,
            occurrenceIndex: ref.occurrenceIndex,
            rect: { x: 0, y: 0, width: 10, height: 10 },
            computedStyle,
          })),
        }),
      } as MessageEvent)
    },
    hasPendingMeasure: () => posted.some((env) => env.message.type === 'measure'),
  }
}

beforeEach(() => {
  localStorage.clear()
  setStudioStyleRuleSources({}, {})
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    activeDocument: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

function selectNode(overrides: Parameters<typeof makeNode>[0] = {}) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.div', ...overrides }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function currentNode() {
  return useEditorStore.getState().site?.pages[0]?.nodes[NODE_ID]
}

// ---------------------------------------------------------------------------
// 1. Law 1
// ---------------------------------------------------------------------------

describe('FillSection — Law 1', () => {
  it('renders the empty header with no chevron and no list when nothing is set', () => {
    selectNode()
    render(<FillSection />)

    expect(screen.getByText('Fill')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Fill' })).toBeNull()
    expect(screen.queryByRole('button', { expanded: true })).toBeNull()
    expect(screen.getByRole('button', { name: /add text colour/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add solid color fill/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /add gradient fill/i })).toBeTruthy()
  })

  it('treats `background-image: none` as no layers at all', () => {
    selectNode({ inlineStyles: { backgroundImage: 'none' } })
    render(<FillSection />)
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Text fill entry
// ---------------------------------------------------------------------------

describe('FillSection — text fill entry', () => {
  it('shows a Text row with the colour in its own inline field, an opacity field, and a remove button', () => {
    selectNode({ inlineStyles: { color: '#112233' } })
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Text colour' })).toHaveProperty('value', '#112233')
    expect(within(row).getByRole('button', { name: 'Remove Text' })).toBeTruthy()
    expect(within(row).getByRole('textbox', { name: 'Text colour opacity' })).toHaveProperty('value', '100')
  })

  // `STATE.md` panel-33 — the reported "why here I need 2 clicks to change a
  // colors": the row's OWN text field is editable directly, no popover hop
  // needed to type a hex value.
  it('commits a hex value typed directly into the row, with no popover', () => {
    selectNode({ inlineStyles: { color: '#112233' } })
    render(<FillSection />)

    const input = screen.getByRole('textbox', { name: 'Text colour' })
    fireEvent.change(input, { target: { value: '#445566' } })
    fireEvent.blur(input)

    expect(currentNode()?.inlineStyles?.color).toBe('#445566')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // The defect this ticket fixes: clicking the row used to open an
  // intermediate "Text colour" popover whose OWN swatch had to be clicked
  // again to reach the real picker. One click on the row's swatch now opens
  // `ColorPickerPopover` directly.
  it('opens the real colour picker on the FIRST click of the row swatch', () => {
    selectNode({ inlineStyles: { color: '#112233' } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Text colour swatch' }))

    const popover = screen.getByRole('dialog', { name: 'Text colour' })
    // The real picker's OWN value field, distinct from the row's field
    // (`aria-label="Text colour"`) — proof this is the picker itself, not a
    // second intermediate stop.
    expect(within(popover).getByRole('textbox', { name: 'Text colour value' })).toBeTruthy()
  })

  // Closing the picker without picking anything must never rewrite a
  // `var(--token)` value to a literal colour — the honesty trap named in the
  // work order.
  it('leaves a token value untouched after opening and closing the picker without picking', () => {
    selectNode({ inlineStyles: { color: 'var(--brand)' } })
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.color = 'rgb(10, 20, 30)'
    })
    render(<FillSection />)

    const swatch = screen.getByRole('button', { name: 'Text colour swatch' })
    fireEvent.click(swatch)
    expect(screen.getByRole('dialog', { name: 'Text colour' })).toBeTruthy()
    fireEvent.click(swatch)
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(currentNode()?.inlineStyles?.color).toBe('var(--brand)')
  })

  // Defect 2: the swatch paints the RESOLVED colour the frame actually
  // renders, never a blank well — `var()` has no meaning in the admin's own
  // document, only in the canvas iframe that declares it.
  it("paints the swatch with the frame's resolved colour while the field keeps the token text", () => {
    selectNode({ inlineStyles: { color: 'var(--brand)' } })
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.color = 'rgb(248, 249, 249)'
    })
    render(<FillSection />)

    expect(screen.getByRole('textbox', { name: 'Text colour' })).toHaveProperty('value', 'var(--brand)')
    const swatchGlyph = screen.getByRole('button', { name: 'Text colour swatch' }).querySelector('span')
    expect(swatchGlyph?.style.getPropertyValue('--color-token-option-value')).toBe('rgb(248, 249, 249)')
  })

  it('the opacity field commits the alpha channel of the same colour', () => {
    selectNode({ inlineStyles: { color: '#112233' } })
    render(<FillSection />)

    const opacity = screen.getByRole('textbox', { name: 'Text colour opacity' })
    fireEvent.focus(opacity)
    fireEvent.change(opacity, { target: { value: '50' } })
    fireEvent.blur(opacity)

    expect(currentNode()?.inlineStyles?.color).toBe('#11223380')
  })

  it('disables the opacity field for a value it cannot parse (a token reference)', () => {
    selectNode({ inlineStyles: { color: 'var(--brand)' } })
    render(<FillSection />)

    const opacity = screen.getByRole('textbox', { name: 'Text colour opacity' })
    expect(opacity).toHaveProperty('disabled', true)
  })

  it('"remove" clears color', () => {
    selectNode({ inlineStyles: { color: '#112233' } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Text' }))
    expect(currentNode()?.inlineStyles?.color).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. Background layers
// ---------------------------------------------------------------------------

describe('FillSection — background layers', () => {
  it('draws one row per comma-separated layer, first row = topmost paint', () => {
    selectNode({ inlineStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` } })
    render(<FillSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Linear gradient')
    expect(rows[1]!.textContent).toContain('Radial gradient')
  })

  it('removing one layer rewrites the list without it', () => {
    selectNode({ inlineStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear gradient fill 1' }))
    expect(currentNode()?.inlineStyles?.backgroundImage).toBe(GRADIENT_B)
  })

  it('reorders with Alt+ArrowDown — layer order IS paint order', () => {
    selectNode({ inlineStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` } })
    render(<FillSection />)

    fireEvent.keyDown(screen.getAllByRole('listitem')[0]!, { key: 'ArrowDown', altKey: true })
    expect(currentNode()?.inlineStyles?.backgroundImage).toBe(`${GRADIENT_B}, ${GRADIENT}`)
  })

  it('edits one layer without touching the others', () => {
    selectNode({ inlineStyles: { backgroundImage: `${GRADIENT}, ${GRADIENT_B}` } })
    render(<FillSection />)

    fireEvent.click(screen.getByText('Radial gradient'))
    const popover = screen.getByRole('dialog', { name: 'Radial gradient fill 2' })
    const stopInput = within(popover).getByRole('textbox', { name: 'Stop 1 colour' })
    fireEvent.change(stopInput, { target: { value: '#123456' } })
    fireEvent.blur(stopInput)

    const written = String(currentNode()?.inlineStyles?.backgroundImage)
    expect(written.startsWith(GRADIENT)).toBe(true)
    expect(written).toContain('#123456')
  })
})

// ---------------------------------------------------------------------------
// 4. Honest refusal of the layer list itself
// ---------------------------------------------------------------------------

describe('FillSection — refused layer list', () => {
  it('renders one raw row, never a guessed split, for a top-level var()', () => {
    selectNode({ inlineStyles: { backgroundImage: 'var(--page-bg)' } })
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Custom (raw CSS)')

    fireEvent.click(screen.getByText('Custom (raw CSS)'))
    const popover = screen.getByRole('dialog', { name: 'Background image (raw CSS)' })
    const raw = within(popover).getByRole('textbox', { name: 'background-image, raw CSS' })
    fireEvent.change(raw, { target: { value: GRADIENT } })

    expect(currentNode()?.inlineStyles?.backgroundImage).toBe(GRADIENT)
  })
})

// ---------------------------------------------------------------------------
// 5. Solid fill is the BOTTOM-most paint
// ---------------------------------------------------------------------------

describe('FillSection — solid fill entry', () => {
  it('sits BELOW the image layers, and shows its own opacity field', () => {
    selectNode({ inlineStyles: { backgroundColor: '#ff0000', backgroundImage: GRADIENT } })
    render(<FillSection />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Linear gradient')
    expect(within(rows[1]!).getByRole('textbox', { name: 'Solid fill colour' })).toHaveProperty('value', '#ff0000')
    expect(within(rows[1]!).getByRole('textbox', { name: 'Solid fill opacity' })).toHaveProperty('value', '100')
  })

  it('commits a hex value typed directly into the row, with no popover', () => {
    selectNode({ inlineStyles: { backgroundColor: '#ff0000' } })
    render(<FillSection />)

    const input = screen.getByRole('textbox', { name: 'Solid fill colour' })
    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)

    expect(currentNode()?.inlineStyles?.backgroundColor).toBe('#00ff00')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the real colour picker on the FIRST click of the row swatch', () => {
    selectNode({ inlineStyles: { backgroundColor: '#ff0000' } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Solid fill colour swatch' }))

    // The picker's own title/value field are named after the FIELD
    // (`ariaLabel="Solid fill colour"`), distinct from the row-activation
    // popover's section-level "Solid fill" title used only for the refused
    // (`writeTarget.kind === 'none'`) case.
    const popover = screen.getByRole('dialog', { name: 'Solid fill colour' })
    expect(within(popover).getByRole('textbox', { name: 'Solid fill colour value' })).toBeTruthy()
  })

  it('"remove" clears backgroundColor', () => {
    selectNode({ inlineStyles: { backgroundColor: '#ff0000' } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: /remove solid fill/i }))
    expect(currentNode()?.inlineStyles?.backgroundColor).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. Content fit — the element's own replaced content
// ---------------------------------------------------------------------------

describe('FillSection — content fit entry', () => {
  it('surfaces a set objectFit as its own row, not as part of a background layer', () => {
    selectNode({ inlineStyles: { objectFit: 'cover' } })
    render(<FillSection />)
    const row = screen.getByRole('listitem')
    expect(row.textContent).toContain('Content fit')
  })

  it('"remove" clears both content-fit properties', () => {
    selectNode({ inlineStyles: { objectFit: 'cover', objectPosition: 'top' } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Content fit' }))
    expect(currentNode()?.inlineStyles?.objectFit).toBeUndefined()
    expect(currentNode()?.inlineStyles?.objectPosition).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 7. background shorthand escape hatch
// ---------------------------------------------------------------------------

describe('FillSection — background shorthand escape hatch', () => {
  const shorthand = 'red url(hero.png) no-repeat'

  it('shows as a row only when set, and opens a raw-CSS popover', () => {
    selectNode({ inlineStyles: { background: shorthand } })
    render(<FillSection />)

    fireEvent.click(screen.getByText(shorthand))
    const popover = screen.getByRole('dialog', { name: 'Background (raw CSS)' })
    const input = within(popover).getByRole('textbox', { name: /background, raw css/i })
    fireEvent.change(input, { target: { value: 'blue' } })

    expect(currentNode()?.inlineStyles?.background).toBe('blue')
  })

  it('"remove" clears the shorthand', () => {
    selectNode({ inlineStyles: { background: shorthand } })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: /remove background shorthand/i }))
    expect(currentNode()?.inlineStyles?.background).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Header add buttons (the old, separately-exported `FillSectionActions`)
// ---------------------------------------------------------------------------

describe('FillSection — header add buttons', () => {
  it('"add text colour" writes a concrete colour and reveals the row', () => {
    selectNode()
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: /add text colour/i }))
    expect(currentNode()?.inlineStyles?.color).toBe('#000000')
    expect(screen.getByRole('textbox', { name: 'Text colour' })).toHaveProperty('value', '#000000')
  })

  it('"add solid color fill" writes an opaque default colour', () => {
    selectNode()
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: /add solid color fill/i }))
    expect(currentNode()?.inlineStyles?.backgroundColor).toBe('#000000')
  })

  it('disables "add gradient fill" with a reason when the layer list was refused', () => {
    selectNode({ inlineStyles: { backgroundImage: 'var(--layers)' } })
    render(<FillSection />)
    const button = screen.getByRole('button', { name: /add gradient fill/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 9. Code-locked properties — the write is refused, never the whole row
// ---------------------------------------------------------------------------

describe('FillSection — code-locked properties', () => {
  it('refuses a backgroundColor write when backgroundColor is code-valued', () => {
    selectNode({ inlineStyles: { backgroundColor: '#ff0000' }, codeProps: ['style:backgroundColor'] })
    render(<FillSection />)

    fireEvent.click(screen.getByRole('button', { name: /remove solid fill/i }))
    expect(currentNode()?.inlineStyles?.backgroundColor).toBe('#ff0000')
  })
})

// ---------------------------------------------------------------------------
// 10. `STATE.md` panel-30 — Fill shows what actually renders, not only what
//     is stored. The user's own report: "if I choosed body, and the bg is
//     white I don't see that in the fill".
// ---------------------------------------------------------------------------

describe('FillSection — rendered, not stored', () => {
  it('a real, unstored background colour opens Fill, muted, with no remove button — the reported bug', () => {
    selectNode()
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.backgroundColor = 'rgb(255, 255, 255)'
    })
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    const input = within(row).getByRole('textbox', { name: 'Solid fill colour' })
    expect(input).toHaveProperty('value', 'rgb(255, 255, 255)')
    expect(row.dataset.muted).toBe('true')
    expect(screen.queryByRole('button', { name: /remove solid fill/i })).toBeNull()

    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)
    expect(currentNode()?.inlineStyles?.backgroundColor).toBe('#00ff00')
  })

  it('a bare focus/blur on the muted row commits nothing — the prefilled-field commit guard', () => {
    selectNode()
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.backgroundColor = 'rgb(255, 255, 255)'
    })
    render(<FillSection />)

    const input = screen.getByRole('textbox', { name: 'Solid fill colour' })
    fireEvent.focus(input)
    fireEvent.blur(input)

    expect(currentNode()?.inlineStyles?.backgroundColor).toBeUndefined()
  })

  it('stays collapsed for an element whose background is genuinely at its CSS initial (transparent) — no flood', () => {
    selectNode()
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.backgroundColor = 'transparent'
    })
    render(<FillSection />)

    expect(screen.getByText('Fill')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Fill' })).toBeNull()
  })

  it('opens a muted Text row for a TEXT node with an inherited colour and no stored color', () => {
    selectNode({ moduleId: 'base.text' })
    setUpCanvasFrame(NODE_ID, (el, frameDoc) => {
      el.style.backgroundColor = 'transparent'
      frameDoc.body.style.color = 'rgb(10, 20, 30)'
    })
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Text colour' })).toHaveProperty('value', 'rgb(10, 20, 30)')
    expect(row.dataset.muted).toBe('true')
    expect(within(row).queryByRole('button', { name: 'Remove Text' })).toBeNull()
  })

  it('stays collapsed for a NON-text node with the IDENTICAL inherited colour', () => {
    selectNode() // base.div — not a text node
    setUpCanvasFrame(NODE_ID, (el, frameDoc) => {
      el.style.backgroundColor = 'transparent'
      frameDoc.body.style.color = 'rgb(10, 20, 30)'
    })
    render(<FillSection />)

    expect(screen.queryByRole('list', { name: 'Fill' })).toBeNull()
  })

  it('shows the write-target refusal instead of a silently inert field when nothing can save it', () => {
    // `pkg.*` — inline styles are written by the package's own source
    // (`canWriteInlineStyleForModule`) — and no classIds, so no writable
    // class either: `resolveWriteTarget` has nowhere honest to land a write.
    selectNode({ moduleId: 'pkg.widget' })
    setUpCanvasFrame(NODE_ID, (el) => {
      el.style.backgroundColor = 'rgb(255, 255, 255)'
    })
    render(<FillSection />)

    fireEvent.click(screen.getByText('rgb(255, 255, 255)'))
    const popover = screen.getByRole('dialog', { name: 'Solid fill' })
    expect(within(popover).getByTestId('source-constraint-notice').textContent).toMatch(
      /has no writable class and its inline styles are locked/,
    )
    const input = within(popover).getByRole('textbox', { name: 'Solid fill colour' })
    expect(input).toHaveProperty('disabled', true)

    fireEvent.change(input, { target: { value: '#00ff00' } })
    fireEvent.blur(input)
    expect(currentNode()?.inlineStyles?.backgroundColor).toBeUndefined()
  })
})

describe('FillSection — computed-values loading state (Tier 2 bridge measurement)', () => {
  it('stays collapsed while the measurement is pending, then opens muted once it resolves', async () => {
    selectNode()
    const bridge = addBridgeFrame('desktop')
    render(<FillSection />)

    expect(bridge.hasPendingMeasure()).toBe(true)
    expect(screen.queryByRole('list', { name: 'Fill' })).toBeNull()

    act(() => {
      bridge.resolveFirstMeasure({ 'background-color': 'rgb(255, 255, 255)' })
    })

    await waitFor(() => expect(screen.getByRole('list', { name: 'Fill' })).toBeTruthy())
    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Solid fill colour' })).toHaveProperty('value', 'rgb(255, 255, 255)')
    expect(row.dataset.muted).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 11. `STATE.md` panel-32 — a class-declared value at BASE, with no override
//     at the active breakpoint/condition, is a DIFFERENT muted case from
//     panel-30's (something DOES declare it, just not at the active
//     context) — repro: a mobile project's `.title` class declares `color`
//     at base; the user is on a non-desktop breakpoint tab with no override
//     there. `FillSection.tsx`'s own `storedStyles` (context-only) reads
//     unset; `SelectionModel.provenanceByProperty` (effective chain) has a
//     real source, so the OLD single-argument predicate also read "stored,
//     not this predicate's problem" — the property fell through both checks.
// ---------------------------------------------------------------------------

function makeClass(id: string, overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id,
    name: 'title',
    kind: 'class',
    selector: '.title',
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

const TITLE_CLASS_ID = 'sc-af44e547b2'

/** A node carrying `TITLE_CLASS_ID`, on a store whose active breakpoint is `breakpointId`. */
function selectNodeWithBaseDeclaredClass(breakpointId: string) {
  setStudioStyleRuleSources(
    { [TITLE_CLASS_ID]: { file: 'pages/Onboarding.module.css', selector: '.title' } },
    {},
  )
  const page = makePage({
    id: 'page-1',
    rootNodeId: ROOT_ID,
    nodes: {
      [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
      [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.text', classIds: [TITLE_CLASS_ID] }),
    },
  })
  useEditorStore.setState({
    site: makeSite({
      pages: [page],
      styleRules: { [TITLE_CLASS_ID]: makeClass(TITLE_CLASS_ID, { styles: { color: 'var(--text-base-default)' } }) },
    }),
    activePageId: 'page-1',
    selectedNodeId: NODE_ID,
    activeBreakpointId: breakpointId,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('FillSection — declared at another context (panel-32)', () => {
  // `buildCollapsedCurrentStyles` (`collapsedStyleBag.ts`) prefers the
  // effective class chain's own literal declaration over the raw computed
  // value when one exists — the same rule every other migrated section's
  // popover already reads its own "current" fallback from (`StackedPropertyGrid`,
  // `ContentFitPopoverBody`, `OrphanSatellitesBody`). The muted row therefore
  // shows the real `var(--text-base-default)` token, not a resolved RGB — the
  // canvas frame's OWN computed colour only needs to be a real value (any
  // value) so `rendersUnstoredValue`'s `computedValue !== undefined` gate is
  // satisfied; it is not what gets displayed.
  it('a base-declared colour with no override at this breakpoint opens Fill, muted, and hides "Add text colour"', () => {
    selectNodeWithBaseDeclaredClass('mobile')
    setUpCanvasFrame(
      NODE_ID,
      (el) => {
        el.style.color = 'rgb(17, 17, 17)'
      },
      'mobile',
    )
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Text colour' })).toHaveProperty(
      'value',
      'var(--text-base-default)',
    )
    expect(row.dataset.muted).toBe('true')
    expect(within(row).queryByRole('button', { name: 'Remove Text' })).toBeNull()
    expect(screen.queryByRole('button', { name: /add text colour/i })).toBeNull()

    // Defect 2 (`STATE.md` panel-33) — measured live on this exact shape
    // (`pages/Onboarding.tsx`'s `.Onboarding_title__83213`, `color:
    // var(--text-base-default)`): the swatch paints the frame's RESOLVED
    // colour, never a blank well, while the field keeps the authored token.
    const swatchGlyph = within(row).getByRole('button', { name: 'Text colour swatch' }).querySelector('span')
    expect(swatchGlyph?.style.getPropertyValue('--color-token-option-value')).toBe('rgb(17, 17, 17)')
  })

  it("the picker's notice states a write saves a NEW override, and the write lands there — base is untouched", () => {
    selectNodeWithBaseDeclaredClass('mobile')
    setUpCanvasFrame(
      NODE_ID,
      (el) => {
        el.style.color = 'rgb(17, 17, 17)'
      },
      'mobile',
    )
    render(<FillSection />)

    // `STATE.md` panel-33 — the note used to live in an intermediate popover
    // reached by clicking the row; it now lives inside the REAL picker the
    // row's own swatch opens directly.
    fireEvent.click(screen.getByRole('button', { name: 'Text colour swatch' }))
    const popover = screen.getByRole('dialog', { name: 'Text colour' })
    expect(within(popover).getByTestId('source-constraint-notice').textContent).toMatch(
      /saves a new (override|declaration)/i,
    )

    // The picker seeded its model from the resolved `rgb(17, 17, 17)` it
    // opened on, so a value typed into its OWN internal field commits
    // reformatted to that model — the row's own outer field (exercised by
    // the "commits a hex value typed directly into the row" tests) is what
    // preserves whatever format the user types.
    const input = within(popover).getByRole('textbox', { name: 'Text colour value' })
    fireEvent.change(input, { target: { value: '#ff0000' } })
    fireEvent.blur(input)

    const rule = useEditorStore.getState().site?.styleRules[TITLE_CLASS_ID]
    expect(rule?.contextStyles.mobile?.color).toBe('rgb(255, 0, 0)')
    expect(rule?.styles.color).toBe('var(--text-base-default)')
  })

  it('an override already declared at the active context renders as a normal stored row, not muted', () => {
    setStudioStyleRuleSources(
      { [TITLE_CLASS_ID]: { file: 'pages/Onboarding.module.css', selector: '.title' } },
      {},
    )
    const page = makePage({
      id: 'page-1',
      rootNodeId: ROOT_ID,
      nodes: {
        [ROOT_ID]: makeNode({ id: ROOT_ID, moduleId: 'base.body', children: [NODE_ID] }),
        [NODE_ID]: makeNode({ id: NODE_ID, moduleId: 'base.text', classIds: [TITLE_CLASS_ID] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({
        pages: [page],
        styleRules: {
          [TITLE_CLASS_ID]: makeClass(TITLE_CLASS_ID, {
            styles: { color: 'var(--text-base-default)' },
            contextStyles: { mobile: { color: '#00ff00' } },
          }),
        },
      }),
      activePageId: 'page-1',
      selectedNodeId: NODE_ID,
      activeBreakpointId: 'mobile',
    } as Parameters<typeof useEditorStore.setState>[0])
    setUpCanvasFrame(
      NODE_ID,
      (el) => {
        el.style.color = 'rgb(0, 255, 0)'
      },
      'mobile',
    )
    render(<FillSection />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByRole('textbox', { name: 'Text colour' })).toHaveProperty('value', '#00ff00')
    expect(row.dataset.muted).toBeUndefined()
    expect(within(row).getByRole('button', { name: 'Remove Text' })).toBeTruthy()
  })
})
