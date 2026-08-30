/**
 * platformPresets — the two form factors a new Studio project is created for,
 * and the frame size each one starts every screen at.
 *
 * A project is a repository of screens, and screens in one repository are
 * overwhelmingly the same shape: a mobile app's screens are all phone-width, a
 * web app's are all desktop-width. Asking once at creation and recording the
 * answer is what lets every page added later — from the board, from the "New
 * page" button, or by the agent through `POST /admin/api/studio/page` — land at
 * the right width without the author resizing each frame by hand.
 *
 * The answer is persisted as `.studio/meta.json`'s `frameDefaults` (the
 * project-wide frame size that already existed for WS-7.2's "apply to all
 * pages") plus `platform` (the ANSWER itself, so the UI can show which one was
 * chosen and the agent can read the intent rather than reverse-engineer it
 * from a width). Both are plain overridable defaults: resizing a frame, or
 * running "apply to all pages", still wins — nothing here locks a size.
 *
 * Lives in `@core/studio-board` next to `frameGrid.ts` for exactly the reason
 * that file gives: the server's create/scaffold routes and the client's
 * dashboard both need these numbers, and neither layer may import the other's.
 *
 * The sizes are the two `DEVICE_PRESETS` entries these form factors map to, so
 * a new frame's size shows as a named preset in `FrameSizePanel` rather than
 * "Custom": iPhone 16 / 15 / 15 Pro (393×852) and Desktop/Wireframe
 * (1440×1024) — the same two defaults Figma opens its Design file presets on.
 */

/** The form factor a project's screens are designed for. Recorded per project in `.studio/meta.json`. */
export type ProjectPlatform = 'mobile' | 'web'

export interface PlatformPreset {
  platform: ProjectPlatform
  /** Shown on the create-project chooser. */
  label: string
  /** The device the size is taken from, shown under the label. The SIZE itself is rendered separately from `width`/`height` — never duplicate it here. */
  description: string
  width: number
  height: number
}

export const PLATFORM_PRESETS: readonly PlatformPreset[] = [
  {
    platform: 'mobile',
    label: 'Mobile',
    description: 'iPhone 16 / 15 / 15 Pro',
    width: 393,
    height: 852,
  },
  {
    platform: 'web',
    label: 'Web',
    description: 'Desktop / wireframe',
    width: 1440,
    height: 1024,
  },
] as const

/** The default form factor when a caller does not choose one (the API's `platform` is optional, and every pre-existing project has no `platform` recorded). */
export const DEFAULT_PROJECT_PLATFORM: ProjectPlatform = 'mobile'

/** The preset for `platform`. Total — every `ProjectPlatform` has exactly one entry. */
export function platformPreset(platform: ProjectPlatform): PlatformPreset {
  const preset = PLATFORM_PRESETS.find((p) => p.platform === platform)
  // Unreachable for a well-typed caller; `PLATFORM_PRESETS` covers the union.
  if (!preset) throw new Error(`[platformPresets] no preset for platform "${platform}"`)
  return preset
}

/** The `frameDefaults` a project created for `platform` starts with — the exact shape `.studio/meta.json` persists and `boardSlice`'s `addFrame` reads back. */
export function frameDefaultsForPlatform(platform: ProjectPlatform): { width: number; height: number } {
  const { width, height } = platformPreset(platform)
  return { width, height }
}
