import { describe, expect, it } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import { lengthText, lengthValue, opacityChange, previousValues, readLayerStyle, strokeChange, styleChange } from '../layerStyleModel'

const node = (inlineStyles: Record<string, unknown>): PageNode =>
  ({ id: 'n', moduleId: 'base.container', props: {}, children: [], classIds: [], breakpointOverrides: {}, inlineStyles }) as PageNode

describe('layerStyleModel', () => {
  it('reads the draw tool’s own inline styles', () => {
    const reading = readLayerStyle(node({ width: '100px', height: 100, background: '#d9d9d9', border: '1px solid #808080', opacity: '0.25' }))
    expect(reading).toMatchObject({
      width: '100px',
      height: '100px',
      fill: '#d9d9d9',
      fillKey: 'background',
      stroke: { width: '1', color: '#808080' },
      opacityPercent: '25',
    })
  })

  it('writes a fill where the value already lives', () => {
    expect(readLayerStyle(node({ backgroundColor: 'red' })).fillKey).toBe('backgroundColor')
  })

  it('a border it cannot split is custom, so the controls leave it alone', () => {
    expect(readLayerStyle(node({ border: '2px dashed red' })).stroke).toBe('custom')
    expect(readLayerStyle(node({})).stroke).toBeNull()
  })

  it('a typed length is pixels unless it names a unit', () => {
    expect(lengthValue('12')).toBe('12px')
    expect(lengthValue('50%')).toBe('50%')
    expect(lengthValue('  ')).toBeNull()
    expect(lengthText('12px')).toBe('12')
    expect(lengthText('50%')).toBe('50%')
  })

  it('stroke, opacity and removal become one change each', () => {
    expect(strokeChange({ width: '3', color: 'blue' })).toEqual({ set: { border: '3px solid blue' }, remove: [] })
    expect(strokeChange({ width: '', color: 'blue' }).set.border).toBe('1px solid blue')
    expect(strokeChange(null)).toEqual({ set: {}, remove: ['border'] })
    expect(opacityChange('50')).toEqual({ set: { opacity: '0.5' }, remove: [] })
    expect(opacityChange('100')).toEqual({ set: {}, remove: ['opacity'] })
    expect(opacityChange('abc')).toBeNull()
    expect(styleChange('width', null)).toEqual({ set: {}, remove: ['width'] })
  })

  it('the inverse remembers what the change overwrites, absent properties as undefined', () => {
    const change = { set: { background: 'red' }, remove: ['border'] }
    expect(previousValues(node({ background: '#fff' }), change)).toEqual({ background: '#fff', border: undefined })
  })
})
