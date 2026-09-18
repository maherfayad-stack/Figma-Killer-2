/**
 * Freshness gate for the vendored design system's committed artefacts.
 *
 * `vendor/alm-design-system/src/` is the source of truth; `dist/index.js`,
 * `dist/index.css`, `dist/tokens.generated.json` and
 * `src/modules/alm/manifest.generated.json` are generated from it by
 * `bun run alm:sync` and committed. If the source changes and the artefacts
 * are not regenerated, the canvas renders one version of the design system and
 * the Properties panel inspects another — the same failure mode
 * `plugin-bootstrap-fresh.test.ts` and `vendor-icons-fresh.test.ts` exist to
 * prevent.
 *
 * TWO different checks, on purpose:
 *
 *  - `tokens.generated.json` and `manifest.generated.json` are regenerated here
 *    and compared BYTE-FOR-BYTE. Both are pure file reads plus string parsing —
 *    a few hundred milliseconds — so there is no reason to accept a weaker
 *    signal.
 *  - `dist/index.js` / `dist/index.css` are compared through
 *    `dist/BUILD_HASH`, a SHA-256 over every file under `src/`. A real Vite lib
 *    build of 40 components takes ~10 s, which does not belong in `bun test`;
 *    the hash catches exactly the thing that matters (a source edit that was
 *    never rebuilt) without paying for it. `bun run alm:check` runs the same
 *    comparison from the command line.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCommittedArtefact } from '../../../scripts/lib/generatedArtefact'
import {
  BUILD_HASH_FILE,
  VENDOR_DIST_DIR,
  MANIFEST_FILE,
  TOKENS_FILE,
  computeLibInputHash,
  renderManifestJson,
  renderTokensJson,
} from '../../../scripts/sync-alm-design-system'

const STALE = 'stale — run `bun run alm:sync`'

describe('vendored design-system artefacts', () => {
  it('dist/ was built from the current vendor/alm-design-system/src/', () => {
    expect(existsSync(BUILD_HASH_FILE), 'missing dist/BUILD_HASH').toBe(true)
    const recorded = readCommittedArtefact(BUILD_HASH_FILE).trim()
    expect(recorded, `dist/BUILD_HASH is ${STALE}`).toBe(computeLibInputHash())
  })

  it('dist/index.js and dist/index.css are committed', () => {
    for (const file of ['index.js', 'index.css']) {
      const path = join(VENDOR_DIST_DIR, file)
      expect(existsSync(path), `missing dist/${file}`).toBe(true)
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0)
    }
  })

  it('dist/tokens.generated.json matches a fresh extraction', () => {
    expect(existsSync(TOKENS_FILE), 'missing dist/tokens.generated.json').toBe(true)
    // EOL-normalised, not weakened: see `readCommittedArtefact`'s own note.
    expect(readCommittedArtefact(TOKENS_FILE) === renderTokensJson(), `tokens.generated.json is ${STALE}`).toBe(true)
  })

  it('src/modules/alm/manifest.generated.json matches a fresh build', () => {
    expect(existsSync(MANIFEST_FILE), 'missing manifest.generated.json').toBe(true)
    // EOL-normalised, not weakened: see `readCommittedArtefact`'s own note.
    expect(readCommittedArtefact(MANIFEST_FILE) === renderManifestJson(), `manifest.generated.json is ${STALE}`).toBe(true)
  })
})
