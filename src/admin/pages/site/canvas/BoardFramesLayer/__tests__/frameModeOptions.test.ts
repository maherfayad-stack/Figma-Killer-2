import { describe, expect, it } from 'bun:test'
import { DEFAULT_PREVIEW_AXES } from '@core/studio-board'
import type { ModeAxis } from '@core/studio-tokens'
import { frameModeChips, frameModeVariants } from '../frameModeOptions'

const scheme: ModeAxis = { id: 'color-scheme', label: 'Color scheme', modes: [{ id: 'dark', label: 'Dark', gate: { kind: 'class', className: 'dark' } }] }
const density: ModeAxis = {
  id: 'density',
  label: 'Density',
  modes: [{ id: 'compact', label: 'compact', gate: { kind: 'attr', attr: 'data-density', value: 'compact' } }],
}
const width: ModeAxis = {
  id: 'breakpoint',
  label: 'Breakpoint',
  modes: [{ id: '(min-width: 768px)', label: 'wide', gate: { kind: 'media', query: '(min-width: 768px)' } }],
}

describe('frameModeChips', () => {
  it('a chip per emulable axis, naming the mode the frame is on', () => {
    const chips = frameModeChips([scheme, density, width], { ...DEFAULT_PREVIEW_AXES, colorScheme: 'dark' })
    expect(chips.map((c) => [c.axisId, c.current.label])).toEqual([
      ['color-scheme', 'Dark'],
      ['density', 'Default'],
    ])
  })

  it('no chip for a project that declares no mode', () => {
    expect(frameModeChips([], DEFAULT_PREVIEW_AXES)).toEqual([])
    expect(frameModeChips([width], DEFAULT_PREVIEW_AXES)).toEqual([])
  })
})

describe('frameModeVariants ("+ Mode")', () => {
  it('offers the other mode of a single axis, pinned on top of what the source already pins', () => {
    const chips = frameModeChips([scheme], DEFAULT_PREVIEW_AXES)
    const variants = frameModeVariants(chips, { direction: 'rtl' })
    expect(variants).toEqual([{ axisId: 'color-scheme', label: 'Dark', axes: { direction: 'rtl', colorScheme: 'dark' } }])
  })

  it('prefixes the axis name once there is more than one axis, and never offers the current mode', () => {
    const chips = frameModeChips([scheme, density], { ...DEFAULT_PREVIEW_AXES, colorScheme: 'dark' })
    expect(frameModeVariants(chips, undefined).map((v) => v.label)).toEqual(['Color scheme: Light', 'Density: compact'])
  })
})
