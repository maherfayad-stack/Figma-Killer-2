import { describe, expect, test } from 'bun:test'
import { DEVICE_PRESETS, findMatchingPreset } from '../devicePresets'

describe('DEVICE_PRESETS', () => {
  test('every entry has a positive width and height', () => {
    for (const preset of DEVICE_PRESETS) {
      expect(preset.width).toBeGreaterThan(0)
      expect(preset.height).toBeGreaterThan(0)
      expect(preset.group.length).toBeGreaterThan(0)
      expect(preset.name.length).toBeGreaterThan(0)
    }
  })

  test('includes iPhone 16 at 393x852 (Apple group)', () => {
    expect(DEVICE_PRESETS).toContainEqual({
      group: 'Apple',
      name: 'iPhone 16',
      width: 393,
      height: 852,
    })
  })

  test('includes iPad Pro 11in at 834x1194 (Apple group)', () => {
    expect(DEVICE_PRESETS).toContainEqual({
      group: 'Apple',
      name: 'iPad Pro 11in',
      width: 834,
      height: 1194,
    })
  })

  test('includes Web 1280 at 1280x800 (Web group)', () => {
    expect(DEVICE_PRESETS).toContainEqual({
      group: 'Web',
      name: 'Web 1280',
      width: 1280,
      height: 800,
    })
  })

  test('includes Print A4 at 794x1123 (Print group)', () => {
    expect(DEVICE_PRESETS).toContainEqual({
      group: 'Print (96dpi)',
      name: 'A4',
      width: 794,
      height: 1123,
    })
  })

  test('covers the seven documented groups, in order, with no duplicates', () => {
    const seen: string[] = []
    for (const preset of DEVICE_PRESETS) {
      if (seen.at(-1) !== preset.group) seen.push(preset.group)
    }
    expect(seen).toEqual(['Apple', 'Android', 'Microsoft', 'reMarkable', 'Web', 'Mixed', 'Print (96dpi)'])
  })
})

describe('findMatchingPreset', () => {
  test('finds an exact match', () => {
    expect(findMatchingPreset(393, 852)).toEqual({
      group: 'Apple',
      name: 'iPhone 16',
      width: 393,
      height: 852,
    })
  })

  test('returns undefined for a custom size', () => {
    expect(findMatchingPreset(1024, 800)).toBeUndefined()
  })

  test('returns undefined when only one dimension matches', () => {
    expect(findMatchingPreset(393, 999)).toBeUndefined()
  })
})
