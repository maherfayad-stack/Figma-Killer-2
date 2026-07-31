/**
 * styleCompileWorker — the Tier 1 subprocess entry point (`sec-01`). Spawned
 * by `styleCompile.ts` as `process.execPath <this file> <task-json>`, with
 * `cwd` = the WORKSPACE directory (never the Studio repo root) and `env` =
 * `subprocessRunner.ts`'s `minimalSubprocessEnv()` — no `STUDIO_SECRET_KEY`,
 * no `DATABASE_URL`, no AI provider key. This is the ONE place the whole
 * style-compile pipeline executes workspace code: the `sass`/`postcss`/
 * `@tailwindcss/postcss` package entries, `postcss.config.js`, and whatever
 * plugin packages that config names — confined to its own OS process,
 * holding none of the server's secrets.
 *
 * This is NOT a filesystem or network sandbox — Tier 1 is a documented
 * blast-radius boundary, not a security sandbox (`STUDIO-IMPORT-V2-PLAN.md`
 * §0). What the subprocess boundary buys: a hang or crash cannot take the
 * admin server down (the parent times out and kills it, see
 * `subprocessRunner.ts`), and this process never held a copy of the server's
 * secrets to begin with — there is nothing here to exfiltrate even if the
 * workspace's own config does something adversarial.
 *
 * Reads ONE JSON `WorkerTask` from `process.argv[2]`, writes ONE JSON
 * `WorkerResult` line to stdout, and exits 0 whether the compile succeeded or
 * failed per-file — a non-zero exit is reserved for "the task itself could
 * not be understood or crashed the process," which the parent treats as a
 * `*-compile-failed` warning, never a thrown error (`compileProjectStyles`'s
 * "never throws" contract, see its own doc comment).
 *
 * `runWorkerTask` is exported and unit-tested directly against real fixture
 * `node_modules/` packages (`styleCompileWorker.test.ts`) — no subprocess
 * involved in that path; `styleCompile.test.ts`'s own tests additionally
 * exercise this file as a REAL subprocess (no override passed to
 * `compileProjectStyles`), proving the `import.meta.main` wiring itself. The
 * `import.meta.main` block below is the only part that runs when this file
 * is actually executed as a subprocess.
 */
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCappedFile } from './styleCompileFileRead'
import { resolveWorkspacePackageEntry } from './workspacePackageResolve'

export interface SassTask {
  kind: 'sass'
  /** Pre-resolved, symlink-containment-checked by the parent — see `workspacePackageResolve.ts`. */
  sassEntryAbsPath: string
  /** Workspace-relative POSIX paths, resolved against `runWorkerTask`'s `cwd` (in the real subprocess, always `process.cwd()` — the spawn `cwd`, always the workspace dir). */
  files: string[]
}

export interface PostcssTask {
  kind: 'postcss'
  postcssEntryAbsPath: string
  entryRelPath: string
  /** Already-resolved plugin factory entries to `import()` and invoke with no options — the Tailwind v4 (`@tailwindcss/postcss`, no config file) case. */
  pluginEntryAbsPaths: string[]
  /** `postcss.config.js`'s real path, pre-verified by the parent to sit within the workspace — executed here to discover its `plugins` (array or named-map form). */
  postcssConfigAbsPath?: string
}

export type WorkerTask = SassTask | PostcssTask

export interface WorkerResult {
  css?: string
  errors: Array<{ relPath?: string; message: string }>
}

interface SassLikeModule {
  compileString?(source: string, options?: unknown): { css: string }
  default?: SassLikeModule
}

async function runSassTask(task: SassTask, cwd: string): Promise<WorkerResult> {
  const mod = (await import(pathToFileURL(task.sassEntryAbsPath).href)) as SassLikeModule
  const compileString = mod.compileString ?? mod.default?.compileString
  if (!compileString) return { errors: [{ message: "the workspace's sass package has no compileString export" }] }

  const errors: WorkerResult['errors'] = []
  const chunks: string[] = []
  for (const relPath of task.files) {
    const absPath = join(cwd, ...relPath.split('/'))
    const source = readCappedFile(absPath)
    if (source === undefined) continue
    try {
      const result = compileString(source, { loadPaths: [dirname(absPath), cwd] })
      chunks.push(`/* studio: sass ${relPath} */\n${result.css}`)
    } catch (err) {
      errors.push({ relPath, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { css: chunks.join('\n\n'), errors }
}

type PostcssResult = { css: string }
type PostcssProcessor = { process(css: string, opts?: unknown): Promise<PostcssResult> | PostcssResult }
type PostcssFactory = (plugins: unknown[]) => PostcssProcessor
type PluginFactoryLike = ((opts?: unknown) => unknown) | { default?: (opts?: unknown) => unknown }

/**
 * `postcss.config.*`'s `plugins`, in either shape real configs use: an array
 * of already-invoked plugin instances (`[require('tailwindcss')()]` — the
 * config's own `require`s resolve from ITS OWN location, i.e. the
 * workspace's `node_modules`, for free, by normal module resolution, exactly
 * as they would running natively), or an object map of package name ->
 * options (`{ tailwindcss: {}, autoprefixer: {} }`), where each named
 * package is resolved through `resolveWorkspacePackageEntry` — never a bare
 * `require(pkgName)`, which could otherwise reach outside the workspace.
 */
async function resolvePostcssPlugins(task: PostcssTask, cwd: string): Promise<{ plugins: unknown[]; errors: WorkerResult['errors'] }> {
  if (task.postcssConfigAbsPath) {
    try {
      const configMod = (await import(pathToFileURL(task.postcssConfigAbsPath).href)) as Record<string, unknown>
      const config = (configMod.default ?? configMod) as { plugins?: unknown } | undefined
      const pluginsValue = config?.plugins
      if (Array.isArray(pluginsValue)) return { plugins: pluginsValue, errors: [] }

      if (pluginsValue && typeof pluginsValue === 'object') {
        const plugins: unknown[] = []
        for (const [pkgName, options] of Object.entries(pluginsValue as Record<string, unknown>)) {
          if (!options) continue // `false`/`null` disables a plugin, same as real postcss-load-config
          const entry = resolveWorkspacePackageEntry(cwd, pkgName)
          if (!entry) continue
          const pluginMod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
          const candidate = (pluginMod.default ?? pluginMod) as PluginFactoryLike | undefined
          const factory = typeof candidate === 'function' ? candidate : undefined
          if (!factory) continue
          plugins.push(factory(typeof options === 'object' ? options : undefined))
        }
        return { plugins, errors: [] }
      }
      return { plugins: [], errors: [] }
    } catch (err) {
      return { plugins: [], errors: [{ message: `could not load postcss config: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }

  const plugins: unknown[] = []
  const errors: WorkerResult['errors'] = []
  for (const entryAbsPath of task.pluginEntryAbsPaths) {
    try {
      const mod = (await import(pathToFileURL(entryAbsPath).href)) as Record<string, unknown>
      const candidate = (mod.default ?? mod) as PluginFactoryLike | undefined
      const factory = typeof candidate === 'function' ? candidate : undefined
      if (factory) plugins.push(factory())
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { plugins, errors }
}

async function runPostcssTask(task: PostcssTask, cwd: string): Promise<WorkerResult> {
  const postcssMod = (await import(pathToFileURL(task.postcssEntryAbsPath).href)) as Record<string, unknown>
  const candidate = (postcssMod.default ?? postcssMod) as unknown
  const postcssFactory = typeof candidate === 'function' ? (candidate as PostcssFactory) : undefined
  if (!postcssFactory) return { errors: [{ message: "the workspace's postcss package has no callable default export" }] }

  const { plugins, errors } = await resolvePostcssPlugins(task, cwd)
  if (plugins.length === 0) {
    return { errors: errors.length > 0 ? errors : [{ message: "could not resolve any postcss plugins for this project's configuration" }] }
  }

  const entryAbsPath = join(cwd, ...task.entryRelPath.split('/'))
  const source = readCappedFile(entryAbsPath)
  if (source === undefined) return { errors: [...errors, { message: `could not read entry stylesheet ${task.entryRelPath}` }] }

  try {
    const processor = postcssFactory(plugins)
    const result = await processor.process(source, { from: entryAbsPath })
    return { css: `/* studio: postcss ${task.entryRelPath} */\n${result.css}`, errors }
  } catch (err) {
    return { errors: [...errors, { message: err instanceof Error ? err.message : String(err) }] }
  }
}

/** `cwd` defaults to `process.cwd()` (the real subprocess's spawn `cwd`, always the workspace dir) — overridable so tests can exercise this logic against a fixture dir without a real subprocess or a global `process.chdir()`. */
export async function runWorkerTask(task: WorkerTask, cwd: string = process.cwd()): Promise<WorkerResult> {
  try {
    return task.kind === 'sass' ? await runSassTask(task, cwd) : await runPostcssTask(task, cwd)
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] }
  }
}

function isWorkerTask(value: unknown): value is WorkerTask {
  return Boolean(value) && typeof value === 'object' && ((value as { kind?: unknown }).kind === 'sass' || (value as { kind?: unknown }).kind === 'postcss')
}

// Only runs when this file is executed directly (`bun styleCompileWorker.ts <task-json>`) — never when imported by the parent process or by tests.
if (import.meta.main) {
  void (async () => {
    try {
      const raw: unknown = JSON.parse(process.argv[2] ?? '')
      if (!isWorkerTask(raw)) {
        process.stdout.write(JSON.stringify({ errors: [{ message: 'invalid worker task' }] } satisfies WorkerResult))
        process.exit(1)
        return
      }
      const result = await runWorkerTask(raw)
      process.stdout.write(JSON.stringify(result))
      process.exit(0)
    } catch (err) {
      process.stdout.write(JSON.stringify({ errors: [{ message: err instanceof Error ? err.message : String(err) }] } satisfies WorkerResult))
      process.exit(1)
    }
  })()
}
