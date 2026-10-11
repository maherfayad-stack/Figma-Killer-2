/**
 * imageFillValue — the pure value model behind the Fill section's IMAGE
 * layers: the file name a layer row shows, and how the two Figma-ish controls
 * (Fit, and the 9-grid Position) map onto `background-size`,
 * `background-repeat` and `background-position`.
 *
 * WHICH URL GETS WRITTEN IS NOT DECIDED HERE
 * ------------------------------------------
 * The `url()` payload Studio writes has to be one the USER'S build resolves,
 * and that is a fact about their project (its app root, its `public/`), not
 * something a browser can derive from a path string. The server decides it
 * in one place, `server/handlers/studio/assetSiteUrl.ts`, and every source of
 * an image fill carries the answer:
 *
 *   - an uploaded file lands through `asset-drop` (`dropStudioAsset`), which
 *     puts it in the app's `public/` and returns its `src`;
 *   - a listed project image (`project-assets`) carries `src` and a
 *     `buildSafe` verdict, which the picker shows as "dev only";
 *   - a pasted URL is written as typed.
 *
 * IMG-1 deleted the client copy of that rule (`cssUrlForAssetPath` /
 * `PUBLIC_ROOT_DIRS` / `IMAGE_FILL_UPLOAD_DIR`): it was blind to a monorepo's
 * app root, so an upload landed in the wrong `public/`.
 *
 * Consumed by `ImageSourcePicker.tsx` and `FillSectionParts.tsx`; the layer
 * stack itself (parse/serialise/refuse) stays in `backgroundLayers.ts`.
 */

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
