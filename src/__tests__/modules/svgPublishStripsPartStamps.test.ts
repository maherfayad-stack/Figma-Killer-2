/**
 * SVG-3 — the parser stamps each element inside a literal `<svg>` with where
 * it is written (`data-studio-svg-part`). A published page is the user's
 * output, not Studio's: the `base.svg` render strips them.
 */
import { describe, expect, it } from 'bun:test'
import { registry } from '@core/module-engine'
import '@modules/base/svg'

describe('base.svg publish', () => {
  it('renders the graphic without Studio part stamps', () => {
    const svg = registry.get('base.svg')!
    const stamped =
      '<svg viewBox="0 0 8 8"><g data-studio-svg-part="4:8"><path data-studio-svg-part="5:10" data-studio-svg-code="d" d="M0 0"/></g></svg>'
    const out = svg.render!({ svg: stamped } as never, {} as never)
    expect(JSON.stringify(out)).not.toContain('data-studio-svg')
    expect(JSON.stringify(out)).toContain('<path d=\\"M0 0\\"/>')
  })
})
