/**
 * childPlacementPositions - a screen whose layers are all absolutely positioned
 * is a free frame even when one of them is a design-system component, whose
 * `display: contents` host reports `position: static` and renders the box that
 * holds the offsets. The screen in the audit (an absolute header, an absolute
 * banner and an absolute TabBar) read as flow because of that host, so a draw,
 * a drop and the Text tool wrote no position and landed at the frame's (0, 0).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { childPlacementPositions, parentPlacementKind } from '@core/studio-runtime'

afterEach(() => {
  document.body.innerHTML = ''
})

const view = () => document.defaultView as unknown as Window

describe('childPlacementPositions', () => {
  it('looks through a display: contents host to the box it renders', () => {
    document.body.innerHTML = `
      <main id="main" style="position:relative">
        <div style="position:absolute"></div>
        <div style="display:contents"><nav style="position:absolute"></nav></div>
        <div style="display:none"></div>
      </main>`
    const main = document.getElementById('main')!
    const positions = childPlacementPositions(view(), main)
    expect(positions).toEqual(['absolute', 'absolute'])
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, positions)).toBe('free-frame')
  })

  it('a host that renders an in-flow box keeps the screen a flow one', () => {
    document.body.innerHTML = `
      <main id="main" style="position:relative">
        <div style="position:absolute"></div>
        <div style="display:contents"><p></p></div>
      </main>`
    const positions = childPlacementPositions(view(), document.getElementById('main')!)
    expect(parentPlacementKind({ display: 'block', position: 'relative' }, positions)).toBe('flow')
  })
})
