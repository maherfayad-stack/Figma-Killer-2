/**
 * The React Compiler, run on the Babel it was built for.
 *
 * `babel-plugin-react-compiler` 1.0 is written against Babel 7: it bundles
 * `@babel/types` 7 but asks the HOST's `NodePath`s questions like
 * `path.isLVal()`. This repo's `@babel/core` is 8 (the studio runtime's
 * `idStamp` needs it), and Babel 8 dropped `AssignmentPattern` and
 * `RestElement` from the `LVal` alias — so under `@rolldown/plugin-babel`
 * (which imports the root `@babel/core`) the compiler rejected every default
 * inside a destructured parameter (`{ editable = true }`) and silently emitted
 * the whole function uncompiled. That was 329 of the 439 bailouts in `src/`,
 * `NodeRenderer`'s callers, `Button` and `Tooltip` among them (P6-C's finding;
 * no compiler release, experimental included, supports Babel 8).
 *
 * So the compiler gets its own Babel 7 (`babel-core-7`, an npm alias of
 * `@babel/core@7`), and this plugin replaces `@rolldown/plugin-babel` with the
 * same file selection that plugin + `reactCompilerPreset()` applied: client
 * environment only, `.[jt]sx?`/`.[cm][jt]s` ids outside `node_modules`,
 * source that mentions a capitalised name or `use`, source maps on.
 *
 * `reactCompilerBabelOptions` is the single definition of the transform; the
 * `react-compiler-bailouts` gate compiles files through it so it measures
 * exactly what Vite ships.
 */
import { transformAsync, type TransformOptions } from 'babel-core-7'
import type { Plugin } from 'vite'

/** `reactCompilerPreset()`'s code filter: only source that could hold a component or hook. */
const CODE_FILTER = /\b[A-Z]|\buse/
/** `@rolldown/plugin-babel`'s default id filter. */
const ID_INCLUDE = /\.(?:[jt]sx?|[cm][jt]s)(?:$|\?)/
const ID_EXCLUDE = /[/\\]node_modules[/\\]|^\0rolldown\/runtime\.js$/

/** One compiler log event (`babel-plugin-react-compiler`'s `Logger.logEvent`). */
export interface ReactCompilerEvent {
  kind: string
  fnName?: string | null
  detail?: { options?: { reason?: string }; reason?: string }
}

function parserPluginsFor(filename: string): ('typescript' | 'jsx')[] {
  if (/\.tsx(?:$|\?)/.test(filename)) return ['typescript', 'jsx']
  if (/\.ts(?:$|\?)/.test(filename)) return ['typescript']
  if (/\.jsx(?:$|\?)/.test(filename)) return ['jsx']
  return []
}

/**
 * The Babel options Vite compiles `filename` with. `onEvent` subscribes to the
 * compiler's log (every `CompileSuccess` / `CompileError` / … per function).
 */
export function reactCompilerBabelOptions(
  filename: string,
  onEvent?: (event: ReactCompilerEvent) => void,
): TransformOptions {
  return {
    filename,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    parserOpts: { sourceType: 'module', allowAwaitOutsideFunction: true, plugins: parserPluginsFor(filename) },
    plugins: [
      ['babel-plugin-react-compiler', onEvent ? { logger: { logEvent: (_file: string, event: ReactCompilerEvent) => onEvent(event) } } : {}],
    ],
  }
}

/** Whether Vite hands `code` at `id` to the compiler at all. */
export function isReactCompilerInput(id: string, code: string): boolean {
  return ID_INCLUDE.test(id) && !ID_EXCLUDE.test(id) && CODE_FILTER.test(code)
}

export function reactCompiler(): Plugin {
  return {
    name: 'studio:react-compiler',
    enforce: 'pre',
    config: () => ({ optimizeDeps: { include: ['react/compiler-runtime'] } }),
    applyToEnvironment: (environment) => environment.config.consumer === 'client',
    transform: {
      filter: { id: { include: ID_INCLUDE, exclude: ID_EXCLUDE }, code: CODE_FILTER },
      async handler(code, id) {
        const result = await transformAsync(code, reactCompilerBabelOptions(id))
        if (!result) return undefined
        return { code: result.code ?? undefined, map: result.map }
      },
    },
  }
}
