import { describe, expect, it } from 'bun:test'
import { coversFrame, isUnpainted, type ComputedPaint } from '@site/canvas/canvasBareWrapperProbe'

const bare: ComputedPaint = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  boxShadow: 'none',
  borderTopWidth: '0px',
  borderRightWidth: '0px',
  borderBottomWidth: '0px',
  borderLeftWidth: '0px',
}

describe('canvasBareWrapperProbe', () => {
  it('a layout-only div draws nothing', () => {
    expect(isUnpainted(bare)).toBe(true)
    expect(isUnpainted({ ...bare, backgroundColor: 'transparent' })).toBe(true)
  })
  it('any fill, image, shadow or border makes it a visible layer', () => {
    expect(isUnpainted({ ...bare, backgroundColor: 'rgb(255, 255, 255)' })).toBe(false)
    expect(isUnpainted({ ...bare, backgroundColor: 'rgba(0, 0, 0, 0.4)' })).toBe(false)
    expect(isUnpainted({ ...bare, backgroundImage: 'linear-gradient(red, blue)' })).toBe(false)
    expect(isUnpainted({ ...bare, boxShadow: 'rgba(0, 0, 0, 0.2) 0px 1px 2px' })).toBe(false)
    expect(isUnpainted({ ...bare, borderBottomWidth: '1px' })).toBe(false)
  })
  it('full-frame means nearly the whole screen box', () => {
    const frame = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 }
    expect(coversFrame({ ...frame }, frame)).toBe(true)
    expect(coversFrame({ ...frame, width: 200, right: 200 }, frame)).toBe(false)
    expect(coversFrame({ ...frame, height: 300, bottom: 300 }, frame)).toBe(false)
  })
})
