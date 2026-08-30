/**
 * platformPresets.test.ts — the mobile/web answer a new project is created
 * with, and the frame size it turns into.
 *
 * The numbers are pinned deliberately: they are what the create dialog
 * promises and what every screen in the project then opens at, so a silent
 * change to either is a silent change to every project made afterwards.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PROJECT_PLATFORM,
  DEVICE_PRESETS,
  PLATFORM_PRESETS,
  findMatchingPreset,
  frameDefaultsForPlatform,
  platformPreset,
} from '../index'

describe('platform presets', () => {
  test('mobile screens start at 393 x 852', () => {
    expect(frameDefaultsForPlatform('mobile')).toEqual({ width: 393, height: 852 })
  })

  test('web screens start at 1440 x 1024', () => {
    expect(frameDefaultsForPlatform('web')).toEqual({ width: 1440, height: 1024 })
  })

  test('every platform has exactly one preset', () => {
    expect(PLATFORM_PRESETS).toHaveLength(2)
    expect(PLATFORM_PRESETS.map((p) => p.platform).sort()).toEqual(['mobile', 'web'])
    expect(platformPreset(DEFAULT_PROJECT_PLATFORM)).toBeDefined()
  })

  test('both sizes are real device presets, so a new frame reads as a named size rather than "Custom"', () => {
    // `FrameSizePanel` labels a frame by `findMatchingPreset`; a platform size
    // that matched nothing there would show every fresh frame as "Custom".
    for (const preset of PLATFORM_PRESETS) {
      expect(findMatchingPreset(preset.width, preset.height)).toBeDefined()
    }
    expect(DEVICE_PRESETS.length).toBeGreaterThan(0)
  })

  test('a preset describes its device without repeating its size — the UI renders the size separately', () => {
    for (const preset of PLATFORM_PRESETS) {
      expect(preset.description).not.toContain(String(preset.width))
    }
  })
})
