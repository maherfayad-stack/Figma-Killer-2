/**
 * P5-G G1 — a registry module dropped on the empty board becomes a loose
 * layer, spelled exactly as an insert into a page would spell it
 * (`moduleSourceElement`, the one spelling both writers share).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { registry, type AnyModuleDefinition } from '@core/module-engine'
import { moduleSourceElement } from '@site/store/slices/site/moduleSourceElement'
import { canPlaceModuleOnCanvas, placeModuleOnCanvas } from '@site/hooks/placeModuleOnCanvas'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

const DS_BUTTON = 'dstest.Button'
const PKG_CHIP = 'dstest.Chip'
const EDITOR_ONLY = 'dstest.Loop'

function testModule(id: string, extra: Partial<AnyModuleDefinition>): AnyModuleDefinition {
  return {
    id,
    name: id,
    category: 'Test',
    version: '1.0.0',
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: () => ({ html: '<div></div>' }),
    ...extra,
  } as AnyModuleDefinition
}

const createCanvasLayer = mock((_element: unknown, _at: unknown): string | null => 'layer-1')
const realCreateCanvasLayer = useEditorStore.getState().createCanvasLayer

beforeEach(() => {
  registry.registerOrReplace(testModule(DS_BUTTON, {
    defaults: { label: 'Label', variant: 'primary', onClick: () => undefined },
    sourceImport: { kind: 'design-system', name: 'Button' },
  }))
  registry.registerOrReplace(testModule(PKG_CHIP, {
    defaults: { label: 'Chip' },
    sourceImport: { kind: 'package', specifier: '@acme/ui', name: 'Chip' },
  }))
  registry.registerOrReplace(testModule(EDITOR_ONLY, {}))
  createCanvasLayer.mockClear()
  useEditorStore.setState({ createCanvasLayer } as unknown as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  useEditorStore.setState({ createCanvasLayer: realCreateCanvasLayer } as unknown as Parameters<typeof useEditorStore.setState>[0])
  registry.unregister(DS_BUTTON)
  registry.unregister(PKG_CHIP)
  registry.unregister(EDITOR_ONLY)
})

describe('moduleSourceElement', () => {
  it('spells a built-in design-system component by name, with only its writable defaults', () => {
    expect(moduleSourceElement(DS_BUTTON, undefined)).toEqual({
      name: 'Button',
      designSystemImport: true,
      props: { label: 'Label', variant: 'primary' },
      intrinsic: false,
    })
  })

  it('spells a package component with its specifier, the caller overrides layered on the defaults', () => {
    expect(moduleSourceElement(PKG_CHIP, { label: 'New' })).toEqual({
      name: 'Chip',
      importSpecifier: '@acme/ui',
      props: { label: 'New' },
      intrinsic: false,
    })
  })

  it('spells an intrinsic element by its tag, with its text as children and only the inline styles as props', () => {
    const text = moduleSourceElement('base.text', { text: 'Hello' }, { color: 'red' })
    expect(text).toEqual({ name: 'p', props: { style: { color: 'red' } }, children: 'Hello', intrinsic: true })
  })

  it('has no spelling for an editor construct', () => {
    expect(moduleSourceElement(EDITOR_ONLY, undefined)).toBeNull()
    expect(moduleSourceElement('nope.missing', undefined)).toBeNull()
  })
})

describe('placeModuleOnCanvas', () => {
  it('creates one loose layer whose root is the component, at the drop point', () => {
    expect(canPlaceModuleOnCanvas(DS_BUTTON)).toBe(true)
    expect(placeModuleOnCanvas(DS_BUTTON, undefined, { x: 120, y: -40 })).toBe(true)
    expect(createCanvasLayer).toHaveBeenCalledTimes(1)
    expect(createCanvasLayer.mock.calls[0]).toEqual([
      { name: 'Button', designSystemImport: true, props: { label: 'Label', variant: 'primary' } },
      { x: 120, y: -40 },
    ])
  })

  it('gives an empty intrinsic box a size, so the layer is visible and can be grabbed', () => {
    expect(placeModuleOnCanvas('base.container', undefined, { x: 0, y: 0 })).toBe(true)
    const [element] = createCanvasLayer.mock.calls[0] as [{ name: string; props: Record<string, unknown> }]
    expect(element.name).toBe('div')
    expect(element.props).toEqual({ style: { width: '100px', height: '100px' } })
  })

  it('refuses an editor construct without writing anything', () => {
    expect(canPlaceModuleOnCanvas(EDITOR_ONLY)).toBe(false)
    expect(placeModuleOnCanvas(EDITOR_ONLY, undefined, { x: 0, y: 0 })).toBe(false)
    expect(createCanvasLayer).not.toHaveBeenCalled()
  })

  it('reports false when there is no board to put it on', () => {
    createCanvasLayer.mockImplementationOnce(() => null)
    expect(placeModuleOnCanvas(DS_BUTTON, undefined, { x: 0, y: 0 })).toBe(false)
  })
})
