// Generates a static manifest JSON for the browser (the catalog extraction is
// Node-only — fs + the package's mcp/catalog.js — so it can't run in the SPA).
// Run:  bun scripts/gen-alm-manifest.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDesignSystemManifest } from '../src/core/design-system-manifest/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = await buildDesignSystemManifest()
const out = join(root, 'src/modules/alm/manifest.generated.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`Wrote ${manifest.components.length} components -> ${out}`)
