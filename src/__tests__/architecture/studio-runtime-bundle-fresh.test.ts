/**
 * Freshness gate for the generated studio-runtime artifacts.
 *
 * `src/core/studio-runtime/vitePlugin.ts` (plus `idStamp.ts`/`runtimeConfig.ts`)
 * and `src/core/studio-runtime/runtime.ts` (plus `messages.ts` and the rule
 * modules it imports) are authored as real TypeScript and bundled to
 * committed string artifacts (`generated/vitePluginBundle.ts`,
 * `generated/runtimeBridgeBundle.ts`) by `scripts/sync-studio-runtime.ts`. A
 * workspace's shell writes each string, verbatim, as
 * `prototype/studioRuntime.generated.js` / `prototype/studioRuntimeBridge.generated.js`
 * — so if either source changes but its artifact is not regenerated, every
 * already-scaffolded workspace keeps running stale code on its next open.
 *
 * This gate re-bundles both sources in memory and asserts each committed
 * artifact matches byte-for-byte, exactly as `plugin-bootstrap-fresh.test.ts`
 * gates the QuickJS bootstrap. Run `bun run studio-runtime:sync` to refresh.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildStudioRuntimeArtifact } from '../../../scripts/sync-studio-runtime'

const GENERATED_DIR = resolve(import.meta.dir, '../../core/studio-runtime/generated')

describe('generated studio-runtime bundles', () => {
  it('match a fresh bundle of vitePlugin.ts and runtime.ts (run `bun run studio-runtime:sync` if this fails)', async () => {
    const built = await buildStudioRuntimeArtifact()
    expect(built.length).toBe(2)
    for (const artifact of built) {
      const path = join(GENERATED_DIR, artifact.outFile)
      expect(existsSync(path), `missing generated/${artifact.outFile}`).toBe(true)
      const current = readFileSync(path, 'utf8')
      expect(
        current === artifact.content,
        `generated/${artifact.outFile} is stale — run \`bun run studio-runtime:sync\``,
      ).toBe(true)
    }
  })
})
