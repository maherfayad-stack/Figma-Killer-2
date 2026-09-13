/**
 * Generate the workspace-side studio-runtime Vite plugin artifact.
 *
 * `src/core/studio-runtime/vitePlugin.ts` (plus `idStamp.ts`/`runtimeConfig.ts`
 * it imports) is real, typed, lintable TypeScript inside Studio's own
 * source tree — but it has to run inside a USER'S workspace, which is a
 * completely separate npm project with its own `node_modules` that does not
 * (and must not be made to) depend on `@babel/core`. So, exactly like
 * `scripts/sync-plugin-bootstrap.ts` bundles the QuickJS VM bootstrap into a
 * committed string artifact the host evaluates, this script bundles the Vite
 * plugin entry (with `@babel/core`/`@babel/types` inlined) into ONE
 * self-contained ES module and commits it as a string constant. The prototype
 * shell generator (`server/handlers/studio/prototypeShell/`) writes that
 * string, verbatim, as `prototype/studioRuntime.generated.js` into every
 * workspace it scaffolds — an ALWAYS-rewritten generated file (like
 * `registry.generated.jsx`), so a fix to the plugin reaches every already-open
 * workspace on its next `ensurePrototypeShell` run, independent of whether the
 * workspace's own (hash-protected, "written once") `vite.config.js` still
 * matches the current template.
 *
 * Internal devs run `bun run studio-runtime:sync` after editing anything
 * under `src/core/studio-runtime/{idStamp,vitePlugin,runtimeConfig}.ts`. The
 * freshness gate is
 * `src/__tests__/architecture/studio-runtime-bundle-fresh.test.ts`, which
 * rebuilds in memory and fails loudly with "run `bun run studio-runtime:sync`"
 * if the committed artifact drifts from its source.
 *
 * Bundler determinism: same caveat as `sync-plugin-bootstrap.ts` — `Bun.build`
 * output is stable within a Bun minor but not guaranteed bit-identical across
 * minors (pinned by `engines.bun` in package.json). Regenerate on a deliberate
 * Bun-minor bump in the same change so the gate fails only on real source
 * drift.
 *
 * `define: { 'process.env.NODE_ENV': ... }` is load-bearing, not cosmetic:
 * without pinning it, `Bun.build` inlines the CALLING process's own
 * `process.env.NODE_ENV` as a literal wherever a bundled dependency
 * (browserslist, reached through `@babel/helper-compilation-targets`) reads
 * it — so running this script under `bun test` (`NODE_ENV=test`) produced a
 * BYTE-DIFFERENT artifact from running it directly (`NODE_ENV` unset), and the
 * freshness gate flapped between "fresh" and "stale" depending on who last
 * regenerated it. `env: 'disable'` alone does NOT stop this — that option
 * governs `Bun.env`/`import.meta.env`, not this dead-code-elimination-style
 * `process.env.NODE_ENV` substitution — so both are set: `define` pins the
 * value the bundler substitutes, `env: 'disable'` stops anything ELSE from
 * reading the calling process's environment into the artifact.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const ENTRY = join(ROOT, 'src/core/studio-runtime/vitePlugin.ts')
const GENERATED_DIR = join(ROOT, 'src/core/studio-runtime/generated')
const OUT_FILE = 'vitePluginBundle.ts'
const CONST_NAME = 'STUDIO_RUNTIME_VITE_PLUGIN_SOURCE'

/**
 * Bundles the plugin entry to a single ESM string, `@babel/core`/`@babel/types`
 * inlined. `target: 'node'` keeps Node's own builtins (`node:path`) external —
 * they are always present in the workspace's own Vite/Node process, unlike
 * every third-party import, which has to travel WITH this artifact.
 * Minification is OFF, matching `sync-plugin-bootstrap.ts`, so the committed
 * artifact stays diffable and the bundle stays deterministic across machines
 * on a given Bun.
 */
async function bundlePlugin(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    format: 'esm',
    target: 'node',
    minify: false,
    env: 'disable',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join('\n')
    throw new Error(`[sync-studio-runtime] bundling vitePlugin.ts failed:\n${messages}`)
  }
  if (result.outputs.length !== 1) {
    throw new Error(`[sync-studio-runtime] expected exactly one output, got ${result.outputs.length}`)
  }
  return await result.outputs[0].text()
}

function renderArtifactFile(bundled: string): string {
  return (
    `/**\n` +
    ` * GENERATED FILE — DO NOT EDIT.\n` +
    ` *\n` +
    ` * Bundled from src/core/studio-runtime/vitePlugin.ts by\n` +
    ` * scripts/sync-studio-runtime.ts. Regenerate with \`bun run studio-runtime:sync\`.\n` +
    ` * The freshness gate (studio-runtime-bundle-fresh.test.ts) fails if this drifts.\n` +
    ` */\n\n` +
    `export const ${CONST_NAME} = ${JSON.stringify(bundled)}\n`
  )
}

/** Built in memory, shared by the writer (sync mode) and the freshness gate so they can never disagree. */
export async function buildStudioRuntimeArtifact(): Promise<{ outFile: string; content: string }> {
  const bundled = await bundlePlugin()
  return { outFile: OUT_FILE, content: renderArtifactFile(bundled) }
}

async function main(): Promise<number> {
  const check = process.argv.slice(2).includes('--check')
  const built = await buildStudioRuntimeArtifact()

  if (check) {
    const path = join(GENERATED_DIR, built.outFile)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== built.content) {
      console.error(
        `[studio-runtime:check] generated/${built.outFile} is stale — run \`bun run studio-runtime:sync\` to regenerate.\n`,
      )
      return 1
    }
    console.error(`[studio-runtime:check] generated bundle is fresh.`)
    return 0
  }

  writeFileSync(join(GENERATED_DIR, built.outFile), built.content)
  console.error(`[sync-studio-runtime] wrote generated/${built.outFile}.`)
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
