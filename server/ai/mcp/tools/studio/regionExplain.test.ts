/**
 * regionExplain — the colour sentence attached to a differing region.
 *
 * Two properties carry the whole value: it must NAME the colour in the
 * project's own vocabulary when that vocabulary has a name for it, and it
 * must stay silent when the two sides' fills agree. Silence is the load-
 * bearing half — a colour sentence on a region that differs because it MOVED
 * would send the agent to recolour something already correct, which is worse
 * than a bare rectangle.
 */
import { describe, expect, it } from 'bun:test'
import { PNG } from 'pngjs'
import { buildDesignVariableIndex } from '../../../../handlers/studio/designVariableIndex'
import { buildProjectTokenIndex } from '../../../../handlers/studio/projectTokenIndex'
import { decodePngBuffer, type DiffRegion } from './frameDiffEngine'
import { explainRegionColors } from './regionExplain'

const W = 40
const H = 40

function solid(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const png = new PNG({ width: W, height: H })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r
    png.data[i + 1] = g
    png.data[i + 2] = b
    png.data[i + 3] = 255
  }
  return decodePngBuffer(PNG.sync.write(png), 'test')
}

const REGION: DiffRegion = { x: 0, y: 0, width: W, height: H, diffPixels: W * H, diffPercent: 100, frameCoveragePercent: 100, nodeIds: ['n1'] }

/** A design whose `coral/100` is the reference colour, and a project whose `--color-danger` carries the same value while `--color-primary` carries the wrong one the screen actually rendered. */
const designVariables = buildDesignVariableIndex([
  {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'figma',
    createdAt: '2026-01-01T00:00:00.000Z',
    variables: [{ name: 'coral/100', raw: '#EF4550', kind: 'color', hex: '#ef4550' }],
  },
])
const projectTokens = buildProjectTokenIndex(':root { --color-danger: #ef4550; --color-primary: #3b82f6; }')

describe('explainRegionColors', () => {
  it('names the design variable the reference colour is, and the token the screen actually rendered', () => {
    const [region] = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), [REGION], { designVariables, projectTokens })
    const explanation = region!.colorExplanation
    expect(explanation).toBeDefined()
    expect(explanation!.referenceHex).toBe('#ef4550')
    expect(explanation!.currentHex).toBe('#3b82f6')
    expect(explanation!.referenceVariable?.name).toBe('coral/100')
    expect(explanation!.currentToken?.name).toBe('--color-primary')
    expect(explanation!.referenceToken?.name).toBe('--color-danger')
    expect(explanation!.message).toContain('coral/100')
    expect(explanation!.message).toContain('var(--color-primary)')
    expect(explanation!.message).toContain('var(--color-danger)')
  })

  it('says nothing when both sides fill the region with the same colour — that region moved, it is not miscoloured', () => {
    const [region] = explainRegionColors(solid('#ef4550'), solid('#ef4550'), [REGION], { designVariables, projectTokens })
    expect(region!.colorExplanation).toBeUndefined()
  })

  it('still names both hex values with no design variables and no project tokens at all', () => {
    const [region] = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), [REGION], {})
    expect(region!.colorExplanation!.message).toContain('#ef4550')
    expect(region!.colorExplanation!.message).toContain('#3b82f6')
    expect(region!.colorExplanation!.referenceVariable).toBeUndefined()
    expect(region!.colorExplanation!.currentToken).toBeUndefined()
  })

  it('says the token is missing rather than inventing one when the design colour has no project token', () => {
    const noMatch = buildProjectTokenIndex(':root { --color-primary: #3b82f6; }')
    const [region] = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), [REGION], { designVariables, projectTokens: noMatch })
    expect(region!.colorExplanation!.referenceToken).toBeUndefined()
    expect(region!.colorExplanation!.message).toContain('add the token')
  })

  it('leaves the region shape untouched — the explanation is additive, never a replacement', () => {
    const [region] = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), [REGION], { designVariables, projectTokens })
    expect(region!.nodeIds).toEqual(['n1'])
    expect(region!.diffPixels).toBe(W * H)
    expect(region!.frameCoveragePercent).toBe(100)
  })

  it('explains only the worst few regions — an explanation per region of a 20-region result is payload nobody reads', () => {
    const many = Array.from({ length: 8 }, () => REGION)
    const explained = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), many, { designVariables, projectTokens })
    expect(explained.filter((r) => r.colorExplanation !== undefined)).toHaveLength(5)
  })

  it('tolerates a region rectangle that runs past the image edge rather than reading out of bounds', () => {
    const outside: DiffRegion = { ...REGION, x: W - 5, y: H - 5, width: 100, height: 100 }
    const [region] = explainRegionColors(solid('#3b82f6'), solid('#ef4550'), [outside], { designVariables, projectTokens })
    expect(region!.colorExplanation).toBeDefined()
  })
})
