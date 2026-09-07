/**
 * imageFillValue — the pure value model behind the Fill section's IMAGE
 * layers: how a project file becomes a CSS `url()`, and how the two Figma-ish
 * controls (Fit, and the 9-grid Position) map onto `background-size`,
 * `background-repeat` and `background-position`.
 *
 * WHICH URL GETS WRITTEN, AND WHY IT IS NOT ALWAYS SAFE
 * ----------------------------------------------------
 * The value Studio writes has to be one the USER'S build resolves — Studio's
 * own `/admin/api/studio/asset` endpoint is an admin-origin URL that would be
 * meaningless in their repo, and pasting it into their stylesheet would be
 * exactly the lying edit this codebase refuses.
 *
 * Only ONE form is unconditionally correct for a CSS `background-image`
 * across Vite, Next and CRA: a file under the project's public root
 * (`public/`, or Next's `static/` convention) referenced root-relatively.
 * That file is copied verbatim to the site root by every one of those
 * toolchains, so `url('/hero.png')` resolves in dev AND in a production
 * build, from an inline `style` attribute AND from a CSS file.
 *
 * Everything else is a caveat, not a guess. A file under `src/assets/` is
 * bundled through an `import` (see `studio-workspace/test4`'s
 * `import phoneImage from '../src/assets/EN-2.png'`) — a dev server will
 * happily serve `/src/assets/EN-2.png`, but a production build will not,
 * because the bundler never saw a reference to hash and emit it. So this
 * module still produces the root-relative URL (it is the only thing that can
 * work at all, and it does work in dev), and reports `buildSafe: false` so
 * the picker can SAY so next to the file instead of quietly shipping a
 * background that 404s after `npm run build`.
 *
 * That is why the upload tab defaults to the public root: an uploaded image
 * lands somewhere that is unconditionally correct.
 *
 * Consumed by `ImageSourcePicker.tsx` and `FillSectionParts.tsx`; the layer
 * stack itself (parse/serialise/refuse) stays in `backgroundLayers.ts`.
 */

/**
 * Directory names a toolchain copies to the site root verbatim, in the order
 * they are preferred when Studio has to CHOOSE one for an upload. `public` is
 * Vite's, Next's and CRA's default; `static` is the Gatsby/older-Next
 * spelling, recognised on read but never created.
 */
export const PUBLIC_ROOT_DIRS = ['public', 'static'] as const

/** Where an uploaded image fill lands, so its `url()` is correct in a production build too. */
export const IMAGE_FILL_UPLOAD_DIR = 'public'

export interface AssetCssUrl {
  /** The `url()` payload to write into the user's source. */
  url: string
  /**
   * True when the file sits under a public root, so the URL survives a
   * production build. False means "your dev server serves this, your build
   * probably will not" — the picker must show that, never hide it.
   */
  buildSafe: boolean
}

/** Turns a workspace-relative asset path into the URL the project's own build resolves. */
export function cssUrlForAssetPath(relPath: string): AssetCssUrl {
  const clean = relPath.replace(/^\/+/, '')
  for (const root of PUBLIC_ROOT_DIRS) {
    if (clean === root) break
    if (clean.startsWith(`${root}/`)) {
      return { url: `/${clean.slice(root.length + 1)}`, buildSafe: true }
    }
  }
  return { url: `/${clean}`, buildSafe: false }
}

/**
 * The workspace-relative file a written `url()` payload came from, resolved
 * against the project's KNOWN asset list rather than guessed at.
 *
 * A reverse mapping cannot be derived from the URL alone — `/hero.png` is
 * `public/hero.png` in one repo and `static/hero.png` in another — so this
 * asks the list instead. `undefined` means "not a file in this project"
 * (a remote URL, a data URI, or a path that no longer exists), which the
 * caller renders as-is rather than pretending it can preview it.
 */
export function assetPathForCssUrl(url: string, assets: readonly string[]): string | undefined {
  if (!url.startsWith('/')) return undefined
  const withoutLeadingSlash = url.slice(1)
  const candidates = [
    withoutLeadingSlash,
    ...PUBLIC_ROOT_DIRS.map((root) => `${root}/${withoutLeadingSlash}`),
  ]
  return candidates.find((candidate) => assets.includes(candidate))
}

/** The file name a row shows for a `url()` payload — the last path segment, query/hash stripped. */
export function imageFillFileName(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? ''
  const segment = withoutQuery.split('/').filter(Boolean).pop()
  return segment && segment.length > 0 ? decodeURIComponent(segment) : url
}

// ---------------------------------------------------------------------------
// Fit — `background-size` + `background-repeat` as one Figma-shaped choice
// ---------------------------------------------------------------------------

export type ImageFillFit = 'cover' | 'contain' | 'fill' | 'tile' | 'custom'

/**
 * The `background-size` / `background-repeat` pair each named fit writes.
 * `custom` has no entry — it is what the UI reports when the stored pair
 * matches none of these, and picking it is not an action.
 */
export const IMAGE_FILL_FIT_SATELLITES: Readonly<
  Record<Exclude<ImageFillFit, 'custom'>, { backgroundSize: string; backgroundRepeat: string }>
> = {
  cover: { backgroundSize: 'cover', backgroundRepeat: 'no-repeat' },
  contain: { backgroundSize: 'contain', backgroundRepeat: 'no-repeat' },
  fill: { backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' },
  // The CSS initial pair. A background image nobody has sized DOES tile, so
  // this is what an untouched layer honestly reads as — not "custom".
  tile: { backgroundSize: 'auto', backgroundRepeat: 'repeat' },
}

export const IMAGE_FILL_FIT_LABELS: Readonly<Record<ImageFillFit, string>> = {
  cover: 'Cover',
  contain: 'Contain',
  fill: 'Stretch',
  tile: 'Tile',
  custom: 'Custom',
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Which named fit a layer's stored pair is. An unset satellite is read as its
 * CSS initial, because that is what the browser is doing.
 */
export function fitFromSatellites(size: string, repeat: string): ImageFillFit {
  const normalizedSize = normalizeKeyword(size) || 'auto'
  const normalizedRepeat = normalizeKeyword(repeat) || 'repeat'
  for (const [fit, pair] of Object.entries(IMAGE_FILL_FIT_SATELLITES)) {
    if (pair.backgroundSize === normalizedSize && pair.backgroundRepeat === normalizedRepeat) {
      return fit as ImageFillFit
    }
  }
  return 'custom'
}

// ---------------------------------------------------------------------------
// Position — the 9-grid, as `background-position`
// ---------------------------------------------------------------------------

/** The nine cells, in reading order (row-major from top-left) — the order the grid renders. */
export const IMAGE_FILL_POSITION_CELLS = [
  { value: 'left top', label: 'Top left' },
  { value: 'center top', label: 'Top' },
  { value: 'right top', label: 'Top right' },
  { value: 'left center', label: 'Left' },
  { value: 'center center', label: 'Centre' },
  { value: 'right center', label: 'Right' },
  { value: 'left bottom', label: 'Bottom left' },
  { value: 'center bottom', label: 'Bottom' },
  { value: 'right bottom', label: 'Bottom right' },
] as const

/** Percentage spellings CSS treats as identical to a keyword — recognised so a hand-written `50% 50%` still lights up the centre cell. */
const AXIS_ALIASES: Readonly<Record<string, string>> = {
  '0%': 'start',
  '50%': 'center',
  '100%': 'end',
  left: 'start',
  top: 'start',
  center: 'center',
  right: 'end',
  bottom: 'end',
}

/**
 * The grid cell a stored `background-position` selects, or `undefined` when
 * it is something the grid cannot express (`12px 40%`, a 3/4-value form, an
 * edge-offset pair). `undefined` means the grid shows NO selection rather
 * than rounding the user's value to the nearest cell — silently moving a
 * hand-placed background is exactly the kind of edit this panel refuses.
 */
export function positionCellFor(value: string): string | undefined {
  const parts = normalizeKeyword(value).split(' ').filter(Boolean)
  if (parts.length === 0) return undefined
  // A single value sets the horizontal axis; the vertical defaults to centre.
  const [rawX, rawY] = parts.length === 1 ? [parts[0]!, 'center'] : parts
  if (parts.length > 2) return undefined

  const x = AXIS_ALIASES[rawX!]
  const y = AXIS_ALIASES[rawY!]
  if (x === undefined || y === undefined) return undefined

  const horizontal = x === 'start' ? 'left' : x === 'end' ? 'right' : 'center'
  const vertical = y === 'start' ? 'top' : y === 'end' ? 'bottom' : 'center'
  const candidate = `${horizontal} ${vertical}`
  return IMAGE_FILL_POSITION_CELLS.some((cell) => cell.value === candidate) ? candidate : undefined
}
