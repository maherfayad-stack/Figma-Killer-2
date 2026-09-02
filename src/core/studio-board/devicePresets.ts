/**
 * devicePresets — device/canvas size presets for the studio design tab's
 * preset picker (Phase 6E). Ported **verbatim** (names + dimensions) from
 * Penpot's `size-presets` — `../penpot/frontend/src/app/main/constants.cljs`
 * — up through its "PRINT (96dpi)" group, so the picker matches a tool
 * designers already know. Pure data, no logic beyond the lookup helper below.
 *
 * Penpot's source models groups as header-only entries with no width/height
 * interleaved with device entries in one flat list; here each `DevicePreset`
 * instead carries its own `group` field, which is easier to consume from a
 * grouped `<Select>` (see `FrameSizePanel`) without re-deriving group
 * boundaries from list order.
 *
 * Penpot's list continues past Print into a "SOCIAL MEDIA" group (Instagram/
 * Facebook/LinkedIn/etc. post sizes) — intentionally not ported here; Phase
 * 6E's device-preset picker is scoped to screen/print form factors.
 */
export interface DevicePreset {
  group: string
  name: string
  width: number
  height: number
}

export const DEVICE_PRESETS: DevicePreset[] = [
  // ─── Apple ────────────────────────────────────────────────────────────
  { group: 'Apple', name: 'iPhone 16', width: 393, height: 852 },
  { group: 'Apple', name: 'iPhone 16 Pro', width: 402, height: 874 },
  { group: 'Apple', name: 'iPhone 16 Pro Max', width: 440, height: 956 },
  { group: 'Apple', name: 'iPhone 16 Plus', width: 430, height: 932 },
  { group: 'Apple', name: '14/15 Pro Max', width: 430, height: 932 },
  { group: 'Apple', name: 'iPhone 15/15 Pro', width: 393, height: 852 },
  { group: 'Apple', name: 'iPhone 13/14', width: 390, height: 844 },
  { group: 'Apple', name: 'iPhone 14 Plus', width: 428, height: 926 },
  { group: 'Apple', name: 'iPhone 13 Mini', width: 375, height: 812 },
  { group: 'Apple', name: 'iPhone SE', width: 320, height: 568 },
  { group: 'Apple', name: 'iPhone 12/12 Pro', width: 390, height: 844 },
  { group: 'Apple', name: 'iPhone 12 Mini', width: 360, height: 780 },
  { group: 'Apple', name: 'iPhone 12 Pro Max', width: 428, height: 926 },
  { group: 'Apple', name: 'iPhone X/XS/11 Pro', width: 375, height: 812 },
  { group: 'Apple', name: 'iPhone XS Max/XR/11', width: 414, height: 896 },
  { group: 'Apple', name: 'iPad', width: 768, height: 1024 },
  { group: 'Apple', name: 'iPad Mini 8.3in', width: 744, height: 1133 },
  { group: 'Apple', name: 'iPad Pro 10.5in', width: 834, height: 1112 },
  { group: 'Apple', name: 'iPad Pro 11in', width: 834, height: 1194 },
  { group: 'Apple', name: 'iPad Pro 12.9in', width: 1027, height: 1366 },
  { group: 'Apple', name: 'Watch Series 10', width: 416, height: 496 },
  { group: 'Apple', name: 'Watch 45mm', width: 396, height: 484 },
  { group: 'Apple', name: 'Watch 44mm', width: 368, height: 448 },
  { group: 'Apple', name: 'Watch 42mm', width: 312, height: 390 },
  { group: 'Apple', name: 'Watch 41mm', width: 352, height: 430 },
  { group: 'Apple', name: 'Watch 40mm', width: 324, height: 394 },
  { group: 'Apple', name: 'Watch 38mm', width: 272, height: 340 },
  { group: 'Apple', name: 'MacBook Air', width: 1280, height: 832 },
  { group: 'Apple', name: 'MacBook Pro 14in', width: 1512, height: 982 },
  { group: 'Apple', name: 'MacBook Pro 16in', width: 1728, height: 1117 },

  // ─── Android ──────────────────────────────────────────────────────────
  { group: 'Android', name: 'Expanded', width: 1280, height: 800 },
  { group: 'Android', name: 'Compact', width: 412, height: 917 },
  { group: 'Android', name: 'Large', width: 360, height: 800 },
  { group: 'Android', name: 'Medium', width: 700, height: 840 },
  { group: 'Android', name: 'Small', width: 360, height: 640 },
  { group: 'Android', name: 'Mobile', width: 360, height: 640 },
  { group: 'Android', name: 'Tablet', width: 768, height: 1024 },
  { group: 'Android', name: 'Google Pixel 7 Pro', width: 412, height: 892 },
  { group: 'Android', name: 'Google Pixel 6a/6', width: 412, height: 915 },
  { group: 'Android', name: 'Google Pixel 4a/5', width: 393, height: 851 },
  { group: 'Android', name: 'Samsung Galaxy S22', width: 360, height: 780 },
  { group: 'Android', name: 'Samsung Galaxy S20+', width: 384, height: 854 },
  { group: 'Android', name: 'Samsung Galaxy A71/A51', width: 412, height: 914 },

  // ─── Microsoft ────────────────────────────────────────────────────────
  { group: 'Microsoft', name: 'Surface Pro 3', width: 1440, height: 960 },
  { group: 'Microsoft', name: 'Surface Pro 4/5/6/7', width: 1368, height: 912 },
  { group: 'Microsoft', name: 'Surface Pro 8', width: 140, height: 960 },

  // ─── reMarkable ───────────────────────────────────────────────────────
  { group: 'reMarkable', name: 'Remarkable 2', width: 1404, height: 1872 },
  { group: 'reMarkable', name: 'Remarkable Pro', width: 1620, height: 2160 },

  // ─── Web ──────────────────────────────────────────────────────────────
  { group: 'Web', name: 'Web 1280', width: 1280, height: 800 },
  { group: 'Web', name: 'Web 1366', width: 1366, height: 768 },
  { group: 'Web', name: 'Web 1024', width: 1024, height: 768 },
  { group: 'Web', name: 'Web 1920', width: 1920, height: 1080 },

  // ─── Mixed ────────────────────────────────────────────────────────────
  { group: 'Mixed', name: 'Desktop/Wireframe', width: 1440, height: 1024 },
  { group: 'Mixed', name: 'TV', width: 1280, height: 720 },
  { group: 'Mixed', name: 'Slide 16:9', width: 1920, height: 1080 },
  { group: 'Mixed', name: 'Slide 4:3', width: 1027, height: 768 },

  // ─── Print (96dpi) ────────────────────────────────────────────────────
  { group: 'Print (96dpi)', name: 'A0', width: 3179, height: 4494 },
  { group: 'Print (96dpi)', name: 'A1', width: 2245, height: 3179 },
  { group: 'Print (96dpi)', name: 'A2', width: 1587, height: 2245 },
  { group: 'Print (96dpi)', name: 'A3', width: 1123, height: 1587 },
  { group: 'Print (96dpi)', name: 'A4', width: 794, height: 1123 },
  { group: 'Print (96dpi)', name: 'A5', width: 559, height: 794 },
  { group: 'Print (96dpi)', name: 'A6', width: 397, height: 559 },
  { group: 'Print (96dpi)', name: 'Letter', width: 816, height: 1054 },
  { group: 'Print (96dpi)', name: 'DIN Lang', width: 835, height: 413 },
]

/**
 * The preset matching an exact `width`×`height`, or `undefined` for a custom
 * size. Used by `FrameSizePanel` to show the preset's name when a frame's
 * saved size matches one exactly, "Custom" otherwise.
 */
export function findMatchingPreset(width: number, height: number): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.width === width && preset.height === height)
}
