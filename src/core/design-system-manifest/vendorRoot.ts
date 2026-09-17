/**
 * Where the vendored design system lives, and how to read a file out of it.
 *
 * Studio used to resolve `@alm-design/design-system` out of `node_modules` and
 * read the package's own generated `mcp/catalog.js`. The package is gone: the
 * design system's SOURCE is now vendored at `vendor/alm-design-system/`, and
 * this module is the single place that knows that path. Everything downstream
 * — the component manifest, the colour-token extraction, the sync script —
 * asks here.
 *
 * Node/Bun only (it reads the filesystem). Nothing in the browser bundle
 * imports it; the browser consumes the COMMITTED artefacts this produces
 * (`src/modules/alm/manifest.generated.json`, `dist/index.css`,
 * `dist/tokens.generated.json`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Studio's repository root, derived from this file's own location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Absolute path of the vendored design-system package. */
export const VENDOR_DESIGN_SYSTEM_DIR = join(REPO_ROOT, 'vendor/alm-design-system')

/**
 * The import specifier a Studio module uses for the vendored package, and the
 * value recorded as `ComponentSpec.file` — there is no local file to point at,
 * so the bare specifier is the honest answer.
 */
export const VENDOR_DESIGN_SYSTEM_SPECIFIER = 'alm-design-system'

/** Read a file from the vendored package, relative to its root. Throws if absent. */
export function readVendorFile(relativePath: string): string {
  return readFileSync(join(VENDOR_DESIGN_SYSTEM_DIR, relativePath), 'utf8')
}

/** Read a file from the vendored package, or `null` when it does not exist. */
export function readVendorFileOrNull(relativePath: string): string | null {
  try {
    return readVendorFile(relativePath)
  } catch {
    // A missing optional input (a not-yet-built `dist/index.css`) costs one
    // recovery pass, not the whole manifest — see `buildDesignSystemManifest`.
    return null
  }
}
