/**
 * Generate the workspace-side studio-runtime artifacts: the Vite plugin, and
 * the in-frame runtime bridge.
 *
 * `src/core/studio-runtime/vitePlugin.ts` (plus `idStamp.ts`/`runtimeConfig.ts`
 * it imports) is real, typed, lintable TypeScript inside Studio's own
 * source tree — but it has to run inside a USER'S workspace, which is a
 * completely separate npm project with its own `node_modules` that does not
 * (and must not be made to) depend on `@babel/core`. `src/core/studio-runtime/
 * runtime.ts` (`createStudioRuntimeBridge`, + `messages.ts` and the rule
 * modules it imports) has the same problem in miniature: it depends on
 * `@sinclair/typebox`, which is not installed in a user's workspace either.
 * So, exactly like `scripts/sync-plugin-bootstrap.ts` bundles the QuickJS VM
 * bootstrap into a committed string artifact the host evaluates, this script
 * bundles BOTH entries (with their dependencies inlined) into self-contained
 * ES modules and commits each as a string constant. The prototype shell
 * generator (`server/handlers/studio/prototypeShell/`) writes each string,
 * verbatim, into every workspace it scaffolds as an ALWAYS-rewritten
 * generated file (like `registry.generated.jsx`), so a fix reaches every
 * already-open workspace on its next `ensurePrototypeShell` run, independent
 * of whether the workspace's own (hash-protected, "written once")
 * `vite.config.js`/`main.jsx` still match the current template.
 *
 * Internal devs run `bun run studio-runtime:sync` after editing anything
 * under `src/core/studio-runtime/{idStamp,vitePlugin,runtimeConfig,runtime,
 * messages,hoverSuppressionRules,scrollUnrollRules,animationFreezeRules,
 * selectionChromeCss,hmrState,nodeIdIndexing,frameFitRules,
 * overlayStyleAttr}.ts`. The freshness gate is
 * `src/__tests__/architecture/studio-runtime-bundle-fresh.test.ts`, which
 * rebuilds both in memory and fails loudly with "run `bun run
 * studio-runtime:sync`" if either committed artifact drifts from its source.
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
 * (browserslist, reached through `@babel/helper-compilation-targets`, for the
 * plugin bundle) reads it — so running this script under `bun test`
 * (`NODE_ENV=test`) produced a BYTE-DIFFERENT artifact from running it
 * directly (`NODE_ENV` unset), and the freshness gate flapped between "fresh"
 * and "stale" depending on who last regenerated it. `env: 'disable'` alone
 * does NOT stop this — that option governs `Bun.env`/`import.meta.env`, not
 * this dead-code-elimination-style `process.env.NODE_ENV` substitution — so
 * both are set on every bundle: `define` pins the value the bundler
 * substitutes, `env: 'disable'` stops anything ELSE from reading the calling
 * process's environment into the artifact.
 */
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readCommittedArtefact } from './lib/generatedArtefact'

const ROOT = resolve(import.meta.dir, '..')
const GENERATED_DIR = join(ROOT, 'src/core/studio-runtime/generated')

const PLUGIN_ENTRY = join(ROOT, 'src/core/studio-runtime/vitePlugin.ts')
const PLUGIN_OUT_FILE = 'vitePluginBundle.ts'
const PLUGIN_CONST_NAME = 'STUDIO_RUNTIME_VITE_PLUGIN_SOURCE'

const BRIDGE_ENTRY = join(ROOT, 'src/core/studio-runtime/runtime.ts')
const BRIDGE_OUT_FILE = 'runtimeBridgeBundle.ts'
const BRIDGE_CONST_NAME = 'STUDIO_RUNTIME_BRIDGE_SOURCE'

interface BundleSpec {
  entry: string
  outFile: string
  constName: string
  sourceLabel: string
}

const SPECS: readonly BundleSpec[] = [
  { entry: PLUGIN_ENTRY, outFile: PLUGIN_OUT_FILE, constName: PLUGIN_CONST_NAME, sourceLabel: 'src/core/studio-runtime/vitePlugin.ts' },
  { entry: BRIDGE_ENTRY, outFile: BRIDGE_OUT_FILE, constName: BRIDGE_CONST_NAME, sourceLabel: 'src/core/studio-runtime/runtime.ts' },
]

/**
 * Bundles the Vite plugin entry to a single ESM string, `@babel/core`/
 * `@babel/types` inlined. `target: 'node'` keeps Node's own builtins
 * (`node:path`) external — they are always present in the workspace's own
 * Vite/Node process, unlike every third-party import, which has to travel
 * WITH this artifact.
 */
async function bundlePlugin(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [PLUGIN_ENTRY],
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

/**
 * Bundles the in-frame runtime bridge entry to a single ESM string,
 * `@sinclair/typebox` inlined. `target: 'browser'` — unlike `vitePlugin.ts`,
 * this runs IN THE LIVE FRAME, not the Vite/Node process, so there are no
 * Node builtins to keep external at all.
 */
async function bundleRuntimeBridge(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [BRIDGE_ENTRY],
    format: 'esm',
    target: 'browser',
    minify: false,
    env: 'disable',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  if (!result.success) {
    const messages = result.logs.map((l) => String(l)).join('\n')
    throw new Error(`[sync-studio-runtime] bundling runtime.ts failed:\n${messages}`)
  }
  if (result.outputs.length !== 1) {
    throw new Error(`[sync-studio-runtime] expected exactly one output, got ${result.outputs.length}`)
  }
  return await result.outputs[0].text()
}

/**
 * Both bundling functions share one output shape (source text -> committed
 * string constant) — this renders whichever one a given spec asks for.
 * Minification is OFF for both, matching `sync-plugin-bootstrap.ts`, so the
 * committed artifacts stay diffable and deterministic across machines on a
 * given Bun.
 */
function renderArtifactFile(spec: BundleSpec, bundled: string): string {
  return (
    `/**\n` +
    ` * GENERATED FILE — DO NOT EDIT.\n` +
    ` *\n` +
    ` * Bundled from ${spec.sourceLabel} by\n` +
    ` * scripts/sync-studio-runtime.ts. Regenerate with \`bun run studio-runtime:sync\`.\n` +
    ` * The freshness gate (studio-runtime-bundle-fresh.test.ts) fails if this drifts.\n` +
    ` */\n\n` +
    `export const ${spec.constName} = ${JSON.stringify(bundled)}\n`
  )
}

async function buildBundle(spec: BundleSpec): Promise<string> {
  return spec.entry === PLUGIN_ENTRY ? bundlePlugin() : bundleRuntimeBridge()
}

/** Built in memory, shared by the writer (sync mode) and the freshness gate so they can never disagree. One entry per artifact. */
export async function buildStudioRuntimeArtifact(): Promise<Array<{ outFile: string; content: string }>> {
  const built = []
  for (const spec of SPECS) {
    const bundled = await buildBundle(spec)
    built.push({ outFile: spec.outFile, content: renderArtifactFile(spec, bundled) })
  }
  return built
}

async function main(): Promise<number> {
  const check = process.argv.slice(2).includes('--check')
  const artifacts = await buildStudioRuntimeArtifact()

  if (check) {
    let stale = false
    for (const built of artifacts) {
      const path = join(GENERATED_DIR, built.outFile)
      if (readCommittedArtefact(path) !== built.content) {
        console.error(
          `[studio-runtime:check] generated/${built.outFile} is stale — run \`bun run studio-runtime:sync\` to regenerate.\n`,
        )
        stale = true
      }
    }
    if (stale) return 1
    console.error(`[studio-runtime:check] generated bundles are fresh.`)
    return 0
  }

  for (const built of artifacts) {
    writeFileSync(join(GENERATED_DIR, built.outFile), built.content)
    console.error(`[sync-studio-runtime] wrote generated/${built.outFile}.`)
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
