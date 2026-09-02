import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import { measureReference } from './referenceMeasure'
import { normalizeDesignVariableValue } from './designVariableNormalize'
import type { DesignVariable, DesignVariableSet } from './designVariableSchema'

/** Build a synthetic ingested set the way `ingestDesignVariables` would, without touching disk — `measureReference` only ever receives already-resolved sets, never reads the store itself. */
function variableSet(
  id: string,
  entries: ReadonlyArray<{ name: string; raw: string }>,
  meta: { pageId?: string; referenceId?: string } = {},
): DesignVariableSet {
  const variables: DesignVariable[] = entries.map(({ name, raw }) => {
    const normalized = normalizeDesignVariableValue(raw)
    return {
      name,
      raw,
      kind: normalized.kind,
      ...(normalized.hex ? { hex: normalized.hex } : {}),
      ...(normalized.px !== undefined ? { px: normalized.px } : {}),
      ...(normalized.unitAssumed ? { unitAssumed: true } : {}),
    }
  })
  return { id, ingestedAt: new Date().toISOString(), source: 'test fixture', ...meta, variables }
}

const ALM_CSS = `:root{
  --color-aqua-100:#0c9ab0;
  --color-metal:#1c1c1c;
  --type-display-size:34px;
  --type-headline-size:26px;
  --type-title-size:18px;
  --type-body-size:14px;
}`

/**
 * A synthetic "comp": white paper with solid dark bars standing in for text
 * lines. A bar's height is exactly the ink extent a real line of type would
 * present, which is the only thing the measurer reads off rows — so the
 * arithmetic under test is exercised without depending on a font being
 * installed on the machine running the suite.
 */
async function comp(options: {
  width: number
  height: number
  bars: Array<{ top: number; height: number }>
  ink?: [number, number, number]
  paper?: [number, number, number]
}): Promise<Uint8Array> {
  const { width, height, bars, ink = [28, 28, 28], paper = [255, 255, 255] } = options
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    raw[i * 3] = paper[0]
    raw[i * 3 + 1] = paper[1]
    raw[i * 3 + 2] = paper[2]
  }
  for (const bar of bars) {
    for (let y = bar.top; y < bar.top + bar.height && y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3
        raw[i] = ink[0]
        raw[i + 1] = ink[1]
        raw[i + 2] = ink[2]
      }
    }
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer())
}

describe('measureReference', () => {
  it('reports lengths in CSS px, not reference px', async () => {
    // THE regression this module exists to prevent. A 2x export holds a
    // 20 CSS px ink extent as 40 pixels. Reporting 40 would replace an
    // eyeballed error with a measured one twice the size.
    const bytes = await comp({ width: 786, height: 200, bars: [{ top: 20, height: 40 }] })

    const { regions } = await measureReference(
      bytes,
      [{ label: 'heading', x: 0, y: 0, width: 786, height: 200 }],
      { cssScale: 393 / 786, cssSources: [ALM_CSS] },
    )

    const heading = regions[0]!
    expect(heading.label).toBe('heading')
    expect(heading.lines).toHaveLength(1)
    expect(heading.lines[0]!.inkHeightPx).toBeCloseTo(20, 1)
    // The un-scaled answer would have been 40 — assert it is NOT that.
    expect(heading.lines[0]!.inkHeightPx).not.toBeCloseTo(40, 1)
  })

  it('brackets the font size between the cap-height and ascender assumptions', async () => {
    const bytes = await comp({ width: 786, height: 200, bars: [{ top: 20, height: 40 }] })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 786, height: 200 }],
      { cssScale: 0.5, cssSources: [ALM_CSS] },
    )

    const size = regions[0]!.fontSizePx!
    // 20 CSS px of ink: cap-height assumption 20/0.72, ascender 20/0.95.
    expect(size.capAssumption).toBeCloseTo(27.8, 0)
    expect(size.ascenderAssumption).toBeCloseTo(21.1, 0)
    // A range, never a single confident number — a raster cannot say which.
    expect(size.ascenderAssumption).toBeLessThan(size.capAssumption)
  })

  it('always attaches a caveat naming the range as a Latin-sans estimate (A8)', async () => {
    // The ratios this range is built from are calibrated for a Latin UI sans
    // face and are silently wrong for a serif/display face or a non-Latin
    // script — this must never be a bare confident range.
    const bytes = await comp({ width: 786, height: 200, bars: [{ top: 20, height: 40 }] })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 786, height: 200 }],
      { cssScale: 0.5, cssSources: [ALM_CSS] },
    )

    const caveat = regions[0]!.fontSizePx!.caveat
    expect(typeof caveat).toBe('string')
    expect(caveat.length).toBeGreaterThan(0)
    expect(caveat).toContain('Latin')
    expect(caveat).toContain('non-Latin')
  })

  it('names the nearest type token for the measurement, not for the role', async () => {
    // A screen title whose ink is 15 CSS px — the real case. Measured, the
    // nearest token is title/headline by VALUE; the failure being guarded is
    // an agent reaching for `--type-headline-size` because "headline" sounds
    // like a heading.
    const bytes = await comp({ width: 786, height: 200, bars: [{ top: 10, height: 30 }] })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 786, height: 200 }],
      { cssScale: 0.5, cssSources: [ALM_CSS] },
    )

    const nearest = regions[0]!.fontSizePx!.nearestToken!
    expect(nearest.name).toMatch(/^--type-/)
    expect(typeof nearest.deltaPx).toBe('number')
    expect(nearest.px).toBeGreaterThan(0)
  })

  it('measures line-height from line pitch, with no assumption', async () => {
    const bytes = await comp({
      width: 400,
      height: 300,
      bars: [
        { top: 20, height: 20 },
        { top: 80, height: 20 },
      ],
    })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 300 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )

    expect(regions[0]!.lines).toHaveLength(2)
    expect(regions[0]!.lineHeightPx).toBeCloseTo(60, 0)
  })

  it('has no line-height to report from a single line', async () => {
    const bytes = await comp({ width: 400, height: 200, bars: [{ top: 20, height: 20 }] })
    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )
    expect(regions[0]!.lineHeightPx).toBeNull()
  })

  it('separates ink from paper and matches both against project tokens', async () => {
    const bytes = await comp({
      width: 400,
      height: 200,
      bars: [{ top: 80, height: 40 }],
      ink: [12, 154, 176], // --color-aqua-100
      paper: [255, 255, 255],
    })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )

    const region = regions[0]!
    expect(region.background.hex).toBe('#ffffff')
    // EXACT, not the bucket centre. Colours are grouped into buckets so
    // antialiasing cannot push the real fill out of the ranking, but the
    // value reported is the modal exact colour inside the winning bucket.
    // `#0c9ab0` buckets to a centre of `#1098b0`; reporting that would be a
    // measurement the agent might write into a stylesheet as a raw hex —
    // an error introduced by the instrument meant to remove it.
    expect(region.foreground?.hex).toBe('#0c9ab0')
    expect(region.foreground?.hex).not.toBe('#1098b0')
    expect(region.foreground?.token?.name).toBe('--color-aqua-100')
    expect(region.contrastRatio).toBeGreaterThan(1)
  })

  it('offers no token when the measured colour is not one the project has', async () => {
    // The case the prompt allows a raw value for. Reporting a far-off token
    // here would be worse than reporting none.
    const bytes = await comp({
      width: 400,
      height: 200,
      bars: [{ top: 80, height: 40 }],
      ink: [200, 40, 190],
    })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )

    expect(regions[0]!.foreground?.token).toBeUndefined()
  })

  it('reports a flat region as having no foreground rather than inventing one', async () => {
    const bytes = await comp({ width: 200, height: 100, bars: [] })
    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 200, height: 100 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )
    expect(regions[0]!.foreground).toBeNull()
    expect(regions[0]!.contrastRatio).toBeNull()
    expect(regions[0]!.fontSizePx).toBeNull()
  })

  it('clamps a region that runs past the edge instead of failing the call', async () => {
    // A caller reading coordinates off a scaled view is routinely a few
    // pixels out; refusing the whole measurement for that would be useless.
    const bytes = await comp({ width: 200, height: 100, bars: [{ top: 10, height: 20 }] })
    const { regions } = await measureReference(
      bytes,
      [{ x: 150, y: 50, width: 500, height: 500 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )
    expect(regions).toHaveLength(1)
    expect(regions[0]!.background.hex).toBe('#ffffff')
  })

  it('measures every region independently', async () => {
    const bytes = await comp({
      width: 400,
      height: 400,
      bars: [{ top: 20, height: 20 }],
    })
    const { regions } = await measureReference(
      bytes,
      [
        { label: 'top', x: 0, y: 0, width: 400, height: 100 },
        { label: 'bottom', x: 0, y: 200, width: 400, height: 100 },
      ],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )
    expect(regions.map((r) => r.label)).toEqual(['top', 'bottom'])
    expect(regions[0]!.lines).toHaveLength(1)
    expect(regions[1]!.lines).toHaveLength(0)
  })

  it('still returns measurements when the project has no tokens at all', async () => {
    const bytes = await comp({ width: 200, height: 100, bars: [{ top: 10, height: 20 }] })
    const { regions, tokenIndex } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 200, height: 100 }],
      { cssScale: 1, cssSources: [] },
    )
    expect(tokenIndex.colorCount).toBe(0)
    expect(regions[0]!.background.hex).toBe('#ffffff')
    expect(regions[0]!.fontSizePx?.nearestToken).toBeNull()
  })
})

describe('measureReference — design-variable three-way mapping', () => {
  it('honesty: with no design-variable sets, every designVariable field is absent and the index reports zero', async () => {
    const bytes = await comp({
      width: 400,
      height: 200,
      bars: [{ top: 80, height: 40 }],
      ink: [12, 154, 176], // --color-aqua-100, exact
    })

    const { regions, designVariableIndex } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [ALM_CSS] },
    )

    expect(designVariableIndex).toEqual({ setCount: 0, colorCount: 0, sizeCount: 0 })
    expect(regions[0]!.foreground?.designVariable).toBeUndefined()
    expect(regions[0]!.background.designVariable).toBeUndefined()
    expect(regions[0]!.fontSizePx?.designVariable).toBeUndefined()
    // Direct pixel -> project token matching is completely unaffected.
    expect(regions[0]!.foreground?.token?.name).toBe('--color-aqua-100')
  })

  it('measured -> design variable -> project token: names the design\'s own value, and says plainly when the project has no matching token', async () => {
    // The design declares "coral/100" = #EF4550. The project has no coral
    // token at all — only the unrelated aqua/metal tokens from ALM_CSS.
    const sets = [variableSet('set-1', [{ name: 'coral/100', raw: '#EF4550' }])]
    const bytes = await comp({
      width: 400,
      height: 200,
      bars: [{ top: 80, height: 40 }],
      ink: [239, 69, 80], // #ef4550, exact
    })

    const { regions, designVariableIndex } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [ALM_CSS], designVariableSets: sets },
    )

    expect(designVariableIndex).toEqual({ setCount: 1, colorCount: 1, sizeCount: 0 })
    const fg = regions[0]!.foreground!
    // No project token is close to coral — the honest "no token covers this".
    expect(fg.token).toBeUndefined()
    // But the design variable itself is named exactly.
    expect(fg.designVariable?.name).toBe('coral/100')
    expect(fg.designVariable?.value).toBe('#EF4550')
    expect(fg.designVariable?.hex).toBe('#ef4550')
    expect(fg.designVariable?.deltaE).toBeCloseTo(0, 1)
    expect(fg.designVariable?.source).toBe('test fixture')
    expect(fg.designVariable?.setId).toBe('set-1')
    // And it says plainly that nothing in the project covers it either.
    expect(fg.designVariable?.projectToken).toBeUndefined()
  })

  it('measured -> design variable -> project token: resolves the DECLARED value\'s own token, not the noisy pixel\'s', async () => {
    // Project now has the coral token, and the design's declared value is the
    // exact same hex.
    const CSS_WITH_CORAL = `${ALM_CSS.slice(0, -1)}--alm-coral-100:#ef4550;}`
    const sets = [variableSet('set-2', [{ name: 'coral/100', raw: '#EF4550' }])]
    // Ink is a couple of RGB steps off the exact value — real-world JPEG
    // noise — close enough to match both independently, but this is the
    // shape a caller reads: two SEPARATE matches (direct pixel -> token,
    // and pixel -> variable -> variable's OWN value -> token) that happen to
    // agree here because both are within range of the same true colour.
    const bytes = await comp({
      width: 400,
      height: 200,
      bars: [{ top: 80, height: 40 }],
      ink: [237, 71, 82],
    })

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 400, height: 200 }],
      { cssScale: 1, cssSources: [CSS_WITH_CORAL], designVariableSets: sets },
    )

    const fg = regions[0]!.foreground!
    expect(fg.designVariable?.name).toBe('coral/100')
    // The project token is resolved from the VARIABLE's declared #ef4550,
    // not from the measured pixel — so it is an EXACT match (deltaE ~ 0)
    // even though the pixel itself was slightly off.
    expect(fg.designVariable?.projectToken?.name).toBe('--alm-coral-100')
    expect(fg.designVariable?.projectToken?.deltaE).toBeCloseTo(0, 1)
  })

  it('measured -> design variable -> project token, for a SIZE: a bare unit-less number is flagged unitAssumed and still resolves', async () => {
    // Screen title ink, same shape as the "names the nearest type token"
    // test above: 15 CSS px of ink -> midpoint ~18.3, nearest project token
    // --type-title-size (18px).
    const bytes = await comp({ width: 786, height: 200, bars: [{ top: 10, height: 30 }] })
    const sets = [variableSet('set-3', [{ name: 'type/title', raw: '18' }])]

    const { regions } = await measureReference(
      bytes,
      [{ x: 0, y: 0, width: 786, height: 200 }],
      { cssScale: 0.5, cssSources: [ALM_CSS], designVariableSets: sets },
    )

    const dv = regions[0]!.fontSizePx!.designVariable!
    expect(dv.name).toBe('type/title')
    expect(dv.value).toBe('18')
    expect(dv.px).toBe(18)
    expect(dv.unitAssumed).toBe(true)
    // Resolved from the variable's OWN 18px, exactly matching the project's
    // 18px token — not from either bound of the measured range.
    expect(dv.projectToken?.name).toBe('--type-title-size')
    expect(dv.projectToken?.deltaPx).toBe(0)
  })
})
