import { describe, expect, it } from 'bun:test'
import { flowNudgeRefusalBody } from '@site/canvas/useCanvasNodeArrowKeys'

describe('flowNudgeRefusalBody', () => {
  it('a component call site is not said to render "no box" (its ring shows the box)', () => {
    const body = flowNudgeRefusalBody('unboxed', 'studio.instance')
    expect(body).toContain('component call site')
    expect(body).not.toContain('no box')
  })

  it('a display: contents element keeps the no-box explanation', () => {
    expect(flowNudgeRefusalBody('unboxed', 'alm.card')).toContain('display: contents')
  })

  it('other refusals are unchanged by the layer kind', () => {
    expect(flowNudgeRefusalBody('sticky', 'studio.instance')).toContain('sticky')
  })
})
