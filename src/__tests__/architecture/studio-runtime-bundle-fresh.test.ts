/**
 * Freshness gate for the generated studio-runtime Vite plugin artifact.
 *
 * `src/core/studio-runtime/vitePlugin.ts` (plus `idStamp.ts`/`runtimeConfig.ts`)
 * is authored as real TypeScript and bundled to a committed string artifact
 * (`generated/vitePluginBundle.ts`) by `scripts/sync-studio-runtime.ts`. A
 * workspace's shell writes that string, verbatim, as
 * `prototype/studioRuntime.generated.js` — so if the source changes but the
 * artifact is not regenerated, every already-scaffolded workspace keeps
 * running stale plugin code on its next open.
 *
 * This gate re-bundles the source in memory and asserts the committed
 * artifact matches byte-for-byte, exactly as `plugin-bootstrap-fresh.test.ts`
 * gates the QuickJS bootstrap. Run `bun run studio-runtime:sync` to refresh.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildStudioRuntimeArtifact } from '../../../scripts/sync-studio-runtime'

const GENERATED_DIR = resolve(import.meta.dir, '../../core/studio-runtime/generated')

describe('generated studio-runtime bundle', () => {
  it('matches a fresh bundle of vitePlugin.ts (run `bun run studio-runtime:sync` if this fails)', async () => {
    const built = await buildStudioRuntimeArtifact()
    const path = join(GENERATED_DIR, built.outFile)
    expect(existsSync(path), `missing generated/${built.outFile}`).toBe(true)
    const current = readFileSync(path, 'utf8')
    expect(
      current === built.content,
      `generated/${built.outFile} is stale — run \`bun run studio-runtime:sync\``,
    ).toBe(true)
  })
})
