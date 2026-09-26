/**
 * Which functions the React Compiler skips, and why.
 *
 * The compiler never fails a build: a function it cannot lower is emitted
 * unchanged and reported only to a logger nobody reads. This compiles files
 * through `reactCompilerBabelOptions` — the exact transform Vite runs — and
 * returns each skipped function with the compiler's reason. Read by the
 * `react-compiler-bailouts` architecture gate and by
 * `bun run compiler:bailouts` (the inventory).
 */
import { readFileSync } from 'node:fs'
import { transformSync } from 'babel-core-7'
import { isReactCompilerInput, reactCompilerBabelOptions, type ReactCompilerEvent } from './reactCompilerPlugin'

export interface CompilerBailout {
  /** The function's name from its first line, or `<anonymous:LINE>`. */
  fn: string
  line: number
  reason: string
}

interface LoggedEvent extends ReactCompilerEvent {
  fnLoc?: { start: { line: number } } | null
}

const NAME_PATTERNS = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
  /^\s*([A-Za-z_$][\w$]*)\s*[(:=]/,
]

function functionName(sourceLine: string, line: number): string {
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(sourceLine)
    if (match?.[1]) return match[1]
  }
  return `<anonymous:${line}>`
}

/** Compile counts and bailouts for one file (`path` absolute or cwd-relative). */
export function compileReport(path: string): { compiled: number; bailouts: CompilerBailout[] } {
  const code = readFileSync(path, 'utf8')
  if (!isReactCompilerInput(path, code)) return { compiled: 0, bailouts: [] }
  const lines = code.split('\n')
  const bailouts: CompilerBailout[] = []
  let compiled = 0
  transformSync(
    code,
    reactCompilerBabelOptions(path, (event: LoggedEvent) => {
      if (event.kind === 'CompileSuccess') compiled++
      if (event.kind !== 'CompileError' && event.kind !== 'PipelineError') return
      const line = event.fnLoc?.start.line ?? 0
      bailouts.push({
        fn: event.fnName ?? functionName(lines[line - 1] ?? '', line),
        line,
        reason: event.detail?.options?.reason ?? event.detail?.reason ?? event.kind,
      })
    }),
  )
  return { compiled, bailouts }
}
