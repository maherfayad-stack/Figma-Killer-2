/**
 * Sync the vendored ALM design system.
 *
 * Studio no longer depends on `@alm-design/design-system` from npm. The design
 * system's SOURCE is vendored at `vendor/alm-design-system/` — that folder is
 * now the source of truth — and this script produces the three artefacts the
 * editor actually consumes, all of them committed:
 *
 *   1. `vendor/alm-design-system/dist/index.js` + `dist/index.css` — a Vite lib
 *      build of `src/index.js`. The admin bundle imports `dist/`, never `src/`,
 *      for the same reason the npm shipped a bundle: `src/` is 40 components
 *      that each `import './X.css'` as a side effect and ~20 that `import
 *      '…/x.svg?raw'`. Through `dist/` none of that reaches the admin
 *      document's cascade or its module graph.
 *   2. `vendor/alm-design-system/dist/tokens.generated.json` — the colour
 *      palette as data (`extractColorTokens`).
 *   3. `src/modules/alm/manifest.generated.json` — the component manifest
 *      (`buildDesignSystemManifest`): prop truth for the Properties panel,
 *      description / keywords / group for the Assets panel. This absorbs the
 *      deleted `scripts/gen-alm-manifest.mjs`.
 *
 * `dist/BUILD_HASH` records a SHA-256 over every file under `src/`, so the
 * freshness gate (`alm-design-system-fresh.test.ts`) can tell whether `dist/`
 * matches its inputs without paying for a full Vite build inside `bun test`.
 *
 * Run `bun run alm:sync` after editing anything under
 * `vendor/alm-design-system/`. `bun run alm:check` reports drift without
 * writing.
 *
 * Vite, not `Bun.build`: the vendored components use Vite's `?raw` import
 * suffix and rely on CSS being collected and extracted, neither of which
 * `Bun.build` does.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import {
  buildDesignSystemManifest,
  extractColorTokens,
  VENDOR_DESIGN_SYSTEM_DIR,
} from '../src/core/design-system-manifest/index.ts'

const ROOT = resolve(import.meta.dir, '..')
const VENDOR_SRC_DIR = join(VENDOR_DESIGN_SYSTEM_DIR, 'src')
export const VENDOR_DIST_DIR = join(VENDOR_DESIGN_SYSTEM_DIR, 'dist')

export const BUILD_HASH_FILE = join(VENDOR_DIST_DIR, 'BUILD_HASH')
export const TOKENS_FILE = join(VENDOR_DIST_DIR, 'tokens.generated.json')
export const MANIFEST_FILE = join(ROOT, 'src/modules/alm/manifest.generated.json')

// ---------------------------------------------------------------------------
// Input hash
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/**
 * SHA-256 over every file under `vendor/alm-design-system/src/`, keyed by
 * relative path so a rename counts as a change. This is what `dist/` is built
 * from, and nothing else — `studio/*.json` and the markdown docs feed the
 * manifest and the tokens JSON, which the gate regenerates byte-for-byte
 * instead.
 */
export function computeLibInputHash(): string {
  const hash = createHash('sha256')
  for (const file of walk(VENDOR_SRC_DIR)) {
    hash.update(relative(VENDOR_DESIGN_SYSTEM_DIR, file).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Artefacts
// ---------------------------------------------------------------------------

/** `dist/tokens.generated.json`'s exact contents. */
export function renderTokensJson(): string {
  return `${JSON.stringify(extractColorTokens(), null, 2)}\n`
}

/** `src/modules/alm/manifest.generated.json`'s exact contents. */
export function renderManifestJson(): string {
  return `${JSON.stringify(buildDesignSystemManifest(), null, 2)}\n`
}

/**
 * Lib-build `src/index.js` into `dist/index.js` + `dist/index.css`.
 *
 * Deterministic on purpose, because the freshness gate compares builds: no
 * content hashes in file names, no sourcemaps. React is external — the host
 * app supplies it. `assetsInlineLimit` is deliberately enormous so the
 * Footer's brand PNGs/SVGs become data URIs and `dist/` stays exactly two
 * files, which is what the npm shipped and what `canvasVendorCss.ts` assumes.
 *
 * The JS is NOT minified and the CSS IS, which is not an inconsistency:
 * `dist/index.js` is re-bundled and minified by Studio's own build, so leaving
 * it readable costs nothing and makes a committed artefact diffable;
 * `dist/index.css` is injected VERBATIM into every canvas iframe as a string
 * (`?inline`), so its size is paid per frame.
 */
export async function buildLibArtifacts(): Promise<void> {
  await build({
    configFile: false,
    root: VENDOR_DESIGN_SYSTEM_DIR,
    logLevel: 'warn',
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      minify: false,
      cssMinify: true,
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: 1024 * 1024,
      lib: {
        entry: join(VENDOR_SRC_DIR, 'index.js'),
        formats: ['es'],
        fileName: () => 'index.js',
        cssFileName: 'index',
      },
      rolldownOptions: {
        // Rolldown writes each module's id into a `//#region` comment, and it
        // resolves that id against its OWN cwd rather than Vite's `root`. Left
        // at the process cwd, running this script from anywhere but the repo
        // root would rewrite every comment in `dist/index.js` and show up as a
        // spurious diff. Pin it to the vendored package.
        cwd: VENDOR_DESIGN_SYSTEM_DIR,
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        output: { assetFileNames: 'index.[ext]' },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface DriftReport {
  path: string
  reason: string
}

async function run(check: boolean): Promise<void> {
  const drift: DriftReport[] = []

  if (check) {
    const expectedHash = computeLibInputHash()
    const actualHash = existsSync(BUILD_HASH_FILE) ? readFileSync(BUILD_HASH_FILE, 'utf8').trim() : ''
    if (expectedHash !== actualHash) drift.push({ path: 'dist/', reason: 'source changed since the last build' })
  } else {
    await buildLibArtifacts()
    writeFileSync(BUILD_HASH_FILE, `${computeLibInputHash()}\n`)
  }

  for (const [path, content] of [
    [TOKENS_FILE, renderTokensJson()],
    [MANIFEST_FILE, renderManifestJson()],
  ] as const) {
    if (!check) {
      writeFileSync(path, content)
      continue
    }
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== content) drift.push({ path: relative(ROOT, path), reason: 'stale' })
  }

  if (check && drift.length > 0) {
    for (const item of drift) console.error(`[alm:sync] ${item.path} — ${item.reason}`)
    console.error('[alm:sync] run `bun run alm:sync`')
    process.exit(1)
  }

  if (!check) {
    const manifest = buildDesignSystemManifest()
    console.info(
      `[alm:sync] built dist/, ${extractColorTokens().length} colour tokens, ${manifest.components.length} components`,
    )
  }
}

if (import.meta.main) {
  await run(process.argv.includes('--check'))
}
