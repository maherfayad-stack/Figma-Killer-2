import { describe, expect, it } from 'bun:test'
import { resolveCanvasAxisFromStyle, type CanvasAxisStyleInput } from '@site/canvas/canvasDomGeometry'

function style(overrides: Partial<CanvasAxisStyleInput> = {}): CanvasAxisStyleInput {
  return {
    display: 'block',
    flexDirection: 'row',
    gridAutoFlow: 'row',
    direction: 'ltr',
    ...overrides,
  }
}

describe('resolveCanvasAxisFromStyle (G9)', () => {
  it('defaults to vertical, not reversed, for ordinary block flow — regardless of direction', () => {
    expect(resolveCanvasAxisFromStyle(style())).toEqual({ axis: 'vertical', reversed: false })
    expect(resolveCanvasAxisFromStyle(style({ direction: 'rtl' }))).toEqual({
      axis: 'vertical',
      reversed: false,
    })
  })

  describe('flex', () => {
    it('row -> horizontal, not reversed', () => {
      expect(resolveCanvasAxisFromStyle(style({ display: 'flex', flexDirection: 'row' }))).toEqual({
        axis: 'horizontal',
        reversed: false,
      })
    })

    it('row-reverse -> horizontal, reversed (before/after must flip)', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'flex', flexDirection: 'row-reverse' })),
      ).toEqual({ axis: 'horizontal', reversed: true })
    })

    it('column -> vertical, not reversed', () => {
      expect(resolveCanvasAxisFromStyle(style({ display: 'flex', flexDirection: 'column' }))).toEqual({
        axis: 'vertical',
        reversed: false,
      })
    })

    it('column-reverse -> vertical, reversed', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'flex', flexDirection: 'column-reverse' })),
      ).toEqual({ axis: 'vertical', reversed: true })
    })

    it('row under RTL -> horizontal, reversed (visual-left is the logical end)', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'flex', flexDirection: 'row', direction: 'rtl' })),
      ).toEqual({ axis: 'horizontal', reversed: true })
    })

    it('row-reverse under RTL -> horizontal, NOT reversed (the two flips cancel out)', () => {
      expect(
        resolveCanvasAxisFromStyle(
          style({ display: 'flex', flexDirection: 'row-reverse', direction: 'rtl' }),
        ),
      ).toEqual({ axis: 'horizontal', reversed: false })
    })

    it('column-reverse under RTL is unaffected by direction — RTL only mirrors the inline axis', () => {
      expect(
        resolveCanvasAxisFromStyle(
          style({ display: 'flex', flexDirection: 'column-reverse', direction: 'rtl' }),
        ),
      ).toEqual({ axis: 'vertical', reversed: true })
    })

    it('an inline-flex container is still recognised (display includes "flex")', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'inline-flex', flexDirection: 'row' })),
      ).toEqual({ axis: 'horizontal', reversed: false })
    })
  })

  describe('grid', () => {
    it('default (row) autoflow -> horizontal — a strict improvement over the pre-G9 unconditional vertical', () => {
      expect(resolveCanvasAxisFromStyle(style({ display: 'grid', gridAutoFlow: 'row' }))).toEqual({
        axis: 'horizontal',
        reversed: false,
      })
    })

    it('column autoflow -> vertical', () => {
      expect(resolveCanvasAxisFromStyle(style({ display: 'grid', gridAutoFlow: 'column' }))).toEqual({
        axis: 'vertical',
        reversed: false,
      })
    })

    it('dense column autoflow ("column dense") -> vertical (substring match, not exact)', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'grid', gridAutoFlow: 'column dense' })),
      ).toEqual({ axis: 'vertical', reversed: false })
    })

    it('row autoflow under RTL -> horizontal, reversed', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'grid', gridAutoFlow: 'row', direction: 'rtl' })),
      ).toEqual({ axis: 'horizontal', reversed: true })
    })

    it('an inline-grid container is still recognised', () => {
      expect(
        resolveCanvasAxisFromStyle(style({ display: 'inline-grid', gridAutoFlow: 'row' })),
      ).toEqual({ axis: 'horizontal', reversed: false })
    })
  })
})
