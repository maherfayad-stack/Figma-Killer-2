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
 *
 * **Not every mismatch is source drift.** `Bun.build` output is stable
 * within one Bun version, not across versions: the runtime helpers it
 * prepends (`__toESM`, `__export`, …) change between minors, and the
 * `// node_modules/...` comment above each inlined dependency is written
 * relative to the build's working directory. So a local Bun that
 * differs from the one the artifact was built with fails this gate with no
 * source change at all. The failure message therefore names the running Bun
 * and shows the first differing line, so the reader can tell "I changed
 * `runtime.ts` and forgot to sync" from "my Bun is not the pinned one" —
 * and does not regenerate a correct artifact on the wrong Bun.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readCommittedArtefact } from '../../../scripts/lib/generatedArtefact'
import { buildStudioRuntimeArtifact } from '../../../scripts/sync-studio-runtime'

const GENERATED_DIR = resolve(import.meta.dir, '../../core/studio-runtime/generated')

/** The bundle text inside the artifact's single string constant, split into the bundle's own lines (the constant stores them as `\n` escapes). */
function bundleLines(artifact: string): string[] {
  const match = /^export const \w+ = (".*")$/m.exec(artifact)
  if (!match) return artifact.split('\n')
  return (JSON.parse(match[1]!) as string).split('\n')
}

const BUN_HELPER = /__toESM|__toCommonJS|__export|__commonJS|__accessProp|__returnValue|__exportSetter|__defProp|__create/
const DEPENDENCY_PATH_COMMENT = /^\/\/ (?:\.\.\/)*node_modules\//

/** Why a stale artifact is stale, in words a reader can act on — see this file's doc for the two causes that are not source drift. */
function describeDrift(outFile: string, committed: string, fresh: string): string {
  const committedLines = bundleLines(committed)
  const freshLines = bundleLines(fresh)
  let line = 0
  while (line < committedLines.length && line < freshLines.length && committedLines[line] === freshLines[line]) line += 1
  const committedLine = committedLines[line] ?? '<end of bundle>'
  const freshLine = freshLines[line] ?? '<end of bundle>'
  const bunCaused = BUN_HELPER.test(committedLine) || BUN_HELPER.test(freshLine)
  const layoutCaused = DEPENDENCY_PATH_COMMENT.test(committedLine) && DEPENDENCY_PATH_COMMENT.test(freshLine)
  const cause = bunCaused
    ? `The first difference is in Bun's own bundler runtime helpers, not in Studio code: the committed artifact was built by a different Bun than this one (${Bun.version}). Do NOT regenerate it on this Bun. Run the gate on the Bun CI pins (.github/workflows/ci.yml, \`bun-version\`); if it still fails there, regenerate on that Bun.`
    : layoutCaused
      ? `The first difference is a \`// node_modules/...\` path comment. Bun writes those relative to the working directory of the build, so an artifact generated from a checkout whose node_modules resolved from elsewhere (a worktree borrowing its parent's) differs with no source change. Regenerate from the repo root of a checkout with its own node_modules, on the Bun CI pins.`
      : `The first difference is in bundled code. If you changed src/core/studio-runtime/, run \`bun run studio-runtime:sync\` (on the Bun CI pins, .github/workflows/ci.yml) and commit generated/${outFile}.`
  return [
    `generated/${outFile} does not match a fresh bundle built by Bun ${Bun.version}.`,
    `First difference at bundle line ${line + 1}:`,
    `  committed: ${committedLine.slice(0, 160)}`,
    `  fresh:     ${freshLine.slice(0, 160)}`,
    cause,
  ].join('\n')
}

describe('generated studio-runtime bundles', () => {
  it('match a fresh bundle of vitePlugin.ts and runtime.ts (run `bun run studio-runtime:sync` if this fails)', async () => {
    const built = await buildStudioRuntimeArtifact()
    expect(built.length).toBe(2)
    for (const artifact of built) {
      const path = join(GENERATED_DIR, artifact.outFile)
      expect(existsSync(path), `missing generated/${artifact.outFile} — run \`bun run studio-runtime:sync\``).toBe(true)
      // EOL-normalised, not weakened: see `readCommittedArtefact`'s own note.
      const current = readCommittedArtefact(path)
      const fresh = current === artifact.content
      expect(fresh, fresh ? '' : describeDrift(artifact.outFile, current, artifact.content)).toBe(true)
    }
  })
})
