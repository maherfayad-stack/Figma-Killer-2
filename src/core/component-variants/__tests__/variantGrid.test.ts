import { describe, expect, it } from 'bun:test'
import { MAX_GALLERY_CELLS, planVariantGrid, type GalleryAxisInput } from '..'

const variant: GalleryAxisInput = { name: 'variant', kind: 'enum', members: ['primary', 'ghost', 'danger'], defaultValue: 'primary' }
const size: GalleryAxisInput = { name: 'size', kind: 'enum', members: ['sm', 'md'] }
const disabled: GalleryAxisInput = { name: 'disabled', kind: 'boolean', members: [] }

describe('planVariantGrid', () => {
  it('is the cartesian product, last axis varying fastest, labelled by axis values', () => {
    const plan = planVariantGrid([variant, size, disabled])!
    expect(plan.total).toBe(12)
    expect(plan.cells).toHaveLength(12)
    expect(plan.pinned).toEqual([])
    expect(plan.cells[0]!.label).toBe('variant=primary, size=sm, disabled=false')
    expect(plan.cells[1]!.label).toBe('variant=primary, size=sm, disabled=true')
    expect(plan.cells[2]!.label).toBe('variant=primary, size=md, disabled=false')
    expect(plan.cells[11]!.values).toEqual({ variant: 'danger', size: 'md', disabled: true })
    // every combination exactly once
    expect(new Set(plan.cells.map((cell) => cell.label)).size).toBe(12)
  })

  it('has nothing to show without an axis of two or more values', () => {
    expect(planVariantGrid([])).toBeNull()
    expect(planVariantGrid([{ name: 'tone', kind: 'enum', members: ['only'] }])).toBeNull()
  })

  it('caps at 24 cells and pins the axes that would overflow to their default', () => {
    const tone: GalleryAxisInput = { name: 'tone', kind: 'enum', members: ['a', 'b', 'c', 'd'], defaultValue: 'c' }
    const density: GalleryAxisInput = { name: 'density', kind: 'enum', members: ['x', 'y', 'z'] }
    // 3 * 4 * 3 * 2 = 72 combinations
    const plan = planVariantGrid([variant, tone, density, disabled])!
    expect(plan.total).toBe(72)
    expect(plan.cells.length).toBeLessThanOrEqual(MAX_GALLERY_CELLS)
    expect(plan.axes.map((axis) => axis.name)).toEqual(['variant', 'tone', 'disabled'])
    expect(plan.pinned).toEqual([{ name: 'density', value: 'x' }])
    // a pinned axis is still given to every cell, so the render is deterministic
    expect(plan.cells.every((cell) => cell.values.density === 'x')).toBe(true)
  })

  it('pins to the declared default when it is a member, else the first member / false', () => {
    const big: GalleryAxisInput = { name: 'big', kind: 'enum', members: Array.from({ length: 8 }, (_, i) => `m${i}`) }
    const mid: GalleryAxisInput = { name: 'mid', kind: 'enum', members: ['p', 'q', 'r'], defaultValue: 'r' }
    const flag: GalleryAxisInput = { name: 'flag', kind: 'boolean', members: [], defaultValue: true }
    const plan = planVariantGrid([big, mid, flag])!
    // 8 x 3 = 24 fits; the boolean would double it, so it is held at its declared default.
    expect(plan.cells).toHaveLength(24)
    expect(plan.pinned).toEqual([{ name: 'flag', value: true }])
    const none = planVariantGrid([big, { name: 'a', kind: 'enum', members: ['x', 'y', 'z'] }, { name: 'z', kind: 'enum', members: ['k', 'l', 'm'], defaultValue: 'nope' }])!
    expect(none.pinned).toEqual([{ name: 'z', value: 'k' }])
  })

  it('shows the first members of a lone axis larger than the cap, and reports the true total', () => {
    const huge: GalleryAxisInput = { name: 'icon', kind: 'enum', members: Array.from({ length: 40 }, (_, i) => `i${i}`) }
    const plan = planVariantGrid([huge, disabled])!
    expect(plan.cells).toHaveLength(MAX_GALLERY_CELLS)
    expect(plan.total).toBe(80)
    expect(plan.pinned).toEqual([{ name: 'disabled', value: false }])
  })
})
